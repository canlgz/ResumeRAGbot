// v3.1：貼職缺說明、確認卡刪改、逐項對照、帶入邀約。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const doc = '[[PUBLIC]]\n## 專案作品\n使用 Python 與 RAG 建立 LINE Bot 履歷助理，負責檢索與回覆流程。\n## 技能\n熟悉 Google Apps Script 與 Gemini API。\n[[/PUBLIC]]';
const QUOTE = '使用 Python 與 RAG 建立 LINE Bot 履歷助理';
const isHr = call => Boolean(call.body?.generationConfig?.responseSchema?.properties?.cells);
const isJd = call => Boolean(call.body?.generationConfig?.responseSchema?.properties?.items);
const candidate = value => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] } });
const goodReview = {
  skills: ['Python 開發', 'LINE Bot'],
  cells: [
    { row: 0, col: 0, level: 'strong', id: 'x', quote: QUOTE },
    { row: 1, col: 0, level: 'related', id: 'x', quote: QUOTE },
    { row: 2, col: 1, level: 'strong', id: 'x', quote: QUOTE }
  ],
  pending: [],
  interviewQuestions: ['請說明 RAG 檢索流程的設計。']
};
const JD = '職缺說明：\n熟悉 Python 與 RAG 檢索。\n具備簡報 能力者佳。\n性別不拘，歡迎應屆畢業生。';
const goodJd = () => candidate({ items: [
  { label: 'Python', kind: 'required', quote: '熟悉 Python 與 RAG' },
  { label: 'Kubernetes', kind: 'required', quote: '精通 Kubernetes 叢集維運' },
  { label: '性別不拘', kind: 'required', quote: '性別不拘' },
  { label: '簡報、溝通', kind: 'bonus', quote: '具備簡報能力' }
] });

function setup({ hr = () => candidate(goodReview), jd = goodJd } = {}) {
  const f = createGas({ text: doc });
  f.state.response = call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    if (isHr(call)) return hr(call);
    if (isJd(call)) return jd(call);
    return { body: {} };
  };
  assert.equal(f.gas.syncKnowledgeBase().status, 'ok');
  let n = 0;
  f.send = (text, post = false) => {
    const e = event(text, 'ext-' + (++n));
    if (post) { e.type = 'postback'; e.postback = { data: text }; }
    f.gas.handleEvent_(e, f.gas.config_());
    return f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  };
  f.draft = () => f.gas.hrReviewDraft_(f.gas.hrReviewKey_('user-1', f.gas.config_()));
  f.invite = () => f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_()));
  f.records = () => f.gas.loadPortfolioStore_(f.gas.config_()).invitations || {};
  f.fill = () => { f.send('hr:start', true); f.send('AI 應用工程師'); f.send('Python、RAG、LINE Bot'); return f.send('hr:skip:' + f.draft().id, true); };
  f.toJd = () => { f.send('hr:start', true); f.send('AI 應用工程師'); return f.send('hr:jd:' + f.draft().id, true); };
  f.ai = () => f.state.calls.filter(c => c.url.includes('generativelanguage'));
  return f;
}

test('step 2 offers 貼職缺說明 while step 1 offers insight shortcuts and 取消', () => {
  const f = setup();
  assert.deepEqual(f.send('hr:start', true)[0].quickReply.items.map(i => i.action.data), ['hr:timeline', 'hr:star', 'hr:cancel']);
  const step2 = f.send('AI 應用工程師')[0];
  assert.deepEqual(step2.quickReply.items.map(i => i.action.data), ['hr:jd:' + f.draft().id, 'hr:cancel']);
  assert.match(step2.text, /貼職缺說明/);
});

test('Extract verified requirements from a pasted job description', () => {
  const f = setup();
  const prompt = f.toJd();
  assert.match(prompt[0].text, /貼職缺說明/);
  assert.match(prompt[0].text, /不保存原文/);
  assert.deepEqual(prompt[0].quickReply.items.map(i => i.action.data), ['hr:manual:' + f.draft().id, 'hr:cancel']);
  const before = f.state.calls.length;
  const confirmation = f.send(JD);
  const calls = f.state.calls.slice(before);
  assert.equal(calls.filter(isJd).length, 1);
  assert.equal(calls.filter(c => /embedContent|batchEmbedContents/.test(c.url)).length, 0);
  const rules = calls.find(isJd).body.systemInstruction.parts[0].text;
  for (const rule of ['不可信資料', '性別', '國籍', '連續的原文']) assert(rules.includes(rule), rule);
  assert.match(confirmation[0].text, /1\. Python\n2\. ＋簡報／溝通\n/);
  assert.match(confirmation[0].text, /1 項在原文中找不到/);
  assert.match(confirmation[0].text, /1 項與工作無關/);
  const listed = confirmation[0].text.split('對照需求：')[1].split('以上需求')[0];
  assert(!/Kubernetes|性別不拘/.test(listed));
  assert.equal(f.draft().step, 3);
  // 職缺說明原文不留在任何快取或記錄中。
  assert(![...f.state.cache.values()].some(v => String(v).includes('歡迎應屆畢業生')));
  assert(!JSON.stringify(f.state.logs).includes('歡迎應屆畢業生'));
  // 之後照常對照。
  assert(f.send('hr:submit:' + f.draft().id, true).some(m => m.type === 'flex' && /職缺證據熱圖/.test(m.altText)));
});

test('validateHrExtraction_ ignores whitespace in quotes, replaces separators and rejects bad formats', () => {
  const { gas } = createGas();
  const r = gas.validateHrExtraction_({ items: [
    { label: 'SQL、資料庫', kind: 'required', quote: 'S Q L' },
    { label: 'SQL、資料庫', kind: 'required', quote: 'SQL' },
    { label: '年齡 35 歲以下', kind: 'required', quote: '35 歲以下' },
    { label: '英文', kind: 'other', quote: '英文' },
    { label: 7, kind: 'required', quote: 'x' }
  ] }, 'SQL 資料庫經驗，35 歲以下，英文佳');
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { items: [{ label: 'SQL／資料庫', kind: 'required' }, { label: '英文', kind: 'required' }], unverified: 1, excluded: 1 });
  assert.throws(() => gas.validateHrExtraction_({}, 'x'), /HR_JD_INVALID_FORMAT/);
});

test('Nothing extractable switches back to manual input', () => {
  const f = setup({ jd: () => candidate({ items: [{ label: 'Go', kind: 'required', quote: '五年以上 Go 經驗' }] }) });
  f.toJd();
  const reply = f.send(JD);
  assert.match(reply[0].text, /沒能從職缺說明找到/);
  assert.match(reply[0].text, /人資模式 2 \/ 3/);
  assert.equal(f.draft().step, 1);
  assert.equal(Boolean(f.draft().jd), false);
});

test('over-length JD makes no AI call; invalid format keeps the JD step; 改為逐項輸入 returns to manual', () => {
  const f = setup({ jd: () => candidate({ wrong: true }) });
  f.toJd();
  const before = f.ai().length;
  assert.match(f.send('字'.repeat(2001))[0].text, /2000 字內/);
  assert.equal(f.ai().length, before);
  const bad = f.send(JD);
  assert.match(bad[0].text, /未能從職缺說明拆出需求/);
  assert.equal(bad[0].quickReply.items[0].action.data, 'hr:manual:' + f.draft().id);
  assert(f.state.logs.includes(JSON.stringify({ code: 'HR_JD_INVALID_FORMAT' })));
  assert.equal(f.draft().jd, true);
  assert.match(f.send('hr:manual:' + f.draft().id, true)[0].text, /請輸入必要技能或條件/);
  assert.equal(Boolean(f.draft().jd), false);
});

test('Remove one requirement from the confirmation card; removing all returns to step 2', () => {
  const f = setup();
  f.fill();
  const id = f.draft().id;
  const card = f.send('hr:drop:' + id + ':1', true);
  assert.match(card[0].text, /1\. Python\n2\. LINE Bot\n/);
  f.send('hr:drop:' + id + ':0', true);
  const last = f.send('hr:drop:' + id + ':0', true);
  assert.match(last[0].text, /已移除全部需求/);
  assert.match(last[0].text, /人資模式 2 \/ 3/);
  assert.equal(f.draft().step, 1);
});

test('a removed item lets the sixth requirement move into the first five', () => {
  const f = setup();
  f.send('hr:start', true); f.send('資料工程師'); f.send('A,B,C,D');
  f.send('E、F');
  const card = f.send('hr:drop:' + f.draft().id + ':0', true);
  assert.match(card[0].text, /1\. B\n2\. C\n3\. D\n4\. ＋E\n5\. ＋F/);
  assert(!/只對照前 5 項/.test(card[0].text));
});

test('Edit requirements shows the current value and keeps it on 沿用目前', () => {
  const f = setup();
  f.fill();
  const id = f.draft().id;
  const prompt = f.send('hr:edit:' + id, true);
  assert.match(prompt[0].text, /目前內容：\nPython、RAG、LINE Bot/);
  assert.equal(prompt[0].quickReply.items[0].action.data, 'hr:keep:' + id);
  assert.match(f.send('hr:keep:' + id, true)[0].text, /人資模式 3 \/ 3/);
  const confirmation = f.send('簡報');
  assert.match(confirmation[0].text, /3\. LINE Bot\n4\. ＋簡報/);
});

test('Deep comparison: one batch embedding with one query per requirement and one generation', () => {
  const f = setup();
  f.fill();
  const before = f.state.calls.length;
  const reply = f.send('hr:deep:' + f.draft().id, true);
  const calls = f.state.calls.slice(before);
  const batches = calls.filter(c => c.url.endsWith(':batchEmbedContents'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].body.requests.length, 3);
  assert(batches[0].body.requests.every(r => r.taskType === 'RETRIEVAL_QUERY'));
  assert.equal(calls.filter(c => c.url.endsWith(':embedContent')).length, 0);
  assert.equal(calls.filter(isHr).length, 1);
  const evidence = JSON.parse(calls.find(isHr).body.contents[0].parts[0].text).evidence;
  assert(evidence.length > 0 && evidence.length <= 12);
  assert(evidence.every(e => Array.isArray(e.rows) && e.rows.length));
  assert.equal(new Set(evidence.map(e => e.id)).size, evidence.length);
  assert.match(reply[0].text, /逐項檢索/);
  assert(reply.some(m => m.type === 'flex'));
});

test('deep comparison with a single requirement behaves like the normal comparison', () => {
  const f = setup();
  f.send('hr:start', true); f.send('AI 應用工程師'); f.send('Python');
  f.send('hr:skip:' + f.draft().id, true);
  const before = f.state.calls.length;
  const reply = f.send('hr:deep:' + f.draft().id, true);
  const calls = f.state.calls.slice(before);
  assert.equal(calls.filter(c => c.url.endsWith(':embedContent')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith(':batchEmbedContents')).length, 0);
  assert(!/逐項檢索/.test(reply[0].text));
});

test('mergeHrHits_ interleaves per-requirement hits, removes duplicates and records rows', () => {
  const { gas } = createGas();
  const merged = gas.mergeHrHits_([[{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'c' }], [{ id: 'd' }]], 3);
  assert.deepEqual([...merged.map(h => h.id)], ['a', 'd', 'b']);
  assert.deepEqual([...merged[0].rows], [0, 1]);
});

test('Carry pending conditions into an invitation that is saved only after confirmation', () => {
  const f = setup({ hr: () => candidate({ ...goodReview, pending: ['團隊帶領經驗'] }) });
  f.fill();
  const id = f.draft().id;
  const result = f.send('hr:submit:' + id, true);
  assert.equal(result[2].quickReply.items[0].action.data, 'hr:invite:' + id);
  assert.equal(result[2].quickReply.items.at(-1).action.data, 'hr:start');
  assert.match(result[2].text, /帶入邀約/);
  const first = f.send('hr:invite:' + id, true);
  assert.match(first[0].text, /留下邀約 1 \/ 4/);
  assert.match(first[0].text, /第 2 題帶入/);
  assert.equal(f.draft(), null);
  const second = f.send('某公司／王小姐');
  assert.match(second[0].text, /應徵職位：AI 應用工程師/);
  assert.match(second[0].text, /• 團隊帶領經驗/);
  const inviteId = f.invite().id;
  assert.equal(second[0].quickReply.items[0].action.data, 'invite:carry:' + inviteId);
  f.send('invite:carry:' + inviteId, true);
  f.send('hr@company.example.org');
  f.send('invite:skip:' + inviteId, true);
  assert.equal(Object.keys(f.records()).length, 0);
  f.send('invite:submit:' + inviteId, true);
  const saved = f.records()[inviteId];
  assert.match(saved.fields.message, /AI 應用工程師/);
  assert.match(saved.fields.message, /團隊帶領經驗/);
  assert.equal(f.state.calls.filter(isHr).length, 1);
});

test('carried text plus a supplement is joined; restart keeps the carry; stale invite ids expire', () => {
  const f = setup();
  f.fill();
  const id = f.draft().id;
  f.send('hr:submit:' + id, true);
  f.send('hr:invite:' + id, true);
  f.send('invite:restart:' + f.invite().id, true);
  assert(f.invite().carry);
  f.send('某公司');
  f.send('希望下週面談');
  assert.match(f.invite().fields.message, /^應徵職位：AI 應用工程師[\s\S]*\n\n補充：希望下週面談$/);
  assert.match(f.send('hr:invite:' + id, true)[0].text, /已過期/);
  const g = setup();
  g.fill();
  assert.match(g.send('hr:invite:' + g.draft().id, true)[0].text, /已過期/);
  // 一般的「留下邀約」不帶入任何內容。
  const h = setup();
  h.send('invite:start', true);
  assert.equal(h.invite().carry, undefined);
});

test('Redelivered 帶入邀約 event returns the same prompt and keeps the new invitation draft', () => {
  const f = setup();
  f.fill();
  const id = f.draft().id;
  f.send('hr:submit:' + id, true);
  const e = event('hr:invite:' + id, 'dup-invite');
  e.type = 'postback'; e.postback = { data: e.message.text };
  const cfg = f.gas.config_();
  const run = () => f.gas.handleContact_(e, e.postback.data, cfg, null) || f.gas.handleHrReview_(e, e.postback.data, cfg, null);
  const first = run(), second = run();
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert(f.invite());
});

test('confirmation card with long labels stays within LINE limits', () => {
  const f = setup();
  f.send('hr:start', true); f.send('職'.repeat(50));
  f.send(Array.from({ length: 5 }, (_, i) => '非常長的需求名稱'.repeat(5) + i).join('、'));
  const card = f.send('hr:skip:' + f.draft().id, true)[1];
  const buttons = card.contents.body.contents.filter(c => c.type === 'button');
  assert(buttons.every(b => Array.from(b.action.label).length <= 20));
  assert(buttons.every(b => b.action.data.length <= 300));
  assert(JSON.stringify(card).length < 30000);
});
