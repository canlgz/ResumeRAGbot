import { createGas, event, unitVector } from './harness.mjs';
import { png } from './portfolio-fixture.mjs';

export const resume = '[[PUBLIC]]\n## 專業技能\nPython、SQL 資料分析。\n## 專案作品\n以 Python 建立銷售報表自動化，處理時間縮短 20%。\n[[/PUBLIC]]';
export const jd = '職稱：資料分析師\n必要：熟悉 Python\n必要：具 SQL 經驗\n加分：Tableau\n年齡 25 歲以下';

export const defaultCriteria = { title: '資料分析師', excluded: ['年齡 25 歲以下'], criteria: [
  { text: '熟悉 Python', level: 'must', quote: '必要：熟悉 Python' },
  { text: '具 SQL 經驗', level: 'must', quote: '必要：具 SQL 經驗' },
  { text: 'Tableau', level: 'plus', quote: '加分：Tableau' }] };
export const defaultResults = { results: [
  { id: 'C1', status: 'supported', evidence: [{ chunkId: 'x', quote: '以 Python 建立銷售報表自動化' }], note: '有 Python 專案', question: '' },
  { id: 'C2', status: 'partial', evidence: [{ chunkId: 'x', quote: 'Python、SQL 資料分析' }], note: '只列技能', question: '請說明使用 SQL 的專案。' },
  { id: 'C3', status: 'unconfirmed', evidence: [], note: '履歷未提及', question: '' }] };

export const candidate = value => ({ body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] } });

/** 建立已同步的測試履歷；Gemini 依 schema 根屬性分辨呼叫。 */
export function jobFixture(options = {}) {
  const f = createGas({ text: options.text ?? resume, properties: options.properties, response: call => {
    if (options.response) { const custom = options.response(call); if (custom) return custom; }
    if (call.url.includes('api-data.line.me')) return { status: 200, mime: 'image/png', bytes: png() };
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    if (call.url.endsWith(':generateContent')) {
      const props = call.body?.generationConfig?.responseSchema?.properties || {};
      if (props.criteria) return candidate(options.criteria ?? defaultCriteria);
      if (props.results) return candidate(options.results ?? defaultResults);
      if (props.jobText) return candidate(options.jobText ?? { status: 'readable', jobText: '必要：熟悉 Python' });
      return candidate({ grounded: true, answer: 'Python、SQL 資料分析。', evidence: [{ id: 'S1', quote: 'Python、SQL 資料分析' }] });
    }
    return { body: {} };
  } });
  f.gas.syncKnowledgeBase();
  f.state.calls.length = 0;
  let n = 0;
  const send = (text, opts = {}) => {
    const e = event(text, opts.id || 'jm-' + (++n));
    e.source.userId = opts.user || 'user-1';
    if (opts.postback) { e.type = 'postback'; e.postback = { data: text }; delete e.message; }
    if (opts.image) e.message = { type: 'image', id: 'img-' + n };
    f.gas.handleEvent_(e, f.gas.config_());
    const reply = f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1);
    return reply ? reply.body.messages : [];
  };
  const draft = (user = 'user-1') => f.gas.readJobMatchDraft_(f.gas.jobMatchKey_(user, f.gas.config_()));
  return { ...f, send, draft };
}

/** 已完成輸入、停在確認卡的狀態。 */
export function readyToRun(options) {
  const f = jobFixture(options);
  f.send('jm:start', { postback: true }); f.send(jd);
  f.send('jm:done:' + f.draft().id, { postback: true });
  return f;
}
