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

test('following the bot first shows a language picker instead of the homepage', () => {
  const f = setup();
  const e = event('', 'follow-1'); e.type = 'follow'; delete e.message;
  f.gas.doPost(input([e]));
  const reply = f.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.equal(reply.length, 1);
  assert.match(reply[0].altText, /請選擇語言 \/ Please choose a language/);
  assert.deepEqual(reply[0].contents.footer.contents.map(b => b.action.data), ['lang:zh', 'lang:en']);
  assert.equal(f.state.calls.filter(call => call.url.includes('generativelanguage')).length, 0);
});

test('choosing English shows an English homepage and the quick reply always offers switching back', () => {
  const f = setup();
  f.send('lang:en', 'l1', true);
  const reply = f.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.match(reply[0].text, /English mode is on/);
  const home = reply[1];
  assert.equal(home.type, 'flex');
  assert.deepEqual(home.contents.contents.map(card => card.header.contents[0].text), ['HELLO / ABOUT ME', 'ABOUT / TRAITS', 'EXPLORE / RESUME']);
  const labels = home.quickReply.items.map(i => i.action.label);
  assert.deepEqual(labels.slice(0, 2), ['About me', 'Quick overview']);
  assert.deepEqual(home.quickReply.items.at(-1).action, { type: 'postback', label: '中文', data: 'lang:zh', displayText: '中文' });
  f.send('lang:zh', 'l2', true);
  const zh = f.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages[1];
  assert.equal(zh.contents.contents[0].header.contents[0].text, 'HELLO / 認識我');
  assert.equal(zh.quickReply.items.at(-1).action.data, 'lang:en');
});

test('typed menu words keep the current language instead of flipping it', () => {
  const f = setup();
  f.send('lang:en', 'k1', true);
  f.send('選單', 'k2');
  const home = f.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages[0];
  assert.equal(home.contents.contents[0].header.contents[0].text, 'HELLO / ABOUT ME');
});

test('adaptive topics use their synced English label when present and fall back to Chinese otherwise', () => {
  const { gas } = createGas();
  gas.MESSAGE_LANGUAGE_ = 'en';
  assert.equal(gas.topicLabel_({ kind: 'adaptive', category: '專案', label: '專案：好河伴', labelEn: 'River Buddy' }), 'Project: River Buddy');
  assert.equal(gas.topicLabel_({ kind: 'adaptive', category: '專案', label: '專案：好河伴', labelEn: '' }), '專案：好河伴');
  assert.equal(gas.topicLabel_({ kind: 'intro', label: '我是誰' }), 'About me');
  gas.MESSAGE_LANGUAGE_ = 'zh';
  assert.equal(gas.topicLabel_({ kind: 'intro', label: '我是誰' }), '我是誰');
  assert.equal(gas.englishText_('好河伴', 16), '');
  assert.equal(gas.englishText_('River Buddy', 16), 'River Buddy');
  assert.equal(gas.englishText_('A very long English label', 16), '');
});

test('Gemini 503 in English mode explains in English with the status code', () => {
  const f = setup();
  f.send('English', 'g0');
  const original = f.state.response;
  f.state.response = call => call.url.endsWith(':generateContent') ? { status: 503, body: {} } : original(call);
  assert.match(f.send('What reports have you built?', 'g1'), /AI service is busy right now \(HTTP_503\)/);
});
