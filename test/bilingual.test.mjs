import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const input = events => ({ parameter: { key: 'a'.repeat(64) }, postData: { contents: JSON.stringify({ events }) } });

// 模擬 Gemini：記錄每次生成請求，依 answerLanguage 回傳中文或英文答案；引用一律是中文原文。
function setup(options = {}) {
  const generated = [];
  const fixture = createGas({
    text: '[[PUBLIC]]\n## 專案作品\n建立資料分析報表。\n[[/PUBLIC]]',
    response(call) {
      if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
      if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
      if (call.url.endsWith(':generateContent')) {
        const payload = JSON.parse(call.body.contents[0].parts[0].text);
        generated.push(payload);
        if (options.missing) return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
          grounded: false, answer: '目前公開履歷未提供這項資訊', evidence: [], dialogueIntent: 'neutral' }) }] } }] } };
        const english = payload.conversation?.answerLanguage === 'en';
        return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
          grounded: true, answer: english ? 'I built data analysis reports.' : '我建立過資料分析報表。',
          evidence: [{ id: 'S1', quote: '建立資料分析報表' }], dialogueIntent: 'capability' }) }] } }] } };
      }
      return { body: {} };
    }
  });
  fixture.gas.syncKnowledgeBase();
  fixture.state.calls.length = 0;
  const send = (text, id, postback) => {
    const e = event(text, id);
    if (postback) { e.type = 'postback'; e.postback = { data: text }; delete e.message; }
    fixture.gas.doPost(input([e]));
    const reply = fixture.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1);
    return reply.body.messages.map(m => m.text || '').join('\n');
  };
  return { ...fixture, generated, send };
}

test('language detection: Chinese characters win, English needs real words, buttons are undecided', () => {
  const { gas } = createGas();
  assert.equal(gas.detectLanguage_('What projects have you done?'), 'en');
  assert.equal(gas.detectLanguage_('你做過哪些 Python 專案？'), 'zh');
  assert.equal(gas.detectLanguage_('OK'), null);
  assert.equal(gas.detectLanguage_('123 😀'), null);
  assert.equal(gas.detectLanguage_('topic:0123456789abcdef'), null);
  assert.equal(gas.languageCommand_('English'), 'en');
  assert.equal(gas.languageCommand_('英文模式'), 'en');
  assert.equal(gas.languageCommand_('中文'), 'zh');
  assert.equal(gas.languageCommand_('English please tell me more'), null);
});

test('an English question is answered in English while quotes are still verified against the Chinese source', () => {
  const f = setup();
  const reply = f.send('What kind of reports have you built?', 'e1');
  assert.equal(f.generated.at(-1).conversation.answerLanguage, 'en');
  assert.match(reply, /I built data analysis reports\./);
  assert.match(reply, /Sources: 專案作品/);
  assert.doesNotMatch(reply, /資料來源：/);
});

test('a Chinese question keeps the v2 Chinese answer and source label', () => {
  const f = setup();
  const reply = f.send('你做過什麼報表？', 'z1');
  assert.equal(f.generated.at(-1).conversation.answerLanguage, 'zh');
  assert.match(reply, /我建立過資料分析報表。/);
  assert.match(reply, /資料來源：專案作品/);
});

test('typing English remembers the preference so Chinese topic buttons answer in English until 中文 is sent', () => {
  const f = setup();
  f.send('Tell me about your projects', 'p1');
  const topic = f.gas.menuTopics_(f.gas.loadIndex_(f.gas.config_()))[0];
  assert.match(f.send('topic:' + topic.id, 'p2', true), /Sources: /);
  assert.equal(f.generated.at(-1).conversation.answerLanguage, 'en');
  // 手打中文只影響這一題，偏好不變。
  assert.match(f.send('你做過什麼報表？', 'p3'), /資料來源：/);
  assert.match(f.send('topic:' + topic.id, 'p4', true), /Sources: /);
  assert.match(f.send('中文', 'p5'), /已切換為中文/);
  assert.match(f.send('topic:' + topic.id, 'p6', true), /資料來源：/);
});

test('English mode switch replies without AI calls and the preference key never contains the raw userId', () => {
  const f = setup();
  const reply = f.send('English', 's1');
  assert.match(reply, /English mode is on/);
  assert.equal(f.state.calls.filter(call => call.url.includes('generativelanguage')).length, 0);
  const keys = [...f.state.cache.keys()].filter(key => key.startsWith('language:'));
  assert.equal(keys.length, 1);
  assert(!keys[0].includes('user-1'));
  assert.equal(f.state.cache.get(keys[0]), 'en');
});

test('missing evidence in English mode explains in English and still records the question for the owner', () => {
  const f = setup({ missing: true });
  const reply = f.send('Do you have a driving license?', 'm1');
  assert.match(reply, /could not find enough information/);
  assert.match(f.state.text, /Do you have a driving license\?/, 'the unanswered question is still written to the owner maintenance table');
});
