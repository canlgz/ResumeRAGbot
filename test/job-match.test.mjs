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
