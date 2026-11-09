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
  // 旗標只攔一次，之後回到一般問答。
  f.send('有哪些技能？'); assert(aiCalls(f) > 0);
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
