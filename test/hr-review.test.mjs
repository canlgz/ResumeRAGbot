import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const doc = '[[PUBLIC]]\n## 專案作品\n使用 Python 與 RAG 建立 LINE Bot 履歷助理，負責檢索與回覆流程。\n## 技能\n熟悉 Google Apps Script 與 Gemini API。\n[[/PUBLIC]]';
const QUOTE = '使用 Python 與 RAG 建立 LINE Bot 履歷助理';
const isHr = call => Boolean(call.body?.generationConfig?.responseSchema?.properties?.cells);
const candidate = value => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] } });
const goodReview = {
  skills: ['Python 開發', 'LINE Bot', '資料分析'],
  cells: [
    { row: 0, col: 0, level: 'strong', id: 'x', quote: QUOTE },
    { row: 1, col: 0, level: 'related', id: 'x', quote: QUOTE },
    { row: 2, col: 1, level: 'strong', id: 'x', quote: QUOTE }
  ],
  pending: [],
  interviewQuestions: ['請說明 RAG 檢索流程的設計。', '如何處理 LINE 回覆失敗？', '專案中負責哪些部分？', '第四題', '第五題']
};

function setup(hr = () => candidate(goodReview)) {
  const f = createGas({ text: doc });
  f.hr = hr;
  f.state.response = call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    if (isHr(call)) return f.hr(call);
    return { body: {} };
  };
  assert.equal(f.gas.syncKnowledgeBase().status, 'ok');
  let n = 0;
  f.send = (text, post = false, id) => {
    const e = event(text, id || 'hr-' + (++n));
    if (post) { e.type = 'postback'; e.postback = { data: text }; }
    f.gas.handleEvent_(e, f.gas.config_());
    return f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  };
  f.draft = () => f.gas.hrReviewDraft_(f.gas.hrReviewKey_('user-1', f.gas.config_()));
  f.fill = () => { f.send('hr:start', true); f.send('AI 應用工程師'); f.send('Python、RAG、LINE Bot'); return f.send('hr:skip:' + f.draft().id, true); };
  f.ai = () => f.state.calls.filter(c => c.url.includes('generativelanguage'));
  return f;
}
const text = messages => messages.map(m => m.text || JSON.stringify(m)).join('\n');

test('Deterministic requirement parsing follows the spec parsing cases', () => {
  const { gas } = createGas();
  const rows = fields => { const r = gas.hrRequirements_(fields); return JSON.parse(JSON.stringify({ items: r.items.map(i => i.label + ':' + i.kind), truncated: r.truncated })); };
  assert.deepEqual(rows({ required: 'Python、RAG', bonus: '' }), { items: ['Python:required', 'RAG:required'], truncated: false });
  assert.deepEqual(rows({ required: 'Python\nPython; SQL', bonus: '簡報' }), { items: ['Python:required', 'SQL:required', '簡報:bonus'], truncated: false });
  assert.deepEqual(rows({ required: 'A,B,C,D', bonus: 'E、F' }), { items: ['A:required', 'B:required', 'C:required', 'D:required', 'E:bonus'], truncated: true });
});

test('Start from Quick Reply shows step 1 of 3 with notices; text 人資 also starts', () => {
  const f = setup();
  const [prompt] = f.send('hr:start', true);
  assert.match(prompt.text, /人資模式 1 \/ 3/);
  for (const notice of [/不是錄取分數/, /Gemini/, /30 分鐘/, /取消/]) assert.match(prompt.text, notice);
  assert.deepEqual(prompt.quickReply.items.map(i => i.action.data), ['hr:timeline', 'hr:star', 'hr:cancel']);
  const g = setup();
  assert.match(g.send('人資')[0].text, /人資模式 1 \/ 3/);
});

test('Quick Reply keeps topics first and 人資模式 is not a resume topic', () => {
  const f = setup();
  const labels = f.send('首頁')[0].quickReply.items.map(i => i.action.label);
  assert.equal(labels.at(-1), '人資模式');
  const topics = JSON.parse(JSON.stringify(f.gas.menuTopics_(f.gas.loadIndex_(f.gas.config_())).map(t => t.label)));
  assert.deepEqual(labels.slice(0, -1), topics.slice(0, labels.length - 1));
  assert(!topics.includes('人資模式'));
  // 規格情境：只有兩個基本主題時，標籤完整為「我是誰、快速一覽、人資模式」。
  const base = createGas();
  base.gas.handleEvent_(event('選單', 'base-only'), base.gas.config_());
  const baseReply = base.state.calls.find(c => c.url.endsWith('/message/reply')).body.messages[0];
  assert.deepEqual(JSON.parse(JSON.stringify(baseReply.quickReply.items.map(i => i.action.label))), ['我是誰', '快速一覽', '人資模式']);
  assert.deepEqual(JSON.parse(JSON.stringify(base.gas.visibleMenuTopics_().map(t => t.label))), ['我是誰', '快速一覽']);
});

test('Complete the questionnaire: confirmation lists role and parsed requirements without AI or memory', () => {
  const f = setup(), before = f.ai().length;
  const confirmation = f.fill();
  assert.match(confirmation[0].text, /AI 應用工程師/);
  assert.match(confirmation[0].text, /1\. Python\n2\. RAG\n3\. LINE Bot/);
  const id = f.draft().id;
  assert.deepEqual(confirmation[1].contents.footer.contents.map(b => b.action.data), ['hr:submit:' + id, 'hr:deep:' + id, 'hr:restart:' + id, 'hr:cancel']);
  const bodyActions = confirmation[1].contents.body.contents.filter(c => c.type === 'button').map(b => b.action.data);
  assert.deepEqual(bodyActions, [0, 1, 2].map(i => 'hr:drop:' + id + ':' + i).concat('hr:edit:' + id));
  assert.equal(f.ai().length, before);
  assert.equal(f.draft().step, 3);
  assert.equal(f.gas.readConversation_('user-1', f.gas.loadIndex_(f.gas.config_()).fingerprint), null);
  assert(!confirmation.some(m => m.type === 'sticker'));
});

test('Over-length answer and Required field with no items keep the current step', () => {
  const f = setup();
  f.send('hr:start', true);
  assert.match(f.send('職'.repeat(51))[0].text, /50 字/);
  assert.equal(f.draft().step, 0);
  f.send('AI 應用工程師');
  assert.match(f.send('、、，')[0].text, /至少輸入一項/);
  assert.equal(f.draft().step, 1);
});

test('Successful analysis reply: one embedding + one generation, 4 messages, capped questions, nothing persisted', () => {
  const f = setup(), before = f.state.calls.length;
  f.fill();
  const id = f.draft().id, storeBefore = JSON.stringify(f.gas.loadPortfolioStore_(f.gas.config_()).invitations || {});
  const writes = f.state.documentWrites;
  const reply = f.send('hr:submit:' + id, true);
  const calls = f.state.calls.slice(before);
  assert.equal(calls.filter(c => c.url.endsWith(':embedContent')).length, 1);
  assert.equal(calls.filter(isHr).length, 1);
  const instructions = calls.find(isHr).body.systemInstruction.parts[0].text;
  for (const rule of ['不可信資料', '年齡', '性別', '宗教', '健康', '國籍', '不承諾錄取']) assert(instructions.includes(rule), rule);
  assert.equal(reply.length, 4);
  assert.match(reply[0].text, /AI 應用工程師/);
  assert.match(reply[0].text, /共對照 3 項需求/);
  assert.equal(reply[1].type, 'flex');
  assert(JSON.stringify(reply[1]).includes('只表示公開履歷中的證據強度，不是錄取分數；未提及不代表不具備。'));
  assert(JSON.stringify(reply[1]).length < 30000);
  assert.match(reply[2].text, /待確認條件/);
  assert.equal((reply[2].text.match(/^\d\. /gm) || []).length, 3);
  assert(!reply[2].text.includes('第四題'));
  assert.equal(reply[3].text, '資料來源：專案作品');
  assert(reply.every(m => m.quickReply && m.quickReply.items.at(-1).action.data === 'hr:start'));
  // Nothing persisted after analysis
  assert.equal(f.state.documentWrites, writes);
  assert.equal(JSON.stringify(f.gas.loadPortfolioStore_(f.gas.config_()).invitations || {}), storeBefore);
  assert(!JSON.stringify(f.state.logs).includes('AI 應用工程師'));
  assert(!JSON.stringify(f.state.logs).includes('LINE Bot'));
  assert.deepEqual(JSON.parse(JSON.stringify(f.draft().fields)), {});
  assert.equal(f.gas.hrReviewActive_('user-1', f.gas.config_()), false);
});

test('Unverifiable quote is downgraded and column and row pruning follow the spec example', () => {
  const { gas } = createGas();
  const hits = [{ id: 'c1', section: '專案作品', text: '使用 Python 開發資料處理工具，負責後端流程。' }];
  const reqs = [{ label: 'Python', kind: 'required' }, { label: 'SQL', kind: 'required' }];
  const review = gas.validateHrReview_({ skills: ['Python 開發', '資料分析'], cells: [
    { row: 0, col: 0, level: 'strong', id: 'c1', quote: '使用 Python 開發資料處理工具' },
    { row: 1, col: 1, level: 'strong', id: 'c1', quote: '精通 SQL 資料庫調校與索引設計' }
  ], pending: [], interviewQuestions: [] }, reqs, hits);
  assert.deepEqual([...review.skills], ['Python 開發']);
  assert.deepEqual(JSON.parse(JSON.stringify(review.grid)), [['strong'], ['none']]);
  assert.deepEqual([...review.pending], ['SQL']);
  const rag = gas.validateHrReview_({ skills: ['Python 開發'], cells: [
    { row: 0, col: 0, level: 'strong', id: 'c1', quote: '使用 Python 開發資料處理工具' },
    { row: 1, col: 0, level: 'strong', id: 'c1', quote: '建置 RAG 向量檢索服務並上線' }
  ], pending: [], interviewQuestions: [] }, [{ label: 'Python', kind: 'required' }, { label: 'RAG', kind: 'required' }], hits);
  assert.equal(rag.grid[1][0], 'none');
  assert(rag.pending.includes('RAG'));
  assert.throws(() => gas.validateHrReview_({ skills: [] }, reqs, hits), /HR_REVIEW_INVALID_FORMAT/);
});

test('No supported skills: no heatmap, every requirement listed as pending', () => {
  const f = setup(() => candidate({ skills: ['不存在'], cells: [{ row: 0, col: 0, level: 'strong', id: 'x', quote: '完全捏造的工作經歷內容' }], pending: [], interviewQuestions: [] }));
  f.fill();
  const reply = f.send('hr:submit:' + f.draft().id, true);
  assert(!reply.some(m => m.type === 'flex'));
  for (const label of ['Python', 'RAG', 'LINE Bot']) assert.match(text(reply), new RegExp('• ' + label));
});

test('a 5 by 5 heatmap with long labels stays under the LINE size bound', () => {
  const { gas } = createGas();
  const reqs = Array.from({ length: 5 }, (_, i) => ({ label: '非常長的需求名稱'.repeat(8) + i, kind: i > 2 ? 'bonus' : 'required' }));
  const message = gas.hrHeatmapMessage_('職'.repeat(50), reqs, { skills: Array.from({ length: 5 }, (_, i) => '技能名稱很長' + i),
    grid: reqs.map(() => ['strong', 'related', 'indirect', 'none', 'strong']), pending: [], interviewQuestions: [], sections: [] });
  assert(JSON.stringify(message).length < 30000);
  assert.match(JSON.stringify(message), /＋非常長/);
});

test('Leaving through the home command clears the HR draft and shows home', () => {
  const f = setup();
  f.send('hr:start', true); f.send('AI 應用工程師');
  const home = f.send('首頁');
  assert.equal(home[0].type, 'flex');
  assert.equal(f.draft(), null);
  assert.equal(f.gas.hrReviewActive_('user-1', f.gas.config_()), false);
});

test('HR mode replaces an invitation draft, and 取消 during HR mode leaves HR mode', () => {
  const f = setup();
  f.send('invite:start', true);
  const inviteDraft = () => f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_()));
  assert(inviteDraft());
  assert.match(f.send('hr:start', true)[0].text, /人資模式 1 \/ 3/);
  assert.equal(inviteDraft(), null);
  assert.equal(f.send('取消')[0].text, '已離開人資模式，剛才的內容沒有送出分析。');
  assert.equal(f.draft(), null);
  // 作答內容看似聯繫意圖時，仍屬於人資草稿。
  f.send('hr:start', true); f.send('AI 應用工程師');
  f.send('想合作');
  assert.equal(f.draft().fields.required, '想合作');
  // 明確的聯繫指令結束人資草稿。
  assert.equal(f.send('nav:contact', true)[0].type, 'flex');
  assert.equal(f.draft(), null);
});

test('Expired draft gets a notice and makes no Gemini request; stale submit ids expire', () => {
  const f = setup();
  f.send('hr:start', true);
  f.state.cache.clear();
  const before = f.ai().length;
  assert.match(f.send('AI 應用工程師')[0].text, /已過期/);
  assert.equal(f.ai().length, before);
  const g = setup();
  g.fill();
  assert.match(g.send('hr:submit:' + 'a'.repeat(32), true)[0].text, /已過期/);
});

test('Duplicate submit event calls Gemini once and returns the same messages', () => {
  const f = setup();
  f.fill();
  const e = event('hr:submit:' + f.draft().id, 'dup');
  e.type = 'postback'; e.postback = { data: e.message.text };
  const first = f.gas.handleHrReview_(e, e.postback.data, f.gas.config_(), null);
  const second = f.gas.handleHrReview_(e, e.postback.data, f.gas.config_(), null);
  assert.equal(f.state.calls.filter(isHr).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
});

test('Invalid AI format then retry keeps the confirmation step and logs only the code', () => {
  let bad = true;
  const f = setup(() => bad ? candidate({ skills: [], pending: [], interviewQuestions: [] }) : candidate(goodReview));
  f.fill();
  const id = f.draft().id;
  assert.match(f.send('hr:submit:' + id, true)[0].text, /開始對照/);
  assert(f.state.logs.includes(JSON.stringify({ code: 'HR_REVIEW_INVALID_FORMAT' })));
  assert.equal(f.draft().step, 3);
  bad = false;
  assert(f.send('hr:submit:' + id, true).some(m => m.type === 'flex'));
});

test('Resume changed during generation sends no heatmap', () => {
  const f = setup(call => { f.state.text = doc.replace('Gemini API', 'Gemini API 與 Vertex AI'); return candidate(goodReview); });
  f.fill();
  const reply = f.send('hr:submit:' + f.draft().id, true);
  assert.match(reply[0].text, /等待同步/);
  assert(!reply.some(m => m.type === 'flex'));
  assert.equal(f.draft().step, 3);
});

test('Privacy text explains the difference between HR mode and invitations', () => {
  const f = setup();
  const reply = f.send('隱私')[0].text;
  assert.match(reply, /人資模式填寫的職位與條件會交給 Google Gemini/);
  assert.match(reply, /邀約填寫內容不交給 AI/);
  assert.match(f.send('使用說明')[0].text, /人資模式/);
});

test('Deployment check after upgrade reports 3.2.0 on both sides and keeps a v2 index ready', () => {
  const publicUrl = 'https://script.google.com/macros/s/student-v3/exec';
  const f = setup();
  assert.equal(f.gas.appVersion_(), "3.2.0");
  const file = f.state.files.get(f.state.properties.get('INDEX_FILE_ID'));
  const idx = JSON.parse(file.content); idx.builtWithAppVersion = '2.0.0'; file.content = JSON.stringify(idx);
  const previous = f.state.response;
  f.state.response = call => call.url.startsWith(publicUrl + '?version_check=') ? { text: f.gas.doGet().text } : previous(call);
  f.state.properties.set('WEB_APP_URL', publicUrl);
  const result = f.gas.checkDeployment();
  assert.equal(result.status, 'ready');
  assert.equal(result.editorVersion, '3.2.0');
  assert.equal(result.webAppVersion, '3.2.0');
  assert.equal(f.gas.checkSetup().index, 'ready');
});

test('old invitation buttons during HR mode stay in the invitation flow and never reach Gemini', () => {
  for (const button of ['invite:cancel', 'invite:submit:' + 'b'.repeat(32), 'invite:skip:' + 'c'.repeat(32)]) {
    const f = setup();
    f.send('hr:start', true); f.send('AI 應用工程師');
    const before = f.ai().length;
    const reply = f.send(button, true);
    assert.equal(f.ai().length, before, button);
    assert.match(reply[0].text, /邀約/, button);
  }
});

const onlyCodes = (f, from) => f.state.logs.slice(from).every(line => /^\{"code":"[A-Z0-9_]+"\}$/.test(line));
function failedSubmit(f) {
  const from = f.state.logs.length;
  f.fill();
  const reply = f.send('hr:submit:' + f.draft().id, true);
  assert(!reply.some(m => m.type === 'flex' && /職缺證據熱圖/.test(m.altText)));
  assert.equal(f.draft().step, 3);
  assert(onlyCodes(f, from), JSON.stringify(f.state.logs.slice(from)));
  return reply;
}

test('missing index replies that the resume is being prepared and keeps the confirmation step', () => {
  const f = setup();
  f.fill();
  const id = f.draft().id;
  f.gas.clearIndex_();
  const before = f.ai().length;
  const reply = f.send('hr:submit:' + id, true);
  assert.match(reply[0].text, /履歷資料正在準備中/);
  assert.equal(f.ai().length, before);
  assert.equal(f.draft().step, 3);
});

test('resume changed before generation replies waiting for sync without calling Gemini', () => {
  const f = setup();
  f.fill();
  f.state.text = doc.replace('Gemini API', 'Gemini API 與 Vertex AI');
  const before = f.ai().length;
  const reply = f.send('hr:submit:' + f.draft().id, true);
  assert.match(reply[0].text, /等待同步/);
  assert.equal(f.ai().length, before);
  assert.equal(f.draft().step, 3);
});

test('Gemini HTTP error replies with the API explanation and keeps the confirmation step', () => {
  const reply = failedSubmit(setup(() => ({ status: 500, body: {} })));
  assert.match(reply[0].text, /HTTP 500/);
});

test('truncated Gemini output is logged as HR_REVIEW_INCOMPLETE and keeps the confirmation step', () => {
  const f = setup(() => ({ body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"skills":' }] } }] } }));
  failedSubmit(f);
  assert(f.state.logs.includes(JSON.stringify({ code: 'HR_REVIEW_INCOMPLETE' })));
});

test('confirmation card states that only the first 5 requirements are compared', () => {
  const f = setup();
  f.send('hr:start', true); f.send('資料工程師'); f.send('A,B,C,D');
  const confirmation = f.send('E、F');
  assert.match(confirmation[0].text, /只對照前 5 項/);
  assert.match(confirmation[0].text, /4\. D\n5\. ＋E/);
  assert(!/F/.test(confirmation[0].text.split('對照需求：')[1].split('（')[0]));
});
