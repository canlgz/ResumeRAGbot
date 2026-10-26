/**
 * 【RAG 知識庫：公開範圍 → 切段 → 圖片辨識 → 向量 → 主題選單 → 私有索引】
 * Google 文件是主人編輯的原始資料；Drive 索引是供搜尋使用的衍生資料。
 * 來源指紋 fingerprint 代表目前公開內容與處理規則；不同時就停止引用舊答案。
 */

/**
 * 讀取選定分頁的公開正文及圖片雜湊，再計算來源指紋。
 * 先完整驗證標記，再讀圖片；校對文字也納入指紋，避免查到舊結果。
 */
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
  var chunks = [], images = {}, imageCount = 0;
  selected.forEach(function (tab) {
    var body = tab.asDocumentTab().getBody();
    var documentText = documentSourceText_(body);
    // 先確認所有公開／私人標記合法，再讀取圖片或呼叫外部 API。
    var publicText = extractPublic_(documentText.text);
    var section = '個人履歷', buffer = [];
    function flushText() {
      chunks = chunks.concat(chunkText_(buffer.join('\n')).map(function (chunk) {
        return { section: chunk.section, text: chunk.text, tabId: tab.getId() };
      }));
      buffer = ['## ' + section];
    }
    publicText.split('\n').forEach(function (line) {
      var image = Object.prototype.hasOwnProperty.call(documentText.images, line) ? documentText.images[line] : null;
      if (image) {
        flushText();
        if (image.unsupported) throw new Error('IMAGE_DRAWING_UNSUPPORTED');
        var info = readSourceImage_(image, cfg);
        if (!Object.prototype.hasOwnProperty.call(images, info.key)) images[info.key] = info;
        imageCount++;
        var label = Array.from(section).slice(0, 70).join('') + '｜圖片 ' + imageCount + '（圖片辨識）';
        chunks.push({ section: label, text: '', tabId: tab.getId(), imageKey: info.key });
      } else {
        var heading = line.match(/^#{1,6}\s+(.+)$/);
        if (heading) section = heading[1].trim();
        buffer.push(line);
      }
    });
    flushText();
  });
  checkSourceSize_(chunks);
  var imageCorrections = selectedImageCorrections_(images, cfg);
  var fingerprintData = { doc: cfg.docId, tabs: cfg.tabIds,
    model: cfg.embeddingModel, dimensions: cfg.dimensions, embeddingConfigVersion: 2,
    ingestionVersion: 3, chunks: chunks };
  // 沒有主人校正時，維持舊版相容指紋，避免無謂重建。
  var correctionKeys = Object.keys(imageCorrections).sort();
  if (correctionKeys.length) fingerprintData.imageCorrections = correctionKeys.map(function (key) {
    return { digest: key, transcription: imageCorrections[key].transcription,
      visualDescription: imageCorrections[key].visualDescription };
  });
  var fingerprint = sha256_(JSON.stringify(fingerprintData));
  return { chunks: chunks, images: images, imageCount: imageCount,
    imageCorrections: imageCorrections, fingerprint: fingerprint, documentUrl: doc.getUrl() };
}

/**
 * 限制可處理的來源大小；超過時請主人精簡，不悄悄截斷履歷。
 */
function checkSourceSize_(chunks) {
  if (chunks.length > 100 || chunks.reduce(function (sum, c) { return sum + c.text.length; }, 0) > 60000) {
    throw new Error('SOURCE_TOO_LARGE');
  }
}

/**
 * 依 PUBLIC、PRIVATE 與待補充區標記決定公開範圍。
 * 格式不成對就停止；未填的範例欄位與訪客待補充問題不進入知識庫。
 */
function extractPublic_(input) {
  var inside = false, privateBlock = false, feedbackBlock = false, output = [];
  String(input).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
    var marker = line.trim();
    // 待補充問題屬於訪客輸入，即使被移到 PUBLIC 中也不能當成履歷事實。
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
      // 未填的範例欄位整行略過，避免把占位文字當成真實經歷。
      if (/\[待填[^\]]*\]|\[選填[^\]]*\]/.test(line)) return;
      output.push(line);
    }
  });
  if (inside || privateBlock || feedbackBlock) throw new Error('UNCLOSED_MARKERS');
  return output.join('\n').trim();
}

/**
 * 依自然標題分段，長段落保留部分重疊，以免切斷前後文。
 * 使用 Unicode 字元切片，避免把 Emoji 等字元切壞。
 */
function chunkText_(text) {
  var section = '個人履歷', paragraphs = [], result = [];
  function flush() {
    var content = paragraphs.join('\n').trim();
    paragraphs = [];
    if (!content) return;
    // 以完整 Unicode 字元切片，避免切壞姓名或 Emoji。
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

/**
 * 【手動同步入口】由主人執行；排程及校對頁共用底下的同步流程。
 */
function syncKnowledgeBase() {
  requireOwner_();
  var result = syncKnowledgeBase_();
  console.log(JSON.stringify(result));
  return result;
}

// 函式名稱以底線結尾，瀏覽器不能透過 google.script.run 直接呼叫。
/**
 * 同步主流程：檢查版本 → 取得同步租約 → 讀來源 → 沿用或重建索引。
 * 相同內容只在缺少新版選單時補建分類；真正改內容時才辨識與向量化。
 * 來源改動或重建失敗時停用舊答案，避免刪除的資訊繼續被搜尋。
 */
function syncKnowledgeBase_() {
  var cfg = config_(), props = PropertiesService.getScriptProperties();
  requireValue_(cfg.geminiKey, 'GEMINI_API_KEY');
  // 步驟 1：先核對版本；不一致時保留索引，不能先清除再報錯。
  var deployment = requireMatchingDeployment_();
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var lease = Number(props.getProperty('SYNC_LEASE') || 0);
    if (lease > Date.now()) return { status: 'already_running' };
    props.setProperty('SYNC_LEASE', String(Date.now() + 7 * 60 * 1000));
  } finally { lock.releaseLock(); }
  var newFile = null, preserveTopicUpgrade = false;
  try {
    var source = readPublicSource_(cfg);
    reconcilePortfolioAssets_(source, cfg);
    var current = props.getProperty('INDEX_FILE_ID'), existing = null;
    try { existing = loadIndex_(cfg); } catch (_) { /* 索引遺失或損壞時重建。 */ }
    if (current && props.getProperty('INDEX_FINGERPRINT') === source.fingerprint) {
      // 步驟 2：相同內容可沿用，但必須確認實際索引檔還存在。
      if (existing && existing.fingerprint === source.fingerprint) {
          if (!existing.quickTopics || existing.quickTopics.version !== 2 || existing.quickTopics.sourceFingerprint !== source.fingerprint) {
            // 只補選單時，即使分類 API 失敗，也保留原本相容且可用的索引。
            preserveTopicUpgrade = true;
            var topics = buildQuickTopics_(existing.chunks, cfg, source.fingerprint);
            if (readPublicSource_(cfg).fingerprint !== source.fingerprint) throw new Error('SOURCE_CHANGED_DURING_SYNC');
            existing.quickTopics = topics;
            DriveApp.getFileById(current).setContent(JSON.stringify(existing));
            preserveTopicUpgrade = false;
          }
          props.setProperty('LAST_SYNC_STATUS', 'UNCHANGED');
          return { status: 'unchanged', version: appVersion_(), deploymentCheck: deployment.status,
            chunks: existing.chunks.length, images: source.imageCount };
      }
    }
    // 步驟 3：來源真的有變，先停用舊資料，再開始圖片辨識與向量建立。
    clearIndex_();
    if (!source.chunks.length) throw new Error('NO_PUBLIC_CONTENT');
    var hydrated = hydrateSourceImages_(source, existing, cfg), chunks = hydrated.chunks;
    if (!chunks.length) throw new Error('NO_SEARCHABLE_CONTENT');
    checkSourceSize_(chunks);
    for (var start = 0; start < chunks.length; start += 10) {
      var batch = chunks.slice(start, start + 10);
      var vectors = embedDocuments_(batch, cfg);
      batch.forEach(function (chunk, i) {
        chunk.id = 'S' + (start + i + 1);
        chunk.vector = normalizeVector_(vectors[i], cfg.dimensions);
      });
    }
    var quickTopics = buildQuickTopics_(chunks, cfg, source.fingerprint);
    // 步驟 4：模型處理需要時間，保存前再次核對文件有沒有被修改。
    if (readPublicSource_(cfg).fingerprint !== source.fingerprint) throw new Error('SOURCE_CHANGED_DURING_SYNC');
    var index = { version: 2, docId: cfg.docId, embeddingModel: cfg.embeddingModel,
      builtWithAppVersion: appVersion_(),
      dimensions: cfg.dimensions, fingerprint: source.fingerprint,
      builtAt: new Date().toISOString(), chunks: chunks,
      imageTexts: hydrated.imageTexts, imageReviewedTexts: hydrated.imageReviewedTexts, imageSources: hydrated.imageSources, quickTopics: quickTopics };
    newFile = DriveApp.createFile('LINE 履歷 RAG 索引.json', JSON.stringify(index), 'application/json');
    props.setProperties({ INDEX_FILE_ID: newFile.getId(), INDEX_FINGERPRINT: source.fingerprint,
      LAST_SYNC_STATUS: 'OK', LAST_SYNC_AT: index.builtAt });
    safeLog_('SYNC_OK');
    return { status: 'ok', version: appVersion_(), deploymentCheck: deployment.status,
      chunks: index.chunks.length, images: source.imageCount, updatedAt: index.builtAt };
  } catch (error) {
    // 來源刪改、標記錯誤或權限失敗時，不讓舊答案繼續被使用。
    var keep = false;
    if (preserveTopicUpgrade) {
      try { keep = props.getProperty('INDEX_FILE_ID') === current && readPublicSource_(cfg).fingerprint === source.fingerprint; } catch (_) {}
    }
    if (!keep) clearIndex_();
    if (newFile) { try { newFile.setTrashed(true); } catch (_) {} }
    props.setProperty('LAST_SYNC_STATUS', errorCode_(error));
    safeLog_(errorCode_(error));
    throw new Error(errorCode_(error));
  } finally { props.deleteProperty('SYNC_LEASE'); }
}

/**
 * 只清除程式產生的索引及其指標，絕不刪除原 Google 文件。
 */
function clearIndex_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INDEX_FILE_ID');
  props.deleteProperty('INDEX_FILE_ID');
  props.deleteProperty('INDEX_FINGERPRINT');
  // 這裡只刪除衍生索引，絕不刪除原履歷。
  if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (_) { safeLog_('OLD_INDEX_CLEANUP_FAILED'); } }
}

/**
 * 讀取私有 Drive 索引，確認文件、向量模型與維度仍相容。
 */
function loadIndex_(cfg) {
  var id = PropertiesService.getScriptProperties().getProperty('INDEX_FILE_ID');
  if (!id) return null;
  var file = DriveApp.getFileById(id);
  if (file.isTrashed()) throw new Error('INDEX_MISSING');
  var index = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  if ([1, 2].indexOf(index.version) < 0 || index.docId !== cfg.docId || index.embeddingModel !== cfg.embeddingModel ||
      index.dimensions !== cfg.dimensions || !Array.isArray(index.chunks)) throw new Error('INDEX_MISMATCH');
  return index;
}

/**
 * 驗證向量維度與數值，轉為單位向量供相似度比較。
 * 維度錯誤須回報，不能直接截短成另一個不相容的向量。
 */
function normalizeVector_(vector, dimensions) {
  if (!Array.isArray(vector)) throw new Error('INVALID_EMBEDDING_MISSING');
  // 錯誤只回報維度數量，不印出向量、原文、API 回應或金鑰。
  if (vector.length !== dimensions) throw new Error('INVALID_EMBEDDING_DIMENSIONS_' + vector.length + '_EXPECTED_' + dimensions);
  if (vector.some(function (n) { return typeof n !== 'number' || !Number.isFinite(n); })) throw new Error('INVALID_EMBEDDING_VALUES');
  var norm = Math.sqrt(vector.reduce(function (sum, n) { return sum + n * n; }, 0));
  if (!norm || !Number.isFinite(norm)) throw new Error('INVALID_EMBEDDING_NORM');
  return vector.map(function (n) { return n / norm; });
}

/**
 * 將英文詞與中文雙字詞轉成關鍵詞，補強專案名稱等精確搜尋。
 */
function lexicalTokens_(text) {
  var lower = String(text).toLowerCase(), tokens = lower.match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
  (lower.match(/[\u3400-\u9fff]+/g) || []).forEach(function (run) {
    if (run.length === 1) tokens.push(run);
    for (var i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  });
  return Array.from(new Set(tokens));
}

/**
 * 結合向量相似度與關鍵詞分數，取最相關的少量片段給模型。
 */
function rankChunks_(query, vector, chunks, cfg) {
  var tokens = lexicalTokens_(query);
  return chunks.map(function (chunk) {
    if (!Array.isArray(chunk.vector) || chunk.vector.length !== vector.length) throw new Error('INDEX_MISMATCH');
    var semantic = chunk.vector.reduce(function (sum, n, i) { return sum + n * vector[i]; }, 0);
    var text = (chunk.section + '\n' + chunk.text).toLowerCase();
    var lexical = tokens.length ? tokens.filter(function (t) { return text.indexOf(t) >= 0; }).length / tokens.length : 0;
    return { id: chunk.id, section: chunk.section, text: chunk.text,
      imageKey: chunk.imageKey || null, tabId: chunk.tabId,
      similarity: semantic, score: semantic * 0.82 + lexical * 0.18 };
  }).filter(function (hit) { return hit.similarity >= cfg.minSimilarity; })
    .sort(function (a, b) { return b.score - a.score; }).slice(0, cfg.topK);
}
