import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const jsonResponse = value => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
function setup() {
  const fixture = createGas();
  const { gas } = fixture;
  const index = { fingerprint: 'fresh', chunks: [{ id: 'S1', section: '專案', text: '使用 Python 建立資料分析報表。', vector: unitVector() }] };
  gas.loadIndex_ = () => index;
  gas.readPublicSource_ = () => ({ fingerprint: 'fresh' });
  gas.embedQuery_ = () => unitVector();
  gas.geminiRequest_ = (model, method, body) => {
    const input = JSON.parse(body.contents[0].parts[0].text);
    return jsonResponse(input.job ? { overflow: false, requirements: [{ quote: 'Python 經驗', priority: '必要' }] }
      : { evidence: [{ id: 'S1', quote: '使用 Python 建立資料分析報表' }] });
  };
  return { ...fixture, cfg: gas.config_() };
}
function postback(data, id = 'click') {
  return { ...event('', id), type: 'postback', postback: { data } };
}
function submit(fixture) {
  return fixture.gas.handleJobMatch_(event(), '職缺內容\nPython 經驗', fixture.cfg)[0];
}

test('confirm original requirements, validate citations, replay without another model call', () => {
  const f = setup(), card = submit(f);
  assert.match(card.text, /未指定/);
  const data = card.quickReply.items[0].action.data;
  const result = f.gas.handleJobMatch_(postback(data), data, f.cfg);
  assert.match(result[0].text, /使用 Python 建立資料分析報表/);
  assert.match(result[0].text, /面試追問/);
  f.gas.geminiRequest_ = () => { throw new Error('unexpected regeneration'); };
  assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /使用 Python/);
  assert.equal(f.state.documentWrites, 0);
});

test('old buttons, isolated visitors and evicted drafts cannot produce a result', () => {
  const f = setup(), data = submit(f).quickReply.items[0].action.data;
  const other = postback(data); other.source.userId = 'other';
  assert.match(f.gas.handleJobMatch_(other, data, f.cfg)[0].text, /過期/);
  submit(f);
  assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /取代/);
  f.state.cache.clear();
  assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /過期/);
});

test('reject fabricated citations and preserve draft for retry', () => {
  const f = setup(), data = submit(f).quickReply.items[0].action.data;
  f.gas.geminiRequest_ = () => jsonResponse({ evidence: [{ id: 'fake', quote: '使用 Python 建立資料分析報表' }] });
  assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /來源檢查/);
  assert.equal(f.gas.jobRead_(f.gas.jobKey_('user-1', f.cfg)).results.length, 0);
  f.gas.geminiRequest_ = () => { throw new Error('GEMINI_HTTP_429'); };
  assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /429/);
  assert.equal(f.state.documentWrites, 0);
});

test('changed source before or during generation discards stale evidence', () => {
  for (const during of [false, true]) {
    const f = setup(), data = submit(f).quickReply.items[0].action.data;
    let reads = 0;
    f.gas.readPublicSource_ = () => ({ fingerprint: during && reads++ === 0 ? 'fresh' : 'changed' });
    assert.match(f.gas.handleJobMatch_(postback(data), data, f.cfg)[0].text, /更新|同步/);
    assert.equal(f.gas.jobRead_(f.gas.jobKey_('user-1', f.cfg)), null);
  }
});

test('long jobs use the normal webhook without entering general RAG or feedback', () => {
  const f = setup();
  f.gas.answerLineConversation_ = () => { throw new Error('must not enter general RAG'); };
  let reply;
  f.gas.lineReply_ = (token, messages) => { reply = messages; return 'replied'; };
  assert.equal(f.gas.handleEvent_(event('職缺內容\n' + '職缺介紹'.repeat(220) + '\nPython 經驗'), f.cfg), 'replied');
  assert.match(reply[0].text, /請確認/);
  assert.equal(f.state.documentWrites, 0);
  f.gas.handleEvent_(event('職缺內容\n' + '字'.repeat(4001), 'too-long'), f.cfg);
  assert.match(reply[0].text, /4000/);
});

test('requirement validation rejects invented or truncated conditions', () => {
  const f = setup();
  f.gas.geminiRequest_ = () => jsonResponse({ overflow: false, requirements: [{ quote: '不存在的條件', priority: '必要' }] });
  assert.throws(() => f.gas.jobRequirements_('Python 經驗', f.cfg), /INVALID_FORMAT/);
  f.gas.geminiRequest_ = () => jsonResponse({ overflow: true, requirements: [] });
  assert.throws(() => f.gas.jobRequirements_('Python 經驗', f.cfg), /JOB_TOO_MANY/);
});

test('combined command and job template enter confirmation instead of general RAG', () => {
  const f = setup();
  f.gas.answerLineConversation_ = () => { throw new Error('job must not enter general RAG'); };
  let reply;
  f.gas.lineReply_ = (token, messages) => { reply = messages; return 'replied'; };
  f.gas.handleEvent_(event('職缺對照\n職缺內容\nPython 經驗'), f.cfg);
  assert.match(reply[0].text, /請確認/);
  assert.ok(reply[0].quickReply.items[0].action.data.startsWith('job:item:'));
  assert.equal(f.state.documentWrites, 0);
});
