import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFixture, readyToRun, jd, candidate } from './job-match-fixture.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const aiCalls = f => f.state.calls.filter(c => c.url.includes('generativelanguage')).length;

// ===== Task 1：入口、草稿與文字輸入 =====

test('jm:start opens an input draft and texts accumulate without AI calls', () => {
  const f = jobFixture();
  let m = f.send('jm:start', { postback: true });
  assert.match(m[0].text, /貼上職缺/); assert.match(m[0].text, /截圖/);
  f.send('職稱：資料分析師'); m = f.send('必要：熟悉 Python');
  assert.match(m[0].text, /第 2 段/);
  assert.equal(f.draft().texts.length, 2);
  assert.equal(aiCalls(f), 0);
});

test('typed 職缺對照 also starts a draft', () => {
  const f = jobFixture(); f.send('職缺對照');
  assert.equal(f.draft().stage, 'input');
});

test('text over 6000 chars total is refused, not truncated', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  f.send('甲'.repeat(5000)); const m = f.send('乙'.repeat(1001));
  assert.match(m[0].text, /6000/); assert.equal(f.draft().texts.length, 1);
});

test('job text longer than 800 chars is accepted while a draft is open', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  const m = f.send('職'.repeat(1500));
  assert.match(m[0].text, /第 1 段/); assert.equal(aiCalls(f), 0);
});

test('pasted job text mentioning interviews stays in the job draft', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  const m = f.send('通過書審後想約面試');
  assert.match(m[0].text, /第 1 段/);
  assert.equal(f.draft().texts[0], '通過書審後想約面試');
});

test('invitation draft keeps priority over job match', () => {
  const f = jobFixture(); f.send('invite:start', { postback: true });
  f.send('職缺對照');
  assert.equal(f.draft(), null);
  assert.equal(f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_())).fields.company, '職缺對照');
});

test('two visitors keep separate drafts; home and cancel clear', () => {
  const f = jobFixture();
  f.send('jm:start', { postback: true }); f.send('jm:start', { postback: true, user: 'user-2' });
  f.send('A 公司職缺'); assert.equal(f.draft('user-2').texts.length, 0);
  f.send('首頁'); assert.equal(f.draft(), null);
  const m = f.send('jm:cancel', { postback: true, user: 'user-2' });
  assert.match(m[0].text, /已取消/); assert.equal(f.draft('user-2'), null);
});

test('contact and invitation entry points end the job draft', () => {
  for (const [text, postback] of [['nav:contact', true], ['invite:start', true]]) {
    const f = jobFixture(); f.send('jm:start', { postback: true });
    f.send(text, { postback }); assert.equal(f.draft(), null, text);
  }
});

test('evicted draft never reaches RAG', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.state.cache.clear();
  const m = f.send('必要：熟悉 Python');
  assert.match(m[0].text, /已過期/);
  assert.equal(aiCalls(f), 0);
  assert.equal(f.state.documentWrites, 0);
  // 保護期間內後續片段也一樣攔住（期限過後才回到一般問答，見 stale pending flag 測試）。
  assert.match(f.send('必要：具 SQL 經驗')[0].text, /已過期/); assert.equal(aiCalls(f), 0);
});

test('quick reply shows 職缺對照 third and stays within 6 items', () => {
  const f = jobFixture(); f.send('首頁');
  const home = f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  const items = home.quickReply.items;
  assert.equal(items[2].action.data, 'jm:start'); assert.equal(items[2].action.label, '職缺對照');
  assert(items.length <= 6);
  assert(JSON.stringify(home.contents.contents[2]).includes('jm:start'));
});

// ===== Task 2：拆條件、職缺原句核對與確認卡 =====

const extractCalls = f => f.state.calls.filter(c => c.body?.generationConfig?.responseSchema?.properties?.criteria);

test('done extracts criteria, drops ones whose quote is not in the JD, lists excluded', () => {
  const f = jobFixture({ criteria: { title: '資料分析師', excluded: ['年齡 25 歲以下'], criteria: [
    { text: 'Python', level: 'must', quote: '必要：熟悉 Python' },
    { text: 'Java', level: 'must', quote: '必要：精通 Java' },
    { text: 'Tableau', level: 'plus', quote: '加分：Tableau' }] } });
  f.send('jm:start', { postback: true }); f.send(jd);
  const m = f.send('jm:done:' + f.draft().id, { postback: true });
  assert.deepEqual(plain(f.draft().criteria.map(c => [c.id, c.text, c.level])), [['C1', 'Python', 'must'], ['C2', 'Tableau', 'plus']]);
  assert.equal(f.draft().stage, 'confirm'); assert.equal(f.draft().title, '資料分析師');
  assert.equal(extractCalls(f).length, 1);
  assert(m.length <= 2); assert.equal(m[0].type, 'flex');
  assert.match(JSON.stringify(m), /不評估/); assert.match(JSON.stringify(m), /jm:run:/);
  const prompt = JSON.stringify(extractCalls(f)[0].body);
  assert.match(prompt, /不可信/); assert(prompt.includes('必要：熟悉 Python'));
});

test('criteria quote tolerates spacing and fullwidth punctuation', () => {
  const f = jobFixture({ criteria: { title: '', excluded: [], criteria: [{ text: 'Python', level: 'must', quote: '必要: 熟悉  Python' }] } });
  f.send('jm:start', { postback: true }); f.send(jd); f.send('jm:done:' + f.draft().id, { postback: true });
  assert.equal(f.draft().criteria.length, 1);
});

test('more than 8 criteria are capped and unknown levels become unspecified', () => {
  const lines = Array.from({ length: 10 }, (_, i) => '條件第' + i + '項要求內容');
  const f = jobFixture({ criteria: { title: '', excluded: [], criteria: lines.map((q, i) => ({ text: '條件' + i, level: i ? 'must' : 'required', quote: q })) } });
  f.send('jm:start', { postback: true }); f.send(lines.join(String.fromCharCode(10))); f.send('jm:done:' + f.draft().id, { postback: true });
  assert.equal(f.draft().criteria.length, 8); assert.equal(f.draft().criteria[0].level, 'unspecified');
});

test('done without any job text asks for content and calls no AI', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  const m = f.send('jm:done:' + f.draft().id, { postback: true });
  assert.match(m[0].text, /還沒有職缺內容/); assert.equal(extractCalls(f).length, 0);
});

test('level edit, delete and HR-added criterion; unspecified is never auto-promoted', () => {
  const f = jobFixture({ criteria: { title: '', excluded: [], criteria: [
    { text: 'Python', level: 'must', quote: '必要：熟悉 Python' }, { text: 'SQL', level: 'unspecified', quote: '具 SQL 經驗' }] } });
  f.send('jm:start', { postback: true }); f.send(jd); const id = f.draft().id;
  f.send('jm:done:' + id, { postback: true });
  assert.equal(f.draft().criteria[1].level, 'unspecified');
  f.send('jm:lv:' + id + ':C1:plus', { postback: true }); assert.equal(f.draft().criteria[0].level, 'plus');
  f.send('jm:del:' + id + ':C2', { postback: true }); assert.deepEqual(plain(f.draft().criteria.map(c => c.id)), ['C1']);
  let m = f.send('jm:add:' + id, { postback: true }); assert.equal(f.draft().stage, 'adding'); assert.match(m[0].text, /補充/);
  m = f.send('需能用英文簡報');
  const added = f.draft().criteria.at(-1);
  assert.deepEqual(plain([added.id, added.text, added.level, added.quote, added.source]), ['C3', '需能用英文簡報', 'must', '人資補充', 'hr']);
  assert.equal(f.draft().stage, 'confirm'); assert.equal(m[0].type, 'flex');
  assert.equal(extractCalls(f).length, 1);
});

test('stale card button is rejected', () => {
  const f = readyToRun(); const old = f.draft().id;
  f.send('jm:restart', { postback: true }); const fresh = f.draft();
  assert.notEqual(fresh.id, old);
  const m = f.send('jm:lv:' + old + ':C1:plus', { postback: true });
  assert.match(m[0].text, /已失效/); const now = f.draft(); assert.equal(now.id, fresh.id); assert.equal(now.stage, 'input'); assert.equal(now.criteria.length, 0);
});

test('no criteria found returns to input stage keeping the text', () => {
  const f = jobFixture({ criteria: { title: '', excluded: [], criteria: [] } });
  f.send('jm:start', { postback: true }); f.send('歡迎加入我們'); const m = f.send('jm:done:' + f.draft().id, { postback: true });
  assert.match(m[0].text, /沒找到可對照的工作條件/); assert.equal(f.draft().stage, 'input'); assert.equal(f.draft().texts.length, 1);
});

test('API 429 keeps the draft and retry re-runs extraction', () => {
  let fail = true;
  const f = jobFixture({ response: call => fail && call.body?.generationConfig?.responseSchema?.properties?.criteria ? { status: 429, body: {} } : null });
  f.send('jm:start', { postback: true }); f.send(jd); const id = f.draft().id;
  const m = f.send('jm:done:' + id, { postback: true });
  assert.match(m[0].text, /429/); assert.equal(f.draft().failedStage, 'extract');
  assert(m[0].quickReply.items.some(i => i.action.data === 'jm:retry:' + id));
  fail = false; f.send('jm:retry:' + id, { postback: true });
  assert.equal(f.draft().stage, 'confirm'); assert.equal(f.draft().failedStage, null);
});

// ===== Task 3：逐項檢索、對照與引用降級 =====

const generations = f => f.state.calls.filter(c => c.url.endsWith(':generateContent'));
const matchCalls = f => f.state.calls.filter(c => c.body?.generationConfig?.responseSchema?.properties?.results);

test('run makes exactly one batch embedding and one generation', () => {
  const f = readyToRun(); f.state.calls.length = 0;
  f.send('jm:run:' + f.draft().id, { postback: true });
  assert.equal(f.state.calls.filter(c => c.url.endsWith(':batchEmbedContents')).length, 1);
  assert.equal(f.state.calls.filter(c => c.url.endsWith(':embedContent')).length, 0);
  assert.equal(generations(f).length, 1);
  assert.equal(f.draft().stage, 'result');
  const prompt = JSON.stringify(matchCalls(f)[0].body);
  assert.match(prompt, /年資/); assert.match(prompt, /履歷未提及/);
});

test('unverifiable quote downgrades to unconfirmed with a default question', () => {
  const f = readyToRun({ results: { results: [
    { id: 'C1', status: 'supported', evidence: [{ chunkId: 'S2', quote: '以 Python 建立銷售報表自動化' }], note: '有專案', question: '' },
    { id: 'C2', status: 'supported', evidence: [{ chunkId: 'S1', quote: '精通 SQL 效能調校' }], note: '有', question: '' },
    { id: 'C3', status: 'partial', evidence: [], note: '無', question: '' }] } });
  f.send('jm:run:' + f.draft().id, { postback: true });
  const [c1, c2, c3] = f.draft().results;
  assert.equal(c1.status, 'supported'); assert.equal(c1.evidence[0].section, '專案作品');
  assert.equal(c2.status, 'unconfirmed'); assert.equal(c2.evidence.length, 0); assert.match(c2.question, /SQL/);
  assert.equal(c3.status, 'unconfirmed');
});

test('quote from another criterion\'s hits is not accepted', () => {
  // S1（技能）只對 C1、S2（專案）只對 C2；C2 引用 S1 的原句必須被拒絕。
  const vectors = { 'C1': 0, 'C2': 1 };
  const f = readyToRun({
    criteria: { title: '', excluded: [], criteria: [
      { text: '熟悉 Python', level: 'must', quote: '必要：熟悉 Python' }, { text: '具 SQL 經驗', level: 'must', quote: '必要：具 SQL 經驗' }] },
    results: { results: [
      { id: 'C1', status: 'supported', evidence: [{ chunkId: 'S1', quote: 'Python、SQL 資料分析' }], note: '', question: '' },
      { id: 'C2', status: 'supported', evidence: [{ chunkId: 'S1', quote: 'Python、SQL 資料分析' }], note: '', question: '' }] },
    response: call => {
      if (!call.url.endsWith(':batchEmbedContents')) return null;
      const unit = i => Array.from({ length: 768 }, (_, n) => n === i ? 1 : 0);
      if (call.body.requests[0].taskType === 'RETRIEVAL_DOCUMENT') return { body: { embeddings: call.body.requests.map((_, i) => ({ values: unit(i) })) } };
      return { body: { embeddings: call.body.requests.map((r, i) => ({ values: unit(i) })) } };
    } });
  f.send('jm:run:' + f.draft().id, { postback: true });
  assert.deepEqual(plain(f.draft().results.map(r => r.status)), ['supported', 'unconfirmed']);
  void vectors;
});

test('missing or extra results are normalized and long text is trimmed', () => {
  const f = readyToRun({ results: { results: [
    { id: 'C9', status: 'supported', evidence: [], note: '多出的', question: '' },
    { id: 'C1', status: 'unconfirmed', evidence: [], note: '註'.repeat(80), question: '問'.repeat(100) }] } });
  f.send('jm:run:' + f.draft().id, { postback: true });
  const results = f.draft().results;
  assert.deepEqual(plain(results.map(r => r.id)), ['C1', 'C2', 'C3']);
  assert.equal(Array.from(results[0].note).length, 40); assert.equal(Array.from(results[0].question).length, 60);
  assert.equal(results[1].status, 'unconfirmed');
});

test('doc edited after sync returns stale and calls no generation', () => {
  const f = readyToRun(); f.state.calls.length = 0;
  f.state.text = f.state.text.replace('Python、SQL', 'Python、SQL、R');
  const m = f.send('jm:run:' + f.draft().id, { postback: true });
  assert.match(m[0].text, /等待同步/); assert.equal(generations(f).length, 0);
  assert.equal(f.draft().stage, 'confirm');
});

test('retried run event reuses last messages', () => {
  const f = readyToRun(); const id = f.draft().id;
  f.send('jm:run:' + id, { postback: true, id: 'same' }); const before = aiCalls(f);
  const again = f.send('jm:run:' + id, { postback: true, id: 'same-retry' });
  assert.equal(aiCalls(f), before); assert(again.length > 0);
});

test('run with every criterion deleted asks to keep at least one', () => {
  const f = readyToRun(); const id = f.draft().id;
  for (const c of f.draft().criteria) f.send('jm:del:' + id + ':' + c.id, { postback: true });
  const m = f.send('jm:run:' + id, { postback: true });
  assert.match(m[0].text, /至少保留一項/); assert.equal(matchCalls(f).length, 0);
});

test('match API failure keeps the draft and retry re-runs matching', () => {
  let fail = true;
  const f = readyToRun({ response: call => fail && call.body?.generationConfig?.responseSchema?.properties?.results ? { status: 503, body: {} } : null });
  const id = f.draft().id; const m = f.send('jm:run:' + id, { postback: true });
  assert.match(m[0].text, /503/); assert.equal(f.draft().failedStage, 'match');
  fail = false; f.send('jm:retry:' + id, { postback: true }); assert.equal(f.draft().stage, 'result');
});

test('job match never writes Doc, index or pending questions', () => {
  const f = readyToRun(); const cfg = f.gas.config_();
  const indexFile = f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).content;
  f.send('jm:run:' + f.draft().id, { postback: true });
  assert.equal(f.state.documentWrites, 0);
  assert.equal(f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).content, indexFile);
  assert(!f.state.text.includes('資料分析師')); void cfg;
});

// ===== Task 4：燈號熱圖、證據卡與面談問題 =====

function draftWith(rows) {
  return { id: 'a'.repeat(16), title: '資料分析師', excluded: [],
    criteria: rows.map(([id, level]) => ({ id, text: '條件' + id, level, quote: '原句' + id, source: 'jd' })),
    results: rows.map(([id, , status]) => ({ id, status, note: '說明' + id,
      evidence: status === 'unconfirmed' ? [] : [{ chunkId: 'S1', section: '專業技能', quote: '原文' + id }],
      question: status === 'supported' ? '' : '問題' + id })) };
}

test('heatmap rows are ordered must-first with unconfirmed on top and use the fixed colors', () => {
  const { gas } = jobFixture();
  const d = draftWith([['C1', 'must', 'supported'], ['C2', 'plus', 'unconfirmed'], ['C3', 'must', 'unconfirmed'], ['C4', 'must', 'partial']]);
  assert.deepEqual(plain(gas.sortedRows_(d).map(r => r.criterion.id)), ['C3', 'C4', 'C1', 'C2']);
  const json = JSON.stringify(gas.heatmapMessage_(d));
  for (const color of ['#2E7D32', '#F9A825', '#BDBDBD']) assert(json.includes(color), color);
  assert(!/#(?:E53935|F44336|FF0000|D32F2F)/i.test(json));
  assert(json.includes('資料分析師')); assert(json.includes('說明C1'));
});

test('summary counts supported per level and never says score', () => {
  const { gas } = jobFixture();
  const d = draftWith([['C1', 'must', 'supported'], ['C2', 'must', 'partial'], ['C3', 'plus', 'unconfirmed']]);
  assert.equal(gas.jobMatchSummary_(d), '必要條件 1／2 有依據・加分條件 0／1 有依據');
  assert.equal(gas.jobMatchSummary_(draftWith([['C1', 'must', 'supported']])), '必要條件 1／1 有依據');
  assert(!/分數|\d+\s*分(?!類)/.test(JSON.stringify(gas.jobMatchResultMessages_(d))));
});

test('result reply has at most 5 messages and evidence shows the resume quote and section', () => {
  const f = readyToRun(); const m = f.send('jm:run:' + f.draft().id, { postback: true });
  assert(m.length <= 5); assert.equal(m[0].type, 'flex'); assert.match(m[0].altText, /有依據/);
  const evidence = JSON.stringify(m[1]);
  assert(evidence.includes('以 Python 建立銷售報表自動化')); assert(evidence.includes('專案作品'));
  const last = m.at(-1);
  assert.match(last.text, /請說明使用 SQL 的專案/);
  const actions = last.quickReply.items.map(i => i.action.data);
  assert(actions.includes('jm:invite:' + f.draft().id)); assert(actions.includes('jm:restart'));
});

test('all-unconfirmed result omits evidence carousel and still offers invite', () => {
  const { gas } = jobFixture();
  const d = draftWith([['C1', 'must', 'unconfirmed'], ['C2', 'plus', 'unconfirmed']]);
  assert.equal(gas.evidenceCarousel_(d), null);
  const m = gas.jobMatchResultMessages_(d);
  assert.equal(m.length, 2);
  assert(m[1].quickReply.items.some(i => i.action.data === 'jm:invite:' + d.id));
  assert.match(m[1].text, /不代表不具備/);
});

// ===== Task 6：帶待確認問題的預填邀約 =====

function resultReady(options) { const f = readyToRun(options); f.send('jm:run:' + f.draft().id, { postback: true }); return f; }
const invitation = f => f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_()));
const records = f => Object.keys(f.gas.loadPortfolioStore_(f.gas.config_()).invitations || {});

test('jobInvitationPrefill_ lists only questions for partial and unconfirmed items', () => {
  const { gas } = jobFixture();
  const text = gas.jobInvitationPrefill_(draftWith([['C1', 'must', 'supported'], ['C2', 'must', 'partial'], ['C3', 'plus', 'unconfirmed']]));
  assert.equal(text, '職缺：資料分析師\n想先請教本人的問題：\n1. 問題C2\n2. 問題C3');
  const long = draftWith(Array.from({ length: 8 }, (_, i) => ['C' + i, 'must', 'unconfirmed']));
  long.results.forEach(r => { r.question = '問'.repeat(200); });
  assert.equal(Array.from(gas.jobInvitationPrefill_(long)).length, 800);
});

test('invite from result pre-fills questions and still requires confirmation', () => {
  const f = resultReady(); f.send('jm:invite:' + f.draft().id, { postback: true });
  assert.equal(f.draft(), null);
  assert.equal(invitation(f).step, 0);
  f.send('青禾公司／王小姐');
  const prompt = f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  assert.match(prompt.text, /請說明使用 SQL 的專案/);
  assert(prompt.quickReply.items.some(i => i.action.data === 'invite:keep:' + invitation(f).id));
  f.send('invite:keep:' + invitation(f).id, { postback: true });
  assert.match(invitation(f).fields.message, /想先請教本人的問題/);
  assert.equal(invitation(f).step, 2);
  assert.equal(records(f).length, 0);
});

test('typing in step 2 overrides the prefill', () => {
  const f = resultReady(); f.send('jm:invite:' + f.draft().id, { postback: true });
  f.send('青禾公司／王小姐'); f.send('想邀請您面試資料分析師');
  assert.equal(invitation(f).fields.message, '想邀請您面試資料分析師');
});

test('result itself sends no email and no push', () => {
  const f = resultReady();
  assert.equal(f.state.emails.length, 0);
  assert(!f.state.calls.some(c => c.url.includes('/message/push')));
});

// ===== Final review fixes =====

test('script lock is not held during Gemini or LINE content calls', () => {
  let held = false, violations = 0;
  const f = jobFixture({ response: call => {
    if (held && /generativelanguage|api-data\.line\.me/.test(call.url)) violations++;
    return null;
  } });
  f.gas.LockService = { getScriptLock: () => ({ waitLock() { held = true; }, tryLock() { held = true; return true; }, releaseLock() { held = false; } }) };
  f.send('jm:start', { postback: true }); f.send('', { image: true }); f.send(jd);
  f.send('jm:done:' + f.draft().id, { postback: true });
  f.send('jm:run:' + f.draft().id, { postback: true });
  assert.equal(f.draft().stage, 'result'); assert.equal(violations, 0);
});

test('events arriving while a slow step runs get a wait message and do not change the draft', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.send(jd);
  const key = f.gas.jobMatchKey_('user-1', f.gas.config_()), d = f.draft();
  d.busy = { eventId: 'other', until: Date.now() + 60000 }; f.gas.saveJobMatchDraft_(key, d);
  const m = f.send('再貼一段');
  assert.match(m[0].text, /處理中/); assert.equal(f.draft().texts.length, 1);
  const n = f.send('jm:done:' + d.id, { postback: true });
  assert.match(n[0].text, /處理中/); assert.equal(aiCalls(f), 0);
});

test('a slow result is discarded when the draft was cancelled meanwhile', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.send(jd);
  const key = f.gas.jobMatchKey_('user-1', f.gas.config_());
  const original = f.gas.extractCriteria_;
  f.gas.extractCriteria_ = (text, cfg) => { f.gas.CacheService.getScriptCache().remove(key); return original(text, cfg); };
  const m = f.send('jm:done:' + f.draft().id, { postback: true });
  assert.match(m[0].text, /已變更|已取消|已過期/); assert.equal(f.draft(), null);
});

test('after the result card, free text goes to normal Q&A and ends the job draft', () => {
  const f = readyToRun(); f.send('jm:run:' + f.draft().id, { postback: true });
  const before = f.state.calls.filter(c => c.url.endsWith(':generateContent')).length;
  f.send('他做過哪些 Python 專案？');
  assert.equal(f.draft(), null);
  const answers = f.state.calls.filter(c => c.url.endsWith(':generateContent')).slice(before);
  assert(answers.length >= 1); assert(!answers.some(c => c.body.generationConfig?.responseSchema?.properties?.criteria));
});

test('done is ignored outside the input stage', () => {
  const f = readyToRun(); const id = f.draft().id; f.send('jm:run:' + id, { postback: true });
  const results = JSON.stringify(f.draft().results), extracts = extractCalls(f).length;
  const m = f.send('jm:done:' + id, { postback: true });
  assert.match(m[0].text, /已失效/); assert.equal(extractCalls(f).length, extracts);
  assert.equal(JSON.stringify(f.draft().results), results);
});

test('finishing a match clears the pending flag so later questions are never intercepted', () => {
  const f = readyToRun(); f.send('jm:run:' + f.draft().id, { postback: true });
  assert(![...f.state.properties.keys()].some(k => k.startsWith('pending_jobmatch:')));
  f.state.cache.clear(); const m = f.send('有哪些技能？');
  assert.doesNotMatch(m[0].text || '', /已過期/);
});

test('after eviction every pasted fragment within the window is shielded from RAG and the Doc', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.state.cache.clear();
  for (const part of ['職缺第一段：必要 Python', '職缺第二段：加分 Tableau', '職缺第三段：年齡不限']) {
    assert.match(f.send(part)[0].text, /已過期/);
  }
  assert.equal(aiCalls(f), 0); assert.equal(f.state.documentWrites, 0);
});

test('a stale pending flag past its window does not intercept', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.state.cache.clear();
  const key = [...f.state.properties.keys()].find(k => k.startsWith('pending_jobmatch:'));
  f.state.properties.set(key, JSON.stringify({ until: Date.now() - 1 }));
  f.send('有哪些技能？'); assert(aiCalls(f) > 0);
  assert(!f.state.properties.has(key));
});
