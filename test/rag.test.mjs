import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, unitVector } from './harness.mjs';

const source = '私人住址：不應傳送\n[[PUBLIC]]\n## 專案作品\n建立資料分析報表，將處理時間縮短 20%。\n[[PRIVATE]]\n內部客戶名單不可公開\n[[/PRIVATE]]\n## 聯絡方式\n公開信箱：demo@example.test\n[[/PUBLIC]]';

test('only explicit public sections enter retrieval; template blanks and private material are omitted', () => {
  const { gas } = createGas({ text: source });
  const data = gas.readPublicSource_(gas.config_());
  assert.equal(data.chunks.length, 2);
  assert(!JSON.stringify(data).includes('私人住址'));
  assert(!JSON.stringify(data).includes('內部客戶'));
  assert.equal(gas.extractPublic_('ordinary private text'), '');
  assert.equal(gas.extractPublic_('[[PUBLIC]]\n姓名：[待填姓名]\n[[/PUBLIC]]'), '');
  for (const invalid of ['[[PUBLIC]]\nsecret', '[[/PUBLIC]]', '[[PUBLIC]]\n[[PUBLIC]]', '[[PRIVATE]]\nsecret']) {
    assert.throws(() => gas.extractPublic_(invalid));
  }
});

test('chunks preserve heading context, long Chinese text and Unicode boundaries', () => {
  const { gas } = createGas();
  const content = '🙂專案'.repeat(350);
  const chunks = gas.chunkText_('## 作品\n' + content + '\n## 學歷\n測試大學');
  assert(chunks.length >= 3);
  assert.equal(chunks.at(-1).section, '學歷');
  for (const chunk of chunks) {
    assert(Array.from(chunk.text).length <= 700);
    assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text));
  }
});

test('selected and nested Docs tabs are handled; a missing configured tab fails closed', () => {
  const { gas, state, tab } = createGas();
  state.tabs = [tab('t.0', 'private', [tab('t.1', '[[PUBLIC]]\n公開作品\n[[/PUBLIC]]')])];
  assert.equal(gas.readPublicSource_(gas.config_()).chunks.length, 0);
  state.properties.set('DOC_TAB_IDS', '*');
  assert.equal(gas.readPublicSource_(gas.config_()).chunks.length, 1);
  state.properties.set('DOC_TAB_IDS', 'missing');
  assert.throws(() => gas.readPublicSource_(gas.config_()), /DOC_TAB_NOT_FOUND/);
});

test('hybrid retrieval finds the relevant chunk and rejects weak semantic matches', () => {
  const { gas } = createGas();
  const cfg = gas.config_();
  const chunks = [
    { id: 'S1', section: '學歷', text: '商學院', vector: unitVector(1) },
    { id: 'S2', section: '專案', text: 'Python 資料分析', vector: unitVector(0) }
  ];
  const ranked = gas.rankChunks_('資料分析 Python', unitVector(0), chunks, cfg);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'S2');
  assert.equal(gas.rankChunks_('天氣', unitVector(2), chunks, cfg).length, 0);
  assert.throws(() => gas.normalizeVector_([0, 0], 2), /INVALID_EMBEDDING/);
  assert.throws(() => gas.normalizeVector_([1, NaN], 2), /INVALID_EMBEDDING/);
});

test('answers require existing sources and exact evidence; invented links fail closed', () => {
  const { gas } = createGas();
  const hits = [{ id: 'S1', section: '專案作品', text: '建立資料分析報表，將處理時間縮短 20%。' }];
  const valid = { grounded: true, answer: '曾建立資料分析報表。', evidence: [{ id: 'S1', quote: '建立資料分析報表' }] };
  assert.match(gas.validateAnswer_(valid, hits).answer, /資料來源：專案作品/);
  assert.equal(gas.validateAnswer_({ grounded: false, answer: '資料不足', evidence: [] }, hits).reason, 'INSUFFICIENT_EVIDENCE');
  for (const change of [
    { evidence: [] }, { evidence: [null] }, { evidence: [{ id: 'S1', quote: '年薪三百萬' }] },
    { answer: '作品 https://invented.example.test' }
  ]) assert.throws(() => gas.validateAnswer_({ ...valid, ...change }, hits), /ANSWER_/);
});

test('model quotes that keep the source wording but change spacing, punctuation or omit asides still count', () => {
  const { gas } = createGas();
  const hits = [
    { id: 'S1', section: '專案二：每週營運報表自動化', text: '測試成果：連續十二次週報測試，單次平均處理時間由九十分鐘降為十五分鐘。\n使用技術：Python、pandas、Google Sheets。' },
    { id: 'S2', section: '專業技能', text: 'Python：使用 pandas 整理 CSV 與 Excel 資料。' },
    { id: 'S3', section: '工作經歷一', text: '公司：禾序數位工作室（虛構公司）。\n任職期間：2024 年 7 月至 2026 年 9 月，共二年三個月。' }
  ];
  const answer = quotes => gas.validateAnswer_({ grounded: true, answer: '有報表自動化經驗。',
    evidence: quotes.map(([id, quote]) => ({ id, quote })) }, hits);
  for (const quote of [
    'Python:使用pandas整理CSV與Excel資料',        // dropped CJK/Latin spaces, half-width colon
    '「使用 pandas 整理 CSV」',                    // added quote marks
    'Ｐｙｔｈｏｎ：使用 pandas'                     // full-width Latin
  ]) assert.match(answer([['S2', quote]]).answer, /資料來源：專業技能$/);
  assert.match(answer([['S1', '連續十二次週報測試……降為十五分鐘']]).answer, /專案二/);
  assert.match(answer([['S1', '每週營運報表自動化']]).answer, /專案二/, 'section headings are document text');
  assert.match(answer([['S1', '使用 pandas 整理 CSV']]).answer, /資料來源：專業技能$/, 'a wrong id is re-attributed');
  assert.match(answer([['S3', '公司：禾序數位工作室，任職期間：2024年7月至2026年9月']]).answer, /工作經歷一/, 'omitted aside and merged lines');
  assert.match(answer([['S1', '單次平均處理時間由九十分鐘降為十五分鐘；Python：使用 pandas 整理 CSV']]).answer, /資料來源/, 'merged passages');
  for (const quote of [
    '連續…測試',                   // fragments too short to be evidence
    '平均處理時間縮短一半',         // paraphrase
    '年薪三百萬，具備十年資歷',      // invented
    '   '
  ]) assert.throws(() => answer([['S1', quote]]), /ANSWER_INVALID_EVIDENCE/, quote);
});

test('index lifecycle embeds only public facts, reuses unchanged index, and revokes removed content', () => {
  const { gas, state } = createGas({ text: source, response: call => ({ body: {
    embeddings: call.body.requests.map(() => ({ values: unitVector() }))
  } }) });
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  assert.equal(state.calls.length, 1);
  const outgoing = JSON.stringify(state.calls[0].body);
  assert(!outgoing.includes('私人住址') && !outgoing.includes('內部客戶'));
  assert.equal(state.calls[0].body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(gas.syncKnowledgeBase().status, 'unchanged');
  assert.equal(state.calls.length, 1);
  state.text = '';
  assert.match(gas.answerQuestion_('專案', gas.config_(), 'visitor'), /等待同步/);
  assert.equal(state.calls.length, 1);
  assert.throws(() => gas.syncKnowledgeBase(), /NO_PUBLIC_CONTENT/);
  assert.equal(state.properties.get('INDEX_FILE_ID'), undefined);
  assert.equal([...state.files.values()][0].trashed, true);
});

test('failed rebuild never leaves old private or deleted data usable', () => {
  const { gas, state } = createGas({ text: source, response: call => ({ body: {
    embeddings: call.body.requests.map(() => ({ values: unitVector() }))
  } }) });
  gas.syncKnowledgeBase();
  state.text = source.replace('20%', '30%');
  state.response = () => ({ status: 429, body: {} });
  assert.throws(() => gas.syncKnowledgeBase(), /GEMINI_HTTP_429/);
  assert.equal(state.properties.get('INDEX_FILE_ID'), undefined);
  assert.match(gas.answerQuestion_('專案', gas.config_(), 'visitor'), /準備中/);
});

test('document and query REST requests request 768 dimensions using the Google SDK wire format', () => {
  // Model the legacy gemini-embedding-001 path: without a top-level dimension,
  // the service returns its default 3072 values, even if a nested config is sent.
  const embedding = request => ({ values: Array.from(
    { length: request.outputDimensionality ?? 3072 }, (_, i) => i === 0 ? 2 : 0
  ) });
  const { gas, state } = createGas({ text: source, response: call => ({ body:
    call.url.endsWith(':batchEmbedContents')
      ? { embeddings: call.body.requests.map(embedding) }
      : { embedding: embedding(call.body) }
  }) });
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  const index = gas.loadIndex_(gas.config_());
  assert(index.chunks.every(chunk => chunk.vector.length === 768 && chunk.vector[0] === 1));
  const query = gas.embedQuery_('專案成果', gas.config_());
  assert.equal(query.length, 768);
  assert.equal(query[0], 1);
  for (const request of state.calls[0].body.requests) {
    assert.equal(request.model, 'models/gemini-embedding-001');
    assert.equal(request.outputDimensionality, 768);
    assert.equal(request.taskType, 'RETRIEVAL_DOCUMENT');
    assert(request.title);
    assert(!('embedContentConfig' in request));
  }
  assert.equal(state.calls[1].body.taskType, 'RETRIEVAL_QUERY');
  assert(!('title' in state.calls[1].body));
});

test('invalid vectors report safe specific errors and are never silently truncated', () => {
  const { gas } = createGas();
  const cases = [
    [undefined, 'INVALID_EMBEDDING_MISSING'],
    [Array(3072).fill(1), 'INVALID_EMBEDDING_DIMENSIONS_3072_EXPECTED_768'],
    [Array(768).fill(NaN), 'INVALID_EMBEDDING_VALUES'],
    [Array(768).fill(0), 'INVALID_EMBEDDING_NORM'],
    [Array(768).fill(Number.MAX_VALUE), 'INVALID_EMBEDDING_NORM']
  ];
  for (const [vector, code] of cases) {
    assert.throws(() => gas.normalizeVector_(vector, 768), error => error.message === code);
  }
});

test('bad embedding responses clear index state and expose no payload or credentials in logs', () => {
  const responses = [
    [{ embeddings: [{}, {}] }, 'INVALID_EMBEDDING_MISSING'],
    [{ embeddings: [null, null] }, 'INVALID_EMBEDDING_MISSING'],
    [{ embeddings: { length: 2 } }, 'INVALID_EMBEDDING_BATCH'],
    [{ embeddings: [{ values: Array(3072).fill(1) }, { values: unitVector() }] },
      'INVALID_EMBEDDING_DIMENSIONS_3072_EXPECTED_768']
  ];
  for (const [body, code] of responses) {
    const { gas, state } = createGas({ text: source, response: () => ({ body }) });
    assert.throws(() => gas.syncKnowledgeBase(), error => error.message === code);
    assert.equal(state.properties.get('LAST_SYNC_STATUS'), code);
    assert.equal(state.properties.get('INDEX_FILE_ID'), undefined);
    assert.equal(state.properties.get('SYNC_LEASE'), undefined);
    assert.equal(state.files.size, 0);
    assert.deepEqual(state.logs, [JSON.stringify({ code })]);
  }
});

test('complete question path retrieves, generates, validates evidence, and refuses mid-answer edits', () => {
  const { gas, state } = createGas({ text: source });
  state.response = call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map((_, i) => ({ values: unitVector(i) })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      grounded: true, answer: '曾建立資料分析報表，處理時間縮短 20%。', evidence: [{ id: 'S1', quote: '將處理時間縮短 20%' }]
    }) }] } }] } };
  };
  gas.syncKnowledgeBase();
  assert.match(gas.answerQuestion_('專案成果', gas.config_(), 'visitor'), /20%/);
  const generate = state.calls.find(call => call.url.endsWith(':generateContent'));
  assert(!generate.body.contents[0].parts[0].text.includes('demo@example.test'));
  const previousResponse = state.response;
  state.response = call => {
    const result = previousResponse(call);
    if (call.url.endsWith(':generateContent')) state.text = '';
    return result;
  };
  assert.match(gas.answerQuestion_('專案成果', gas.config_(), 'visitor'), /等待同步/);
});
