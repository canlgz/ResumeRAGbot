/** Text-only ingestion. Images, linked files, headers and footnotes are not indexed. */
function readPublicSource_(cfg) {
  requireValue_(cfg.docId, 'RESUME_DOC_ID');
  var doc = DocumentApp.openById(cfg.docId);
  var allTabs = [];
  function walk(tabs) {
    tabs.forEach(function (tab) { allTabs.push(tab); walk(tab.getChildTabs()); });
  }
  walk(doc.getTabs());
  var selected = allTabs.filter(function (tab) {
    return cfg.tabIds.indexOf('*') >= 0 || cfg.tabIds.indexOf(tab.getId()) >= 0;
  });
  if (!selected.length) throw new Error('DOC_TAB_NOT_FOUND');
  if (cfg.tabIds.indexOf('*') < 0 && cfg.tabIds.some(function (id) {
    return !selected.some(function (tab) { return tab.getId() === id; });
  })) throw new Error('DOC_TAB_NOT_FOUND');
  var chunks = [];
  selected.forEach(function (tab) {
    var body = tab.asDocumentTab().getBody();
    var lines = [];
    for (var i = 0; i < body.getNumChildren(); i++) {
      var child = body.getChild(i);
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
        var paragraph = child.asParagraph();
        var heading = String(paragraph.getHeading());
        var text = paragraph.getText();
        // Preserve native headings; markers themselves must remain plain text.
        lines.push(/^(HEADING|TITLE)/.test(heading) && text.indexOf('[[') !== 0 ? '## ' + text : text);
      } else if (typeof child.getText === 'function') {
        lines.push(child.getText());
      }
    }
    var publicText = extractPublic_(lines.join('\n'));
    chunks = chunks.concat(chunkText_(publicText).map(function (chunk) {
      return { section: chunk.section, text: chunk.text, tabId: tab.getId() };
    }));
  });
  if (chunks.length > 100) throw new Error('SOURCE_TOO_LARGE');
  var size = chunks.reduce(function (sum, c) { return sum + c.text.length; }, 0);
  if (size > 60000) throw new Error('SOURCE_TOO_LARGE');
  var fingerprint = sha256_(JSON.stringify({ doc: cfg.docId, tabs: cfg.tabIds,
    model: cfg.embeddingModel, dimensions: cfg.dimensions, embeddingConfigVersion: 2, chunks: chunks }));
  return { chunks: chunks, fingerprint: fingerprint, documentUrl: doc.getUrl() };
}

function extractPublic_(input) {
  var inside = false, privateBlock = false, feedbackBlock = false, output = [];
  String(input).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
    var marker = line.trim();
    // Pending questions are visitor input, never resume facts, even if moved inside PUBLIC.
    if (marker === '[[UNANSWERED_QUESTIONS]]') {
      if (feedbackBlock) throw new Error('INVALID_FEEDBACK_MARKERS');
      feedbackBlock = true; return;
    }
    if (marker === '[[/UNANSWERED_QUESTIONS]]') {
      if (!feedbackBlock) throw new Error('INVALID_FEEDBACK_MARKERS');
      feedbackBlock = false; return;
    }
    if (feedbackBlock) return;
    if (marker === '[[PUBLIC]]') {
      if (inside || privateBlock) throw new Error('INVALID_PUBLIC_MARKERS');
      inside = true; return;
    }
    if (marker === '[[/PUBLIC]]') {
      if (!inside || privateBlock) throw new Error('INVALID_PUBLIC_MARKERS');
      inside = false; output.push(''); return;
    }
    if (marker === '[[PRIVATE]]') {
      if (privateBlock) throw new Error('INVALID_PRIVATE_MARKERS');
      privateBlock = true; return;
    }
    if (marker === '[[/PRIVATE]]') {
      if (!privateBlock) throw new Error('INVALID_PRIVATE_MARKERS');
      privateBlock = false; return;
    }
    if (inside && !privateBlock) {
      // An unfilled template line must never become a claimed resume fact.
      if (/\[待填[^\]]*\]|\[選填[^\]]*\]/.test(line)) return;
      output.push(line);
    }
  });
  if (inside || privateBlock || feedbackBlock) throw new Error('UNCLOSED_MARKERS');
  return output.join('\n').trim();
}

function chunkText_(text) {
  var section = '個人履歷', paragraphs = [], result = [];
  function flush() {
    var content = paragraphs.join('\n').trim();
    paragraphs = [];
    if (!content) return;
    // Code point slicing prevents broken surrogate pairs in emoji / names.
    var chars = Array.from(content);
    for (var start = 0; start < chars.length; start += 620) {
      var slice = chars.slice(start, start + 700).join('');
      if (slice.trim()) result.push({ section: section.slice(0, 100), text: slice });
      if (start + 700 >= chars.length) break;
    }
  }
  String(text).split('\n').forEach(function (line) {
    var match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) { flush(); section = match[1].trim(); }
    else paragraphs.push(line);
  });
  flush();
  return result;
}

/** Run manually once, then via the optional hourly trigger. */
function syncKnowledgeBase() {
  requireOwner_();
  return syncKnowledgeBase_();
}

// Private trailing-underscore handler is not callable via google.script.run.
function syncKnowledgeBase_() {
  var cfg = config_(), props = PropertiesService.getScriptProperties();
  requireValue_(cfg.geminiKey, 'GEMINI_API_KEY');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var lease = Number(props.getProperty('SYNC_LEASE') || 0);
    if (lease > Date.now()) return { status: 'already_running' };
    props.setProperty('SYNC_LEASE', String(Date.now() + 7 * 60 * 1000));
  } finally { lock.releaseLock(); }
  var newFile = null;
  try {
    var source = readPublicSource_(cfg);
    var current = props.getProperty('INDEX_FILE_ID');
    if (current && props.getProperty('INDEX_FINGERPRINT') === source.fingerprint) {
      // Check storage exists; a missing/deleted file must trigger rebuilding.
      try {
        var existing = loadIndex_(cfg);
        if (existing && existing.fingerprint === source.fingerprint) {
          props.setProperty('LAST_SYNC_STATUS', 'UNCHANGED');
          return { status: 'unchanged', chunks: existing.chunks.length };
        }
      } catch (_) { /* Rebuild a missing/corrupt index. */ }
    }
    // Stop serving previous content before any external embedding operation.
    clearIndex_();
    if (!source.chunks.length) throw new Error('NO_PUBLIC_CONTENT');
    for (var start = 0; start < source.chunks.length; start += 10) {
      var batch = source.chunks.slice(start, start + 10);
      var vectors = embedDocuments_(batch, cfg);
      batch.forEach(function (chunk, i) {
        chunk.id = 'S' + (start + i + 1);
        chunk.vector = normalizeVector_(vectors[i], cfg.dimensions);
      });
    }
    // The document may have changed while embeddings were being built.
    if (readPublicSource_(cfg).fingerprint !== source.fingerprint) throw new Error('SOURCE_CHANGED_DURING_SYNC');
    var index = { version: 1, docId: cfg.docId, embeddingModel: cfg.embeddingModel,
      dimensions: cfg.dimensions, fingerprint: source.fingerprint,
      builtAt: new Date().toISOString(), chunks: source.chunks };
    newFile = DriveApp.createFile('LINE 履歷 RAG 索引.json', JSON.stringify(index), 'application/json');
    props.setProperties({ INDEX_FILE_ID: newFile.getId(), INDEX_FINGERPRINT: source.fingerprint,
      LAST_SYNC_STATUS: 'OK', LAST_SYNC_AT: index.builtAt });
    safeLog_('SYNC_OK');
    return { status: 'ok', chunks: index.chunks.length, updatedAt: index.builtAt };
  } catch (error) {
    // No stale resume answers after deletion, malformed markers or permission failure.
    clearIndex_();
    if (newFile) { try { newFile.setTrashed(true); } catch (_) {} }
    props.setProperty('LAST_SYNC_STATUS', errorCode_(error));
    safeLog_(errorCode_(error));
    throw new Error(errorCode_(error));
  } finally { props.deleteProperty('SYNC_LEASE'); }
}

function clearIndex_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INDEX_FILE_ID');
  props.deleteProperty('INDEX_FILE_ID');
  props.deleteProperty('INDEX_FINGERPRINT');
  // Only delete the generated index file, never the source Google Doc.
  if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (_) { safeLog_('OLD_INDEX_CLEANUP_FAILED'); } }
}

function loadIndex_(cfg) {
  var id = PropertiesService.getScriptProperties().getProperty('INDEX_FILE_ID');
  if (!id) return null;
  var file = DriveApp.getFileById(id);
  if (file.isTrashed()) throw new Error('INDEX_MISSING');
  var index = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  if (index.version !== 1 || index.docId !== cfg.docId || index.embeddingModel !== cfg.embeddingModel ||
      index.dimensions !== cfg.dimensions || !Array.isArray(index.chunks)) throw new Error('INDEX_MISMATCH');
  return index;
}

function normalizeVector_(vector, dimensions) {
  if (!Array.isArray(vector)) throw new Error('INVALID_EMBEDDING_MISSING');
  // Only counts are reported: never log vectors, source text, API responses or keys.
  if (vector.length !== dimensions) throw new Error('INVALID_EMBEDDING_DIMENSIONS_' + vector.length + '_EXPECTED_' + dimensions);
  if (vector.some(function (n) { return typeof n !== 'number' || !Number.isFinite(n); })) throw new Error('INVALID_EMBEDDING_VALUES');
  var norm = Math.sqrt(vector.reduce(function (sum, n) { return sum + n * n; }, 0));
  if (!norm || !Number.isFinite(norm)) throw new Error('INVALID_EMBEDDING_NORM');
  return vector.map(function (n) { return n / norm; });
}

function lexicalTokens_(text) {
  var lower = String(text).toLowerCase(), tokens = lower.match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
  (lower.match(/[\u3400-\u9fff]+/g) || []).forEach(function (run) {
    if (run.length === 1) tokens.push(run);
    for (var i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  });
  return Array.from(new Set(tokens));
}

function rankChunks_(query, vector, chunks, cfg) {
  var tokens = lexicalTokens_(query);
  return chunks.map(function (chunk) {
    if (!Array.isArray(chunk.vector) || chunk.vector.length !== vector.length) throw new Error('INDEX_MISMATCH');
    var semantic = chunk.vector.reduce(function (sum, n, i) { return sum + n * vector[i]; }, 0);
    var text = (chunk.section + '\n' + chunk.text).toLowerCase();
    var lexical = tokens.length ? tokens.filter(function (t) { return text.indexOf(t) >= 0; }).length / tokens.length : 0;
    return { id: chunk.id, section: chunk.section, text: chunk.text,
      similarity: semantic, score: semantic * 0.82 + lexical * 0.18 };
  }).filter(function (hit) { return hit.similarity >= cfg.minSimilarity; })
    .sort(function (a, b) { return b.score - a.score; }).slice(0, cfg.topK);
}
