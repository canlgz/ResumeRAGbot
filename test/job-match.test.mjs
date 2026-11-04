import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

// 全部為虛構測試資料。
const resume = '[[PUBLIC]]\n## 專業技能\nPython：使用 pandas 整理 CSV 資料。SQL：撰寫 JOIN 與彙總查詢。\n## 專案作品\n使用 Google Apps Script 串接 Google Sheets，完成每週報表自動化。\n[[/PUBLIC]]';
const JOB = '職缺：資料分析工程師\n工作內容：維護營運報表與資料品質檢查。\n必要條件：熟悉 Python 與 SQL。\n必要條件：具備 Google Apps Script 開發經驗。\n加分條件：有 Tableau 經驗尤佳。\n限 35 歲以下。';

const geminiText = value => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] } });
const defaultExtract = {
  isJobPosting: true, title: '資料分析工程師', excludedCount: 0, criteria: [
    { text: '熟悉 Python 與 SQL', level: 'required', quote: '熟悉 Python 與 SQL' },
    { text: 'Google Apps Script 開發經驗', level: 'required', quote: '具備 Google Apps Script 開發經驗' },
    { text: 'Tableau 經驗', level: 'preferred', quote: '有 Tableau 經驗尤佳' },
    { text: '精通 Kubernetes', level: 'required', quote: '精通 Kubernetes 叢集維運' }, // 職缺沒寫：必須被丟棄
    { text: '35 歲以下', level: 'required', quote: '限 35 歲以下' } // 與工作無關：必須排除
  ] };

// 依請求內容回應：C1 引用正確、C2 引用捏造、C3 使用否定字眼；問題含敏感題與網址。
function defaultMatch(input) {
  const python = input.criteria[0].evidence.find(e => e.text.includes('pandas'));
  return { items: [
    { id: 'C1', status: 'supported', note: '求職者曾使用 pandas 整理資料並撰寫 SQL 查詢。', evidence: [{ id: python.id, quote: '使用 pandas 整理 CSV 資料' }] },
    { id: 'C2', status: 'supported', note: '求職者主導過大型遷移。', evidence: [{ id: 'S9', quote: '主導 Kubernetes 遷移專案' }] },
    { id: 'C3', status: 'unclear', note: '求職者不具備 Tableau 能力。', evidence: [] }
  ], questions: ['請問您結婚了嗎？', '請參考 https://invented.example.test 說明作品', '請說明您使用 Tableau 或其他視覺化工具的經驗。'] };
}

function setup(options = {}) {
  const state = { extract: defaultExtract, match: defaultMatch, failEmbed: false };
  const response = call => {
    if (call.url.endsWith(':batchEmbedContents')) {
      if (state.failEmbed && call.body.requests[0].taskType === 'RETRIEVAL_QUERY') return { status: 429, body: {} };
      return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    }
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    if (call.url.endsWith(':generateContent')) {
      const props = call.body.generationConfig.responseSchema.properties;
      const input = JSON.parse(call.body.contents[0].parts[0].text);
      if (props.criteria) return geminiText(state.extract);
      if (props.questions) return geminiText(state.match(input));
      return geminiText({ grounded: false, answer: '目前公開履歷未提供這項資訊', evidence: [], dialogueIntent: 'neutral' });
    }
    return { body: {} };
  };
  const f = createGas({ text: resume, response, ...options });
  f.gas.syncKnowledgeBase();
  f.state.calls.length = 0;
  let n = 0;
  const send = (text, post = false) => {
    const e = event(text, 'job-' + (++n));
    if (post) { e.type = 'postback'; e.postback = { data: text }; }
    f.gas.handleEvent_(e, f.gas.config_());
    return f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  };
  const key = () => f.gas.jobMatchKey_('user-1', f.gas.config_());
  const draft = () => f.gas.jobMatchDraft_(key());
  const aiCalls = () => f.state.calls.filter(c => c.url.includes('generativelanguage')).length;
  return { ...f, mock: state, send, key, draft, aiCalls };
}

test('job match: criteria come only from the posting, unrelated criteria are excluded, raw text is never stored', () => {
  const f = setup();
  const prompt = f.send('職缺對照');
  assert.match(prompt[0].text, /職缺對照 1 \/ 3/);
  assert.equal(f.draft().step, 'await_job');
  assert(f.state.properties.get('pending_' + f.key()), 'pending flag protects the next message from RAG');
  const confirm = f.send(JOB);
  assert.match(confirm[0].text, /職缺對照 2 \/ 3/);
  const card = JSON.stringify(confirm[1]);
  assert(card.includes('熟悉 Python 與 SQL') && card.includes('Google Apps Script'));
  assert(!card.includes('Kubernetes'), 'invented criteria are dropped');
  assert(!card.includes('35 歲'), 'age criteria are not matched');
  assert(card.includes('另有 1 項'));
  assert.equal(f.draft().items.length, 3);
  assert.equal(f.state.properties.get('pending_' + f.key()), undefined);
  assert(!JSON.stringify([...f.state.cache.values()]).includes('維護營運報表'), 'raw posting is not cached');
  assert.equal(f.state.documentWrites, 0);
  assert(!f.state.text.includes('資料分析工程師'));
});

test('job match: each item is checked against its own evidence, fake quotes downgrade, no negative verdicts or scores', () => {
  const f = setup();
  f.send('職缺對照'); f.send(JOB);
  const id = f.draft().id;
  const result = f.send('job:run:' + id, true);
  assert.match(result[0].text, /有履歷依據 1 項、待確認 2 項/);
  assert.match(result[0].text, /不代表求職者不具備/);
  const card = JSON.stringify(result[1]);
  assert.equal(result[1].contents.type, 'carousel');
  assert(card.includes('✓ 有依據') && card.includes('來源：專業技能'));
  assert(!card.includes('主導過大型遷移'), 'unsupported claim is not shown');
  assert(!card.includes('不具備 Tableau'), 'negative verdict is replaced');
  assert(card.includes('公開履歷未提供明確依據'));
  assert(!card.includes('結婚') && !card.includes('invented.example.test'));
  assert(card.includes('Tableau 或其他視覺化工具'));
  const footer = result[1].contents.contents[1].footer.contents.map(button => button.action.data);
  assert.deepEqual(footer, ['invite:start', 'job:start', 'job:cancel']);
  const before = f.aiCalls();
  assert.equal(f.send('job:run:' + id, true)[0].text, result[0].text);
  assert.equal(f.aiCalls(), before, 'pressing again reuses the result without new AI calls');
  assert.match(f.send('取消')[0].text, /已結束職缺對照/);
  assert.equal(f.draft(), null);
  assert.equal(f.state.documentWrites, 0);
});

test('job match: long postings bypass the 800-character question limit; oversize postings make no AI call', () => {
  const f = setup();
  f.send('職缺對照');
  const long = JOB + '\n' + '補充說明：團隊重視溝通。'.repeat(80);
  assert(Array.from(long).length > 800 && Array.from(long).length < 2000);
  assert.match(f.send(long)[0].text, /職缺對照 2 \/ 3/);
  f.send('job:restart:' + f.draft().id, true);
  const calls = f.aiCalls();
  assert.match(f.send('很長'.repeat(1100))[0].text, /2000 字內/);
  assert.equal(f.aiCalls(), calls);
  assert.equal(f.state.documentWrites, 0);
});

test('job match: if the cache expires while waiting, the pasted posting is not sent to AI or recorded', () => {
  const f = setup();
  f.send('職缺對照');
  f.state.cache.delete(f.key());
  assert.match(f.send(JOB)[0].text, /已過期/);
  assert.equal(f.aiCalls(), 0);
  assert.equal(f.state.documentWrites, 0);
  assert.equal(f.state.properties.get('pending_' + f.key()), undefined);
});

test('job match: API failure keeps the confirmed criteria and offers a retry button', () => {
  const f = setup();
  f.send('職缺對照'); f.send(JOB);
  const id = f.draft().id;
  f.mock.failEmbed = true;
  const failed = f.send('job:run:' + id, true);
  assert.match(failed[0].text, /429/);
  assert.equal(failed[1].contents.footer.contents[0].action.data, 'job:run:' + id);
  assert.equal(f.draft().step, 'confirm');
  f.mock.failEmbed = false;
  assert.match(f.send('job:run:' + id, true)[0].text, /有履歷依據/);
});

test('job match: non-postings stay in the paste step; stale resume data is never used', () => {
  const f = setup();
  f.send('職缺對照');
  f.mock.extract = { isJobPosting: false, title: '', excludedCount: 0, criteria: [] };
  assert.match(f.send('今天天氣很好，大家午餐想吃什麼呢？我們晚點再討論吧')[0].text, /不是職缺/);
  assert.equal(f.draft().step, 'await_job');
  f.mock.extract = defaultExtract;
  f.send(JOB);
  f.state.text = resume.replace('pandas', 'polars');
  const before = f.aiCalls();
  const stale = f.send('job:run:' + f.draft().id, true);
  assert.match(stale[0].text, /等待同步/);
  assert.equal(f.aiCalls(), before);
});

test('job match and invitations do not capture each other', () => {
  const f = setup();
  f.send('職缺對照'); f.send(JOB); f.send('job:run:' + f.draft().id, true);
  const invite = f.send('invite:start', true);
  assert.match(invite[0].text, /留下邀約 1 \/ 4/);
  assert.equal(f.draft(), null, 'choosing to invite ends the job match');
  const inviteKey = f.gas.invitationKey_('user-1', f.gas.config_());
  assert(f.gas.invitationDraft_(inviteKey));
  f.send('職缺對照');
  assert.equal(f.gas.invitationDraft_(inviteKey), null, 'starting a job match discards an unconfirmed invitation draft');
  f.send('取消');
  f.send('invite:start', true);
  assert.match(f.send('取消')[0].text, /已取消填寫/, 'cancel still ends invitations when no job match is active');
});

test('job match: a free question during confirmation goes to normal resume Q&A and old cards are rejected', () => {
  const f = setup();
  f.send('職缺對照'); f.send(JOB);
  const oldId = f.draft().id;
  assert.doesNotMatch(f.send('有哪些專案？')[0].text, /職缺對照/);
  assert.equal(f.draft().id, oldId);
  f.send('job:restart:' + oldId, true);
  assert.match(f.send('job:run:' + oldId, true)[0].text, /已過期/);
});
