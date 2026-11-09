// v3.2：經歷時間軸、成果拆解、轉給主管摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const doc = [
  '[[PUBLIC]]',
  '## 工作經歷一：AI 應用工程師（虛構測試資料）',
  '公司：禾序數位工作室（虛構公司）。',
  '任職期間：2024 年 7 月至 2026 年 9 月，共二年三個月。',
  '## 專案一：LINE 內部知識助理（虛構測試資料）',
  '問題：營運同仁需要在多份作業文件中反覆尋找答案。',
  '解法：以 Google Docs 作為知識來源，透過 Gemini 檢索並在 LINE 回答。',
  '成果：降低營運同仁查找文件的負擔。',
  '## 專業技能',
  '熟悉 Python 與 RAG，能建立 LINE Bot。',
  '## 學歷與學習',
  '就學期間：2018 年 9 月至 2022 年 6 月。',
  '[[/PUBLIC]]'
].join('\n');
const WORK_QUOTE = '任職期間：2024 年 7 月至 2026 年 9 月';
const candidate = value => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] } });
const props = call => call.body?.generationConfig?.responseSchema?.properties || {};
const isTimeline = call => Boolean(props(call).entries);
const isStar = call => Boolean(props(call).situation);
const isHr = call => Boolean(props(call).cells);
const isEmbed = call => /embedContent|batchEmbedContents/.test(call.url);
const goodTimeline = () => candidate({ entries: [
  { kind: 'work', title: 'AI 應用工程師｜禾序數位工作室', start: '2024-07', end: '2026-09', id: 'x', quote: WORK_QUOTE },
  { kind: 'work', title: '虛構的公司', start: '2020-01', end: '2021-01', id: 'x', quote: '任職期間：2020 年 1 月至 2021 年 1 月' },
  { kind: 'education', title: '學歷', start: '2018-09', end: '2022-06', id: 'x', quote: '就學期間：2018 年 9 月至 2022 年 6 月' }
] });
const goodStar = () => candidate({
  situation: { id: 'x', quote: '營運同仁需要在多份作業文件中反覆尋找答案' },
  task: { id: 'x', quote: '負責帶領十人團隊完成全部開發' },
  action: { id: 'x', quote: '以 Google Docs 作為知識來源，透過 Gemini 檢索並在 LINE 回答' },
  result: { id: 'x', quote: '降低營運同仁查找文件的負擔' }
});
const QUOTE = '熟悉 Python 與 RAG，能建立 LINE Bot';
const goodReview = () => candidate({ skills: ['Python 開發', 'LINE Bot'], cells: [
  { row: 0, col: 0, level: 'strong', id: 'x', quote: QUOTE },
  { row: 2, col: 1, level: 'related', id: 'x', quote: QUOTE }
], pending: [], interviewQuestions: ['請說明 RAG 檢索流程的設計。'] });

function setup({ text = doc, timeline = goodTimeline, star = goodStar, hr = goodReview } = {}) {
  const f = createGas({ text });
  f.state.response = call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    if (isTimeline(call)) return timeline(call);
    if (isStar(call)) return star(call);
    if (isHr(call)) return hr(call);
    return { body: {} };
  };
  assert.equal(f.gas.syncKnowledgeBase().status, 'ok');
  let n = 0;
  f.send = (value, post = false) => {
    const e = event(value, 'ins-' + (++n));
    if (post) { e.type = 'postback'; e.postback = { data: value }; }
    f.gas.handleEvent_(e, f.gas.config_());
    return f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  };
  f.draft = () => f.gas.hrReviewDraft_(f.gas.hrReviewKey_('user-1', f.gas.config_()));
  f.invite = () => f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_()));
  f.mark = () => f.state.calls.length;
  f.since = start => f.state.calls.slice(start);
  return f;
}
const flexText = message => JSON.stringify(message.contents);

test('Step 1 offers insight shortcuts', () => {
  const f = setup();
  const [prompt] = f.send('hr:start', true);
  assert.deepEqual(prompt.quickReply.items.map(i => i.action.data), ['hr:timeline', 'hr:star', 'hr:cancel']);
  assert.match(prompt.text, /經歷時間軸/);
});

test('Insight command keeps the HR draft', () => {
  const f = setup();
  f.send('hr:start', true);
  f.send('AI 應用工程師');
  const reply = f.send('經歷時間軸');
  assert.equal(reply[0].type, 'flex');
  assert.match(reply[0].altText, /經歷時間軸/);
  assert.equal(f.draft().step, 1);
  assert.equal(f.draft().fields.role, 'AI 應用工程師');
});

test('Timeline from verified dates: invented entries dropped, one generation and no embedding, nothing cached', () => {
  const f = setup();
  const start = f.mark();
  const [flex, detail] = f.send('hr:timeline', true);
  const calls = f.since(start);
  assert.equal(calls.filter(isTimeline).length, 1);
  assert.equal(calls.filter(isEmbed).length, 0);
  const body = flexText(flex);
  assert(body.includes('2024/07–2026/09'));
  assert(body.includes('2018/09–2022/06'));
  assert(!body.includes('虛構的公司'));
  assert(body.includes('空窗、重疊或短期任職可能有正當原因，只是面談時可確認的提示，不是評價。'));
  assert(JSON.stringify(flex).length < 30000);
  // 學歷 2022/06 到工作 2024/07 間隔 24 個月，程式算出空窗並給中性問題。
  assert.match(detail.text, /空窗約 24 個月：2022\/07–2024\/06/);
  assert.match(detail.text, /不需說明個人原因/);
  assert.match(detail.text, /資料來源：/);
  assert.equal(detail.quickReply.items[0].action.data, 'hr:star');
  const rules = calls.find(isTimeline).body.systemInstruction.parts[0].text;
  for (const rule of ['不可信資料', '性別', '國籍', '連續原文']) assert(rules.includes(rule), rule);
  assert(![...f.state.cache.values()].some(v => String(v).includes('2024/07')));
});

test('Month not present in quote, missing 至今 wording, and invented titles', () => {
  const { gas } = createGas();
  const chunks = [{ id: 'a', section: '工作經歷一：AI 應用工程師（虛構測試資料）', text: WORK_QUOTE + '。\n專案期間：2025 年 3 月迄今。' }];
  const now = 2026 * 12 + 10;
  const run = entry => JSON.parse(JSON.stringify(gas.validateHrTimeline_({ entries: [{ kind: 'work', title: 'AI 應用工程師', id: 'a', ...entry }] }, chunks, now)));
  assert.equal(run({ start: '2024-08', end: '2026-09', quote: WORK_QUOTE }).length, 0);
  assert.equal(run({ start: '2024-07', end: '2026-10', quote: WORK_QUOTE }).length, 0);
  assert.equal(run({ start: '2024-07', end: 'present', quote: WORK_QUOTE }).length, 0);
  assert.equal(run({ start: '2026-09', end: '2024-07', quote: WORK_QUOTE }).length, 0);
  const ok = run({ start: '2024-07', end: '2026-09', quote: WORK_QUOTE });
  assert.deepEqual([ok[0].from, ok[0].to, ok[0].precise], [2024 * 12 + 6, 2026 * 12 + 8, true]);
  const present = run({ start: '2025-03', end: 'present', quote: '專案期間：2025 年 3 月迄今' });
  assert.deepEqual([present[0].to, present[0].present], [now, true]);
  assert.equal(run({ title: '某知名大公司', start: '2024-07', end: '2026-09', quote: WORK_QUOTE })[0].title, 'AI 應用工程師');
  assert.throws(() => gas.validateHrTimeline_({}, chunks, now), /HR_TIMELINE_INVALID_FORMAT/);
});

test('No dated chunks replies without calling Gemini', () => {
  const f = setup({ text: '[[PUBLIC]]\n## 專業技能\n熟悉 Python 與 SQL。\n[[/PUBLIC]]' });
  const start = f.mark();
  assert.equal(f.send('時間軸')[0].text, '履歷中沒有找到可整理成時間軸的日期。');
  assert.equal(f.since(start).filter(c => c.url.includes('generativelanguage')).length, 0);
});

test('No verifiable entry and invalid format', () => {
  const none = setup({ timeline: () => candidate({ entries: [{ kind: 'work', title: 'x', start: '2010-01', end: '2011-01', quote: '2010 年 1 月至 2011 年 1 月' }] }) });
  assert.equal(none.send('hr:timeline', true)[0].text, '沒能從履歷整理出可核對的經歷期間。');
  const bad = setup({ timeline: () => candidate({ wrong: true }) });
  assert.match(bad.send('hr:timeline', true)[0].text, /未能整理出經歷時間軸/);
  assert(bad.state.logs.includes(JSON.stringify({ code: 'HR_TIMELINE_INVALID_FORMAT' })));
});

test('Compute flags follows the spec flag cases', () => {
  const { gas } = createGas();
  const now = 2026 * 12 + 10;
  const parse = value => {
    if (value === 'present') return { index: now, present: true, month: true };
    const [y, m] = value.split('-').map(Number);
    return { y, m };
  };
  const entry = (kind, s, e) => {
    const a = parse(s), b = parse(e);
    return { kind, title: kind + s, from: a.y * 12 + (a.m ? a.m - 1 : 0), to: b.present ? now : b.y * 12 + (b.m ? b.m - 1 : 11),
      present: !!b.present, precise: !!a.m && (!!b.present || !!b.m) };
  };
  const flags = entries => JSON.parse(JSON.stringify(gas.hrTimelineFlags_(entries)))
    .map(f => f.type + ' ' + gas.hrFlagRange_(f) + ' ' + f.months);
  assert.deepEqual(flags([entry('education', '2018-09', '2022-06'), entry('work', '2022-07', '2024-06'), entry('work', '2024-07', '2026-09')]), []);
  assert.deepEqual(flags([entry('education', '2018-09', '2020-06'), entry('work', '2021-03', '2023-02')]), ['gap 2020/07–2021/02 8']);
  assert.deepEqual(flags([entry('work', '2020-01', '2020-06'), entry('work', '2020-06', '2022-01')]), ['overlap 2020/06 1', 'short 2020/01–2020/06 6']);
  assert.deepEqual(flags([entry('work', '2019', '2019'), entry('work', '2021', '2022')]), ['gap 2020/01–2020/12 12']);
  assert.deepEqual(flags([entry('work', '2025-03', 'present')]), []);
  // 專案不算空窗；沒有疑點時的說明文字。
  const [, detail] = gas.hrTimelineMessages_([{ ...entry('work', '2025-03', 'present'), section: 'A' }], []);
  assert.match(detail.text, /未發現超過 6 個月的空窗、時間重疊或不滿 12 個月的任職。/);
});

test('Pick a project lists only project or experience sections with clean labels', () => {
  const f = setup();
  const [picker] = f.send('成果拆解');
  const labels = picker.quickReply.items.map(i => i.action.label);
  assert.deepEqual(labels, ['AI 應用工程師', 'LINE 內部知識助理']);
  assert(picker.quickReply.items.every(i => /^hr:star:[a-f0-9]{16}$/.test(i.action.data)));
  const none = setup({ text: '[[PUBLIC]]\n## 專業技能\n熟悉 Python 與 SQL。\n[[/PUBLIC]]' });
  assert.equal(none.send('hr:star', true)[0].text, '履歷中沒有找到專案或經歷段落。');
});

test('Missing and unverified parts: 履歷未提及, follow-up questions, 成果未量化', () => {
  const f = setup();
  const [picker] = f.send('hr:star', true);
  const data = picker.quickReply.items.find(i => i.action.label === 'LINE 內部知識助理').action.data;
  const start = f.mark();
  const [card, detail] = f.send(data, true);
  const calls = f.since(start);
  assert.equal(calls.filter(isStar).length, 1);
  assert.equal(calls.filter(isEmbed).length, 0);
  const body = flexText(card);
  assert.equal(body.split('履歷未提及').length - 1, 1);
  assert(!body.includes('帶領十人團隊'));
  assert(body.includes('成果未量化'));
  assert(body.includes('營運同仁需要在多份作業文件中反覆尋找答案'));
  assert.match(detail.text, /本人在這個專案中負責的目標或範圍是什麼？/);
  assert.match(detail.text, /成果可以用哪些數據說明？/);
  assert.match(detail.text, /資料來源：專案一：LINE 內部知識助理/);
  assert.equal(detail.quickReply.items[0].action.data, 'hr:star');
});

test('quantified results and unknown or invalid STAR requests', () => {
  const { gas } = createGas();
  const chunks = [{ id: 'a', section: 'P', text: '平均查找時間由六分鐘降為兩分鐘。錯誤率由 3% 降為 0.6%。降低負擔。' }];
  assert.equal(gas.validateHrStar_({ result: { quote: '平均查找時間由六分鐘降為兩分鐘' } }, chunks).unquantified, false);
  assert.equal(gas.validateHrStar_({ result: { quote: '錯誤率由 3% 降為 0.6%' } }, chunks).unquantified, false);
  assert.equal(gas.validateHrStar_({ result: { quote: '降低負擔' } }, chunks).unquantified, true);
  assert.throws(() => gas.validateHrStar_(null, chunks), /HR_STAR_INVALID_FORMAT/);
  const f = setup({ star: () => candidate([]) });
  assert.equal(f.send('hr:star:0123456789abcdef', true)[0].text, '這個專案已不在目前的履歷中，請重新選擇「成果拆解」。');
  const data = f.send('hr:star', true)[0].quickReply.items[0].action.data;
  assert.match(f.send(data, true)[0].text, /未能拆解這個專案/);
  assert(f.state.logs.includes(JSON.stringify({ code: 'HR_STAR_INVALID_FORMAT' })));
});

test('insight commands wait for sync when the resume changed after indexing', () => {
  const f = setup();
  f.state.text = f.state.text.replace('熟悉 Python', '熟悉 Go 與 Python');
  const start = f.mark();
  assert.match(f.send('hr:timeline', true)[0].text, /等待同步/);
  assert.match(f.send('hr:star', true)[0].text, /等待同步/);
  assert.equal(f.since(start).filter(c => c.url.includes('generativelanguage')).length, 0);
});

test('insight commands clear an unfinished invitation draft', () => {
  const f = setup();
  f.send('invite:start', true);
  assert(f.invite());
  f.send('經歷時間軸');
  assert.equal(f.invite(), null);
});

test('Forward after analysis: summary without AI, draft kept for 帶入邀約', () => {
  const f = setup();
  f.send('hr:start', true); f.send('AI 應用工程師'); f.send('Python、RAG、LINE Bot');
  f.send('hr:skip:' + f.draft().id, true);
  const id = f.draft().id;
  const result = f.send('hr:submit:' + id, true);
  const detail = result.find(m => m.text && m.text.startsWith('待確認條件'));
  assert.deepEqual(detail.quickReply.items.slice(0, 2).map(i => i.action.data), ['hr:invite:' + id, 'hr:forward:' + id]);
  assert.match(detail.text, /轉給主管/);
  assert.equal(JSON.stringify(f.draft().fields), '{}');
  const start = f.mark();
  const forward = f.send('hr:forward:' + id, true);
  assert.equal(forward[0].text, '以下摘要可長按複製，轉傳給用人主管：');
  const summary = forward[1].text;
  assert(summary.startsWith('【履歷對照摘要】AI 應用工程師'));
  assert.match(summary, /有依據：Python（明確證據）、LINE Bot（相關經驗）/);
  assert.match(summary, /待確認：RAG/);
  assert.match(summary, /建議面談：請說明 RAG 檢索流程的設計。/);
  assert.match(summary, /※ 依公開履歷證據整理，不是錄取分數。$/);
  assert(Array.from(summary).length <= 300);
  assert.equal(f.since(start).filter(c => c.url.includes('generativelanguage')).length, 0);
  assert.match(f.send('hr:invite:' + id, true)[0].text, /邀約/);
  assert.match(f.send('hr:forward:' + id, true)[0].text, /已過期/);
  assert.match(f.send('hr:forward:' + 'f'.repeat(32), true)[0].text, /這份人資對照結果已過期。可以重新進行「人資模式」。/);
});

test('Long lists are shortened to at most 300 characters', () => {
  const { gas } = createGas();
  const label = n => (n + '號需求').padEnd(60, '長');
  const requirements = [0, 1, 2, 3, 4].map(n => ({ label: label(n), kind: 'required' }));
  const summary = gas.hrForwardText_('職'.repeat(50), requirements, {
    grid: requirements.map(() => ['strong']), pending: [5, 6, 7, 8, 9, 10, 11, 12].map(label),
    interviewQuestions: ['問'.repeat(80)], sections: ['專案作品', '技能']
  });
  assert(Array.from(summary).length <= 300, String(Array.from(summary).length));
  assert.match(summary, /等 \d+ 項/);
  assert.match(summary, /^【履歷對照摘要】/);
  assert.match(summary, /※ 依公開履歷證據整理，不是錄取分數。$/);
  const empty = gas.hrForwardText_('PM', [{ label: 'SQL', kind: 'required' }], { grid: [[]], pending: ['SQL'], interviewQuestions: [], sections: [] });
  assert.equal(empty, '【履歷對照摘要】PM\n有依據：無\n待確認：SQL\n※ 依公開履歷證據整理，不是錄取分數。');
});

test('Privacy and help text describe the new commands', () => {
  const f = setup();
  const privacy = f.send('隱私')[0].text;
  assert.match(privacy, /轉給主管/);
  assert.match(privacy, /經歷時間軸/);
  assert.match(privacy, /人資模式填寫的職位與條件會交給 Google Gemini/);
  assert.match(privacy, /邀約填寫內容不交給 AI/);
  const help = f.send('說明')[0].text;
  for (const word of ['經歷時間軸', '成果拆解', '轉給主管']) assert(help.includes(word), word);
});
