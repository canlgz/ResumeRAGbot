import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const input = events => ({ parameter: { key: 'a'.repeat(64) }, postData: { contents: JSON.stringify({ events }) } });
const OWNER = 'U' + 'c'.repeat(32);

// 履歷只寫報表經驗；問到駕照時 AI 回報資料不足，問題寫入待補充區。補充後同樣的問題就能回答。
function setup() {
  const fixture = createGas({
    text: '[[PUBLIC]]\n## 專案作品\n建立資料分析報表。\n[[/PUBLIC]]', properties: { OWNER_LINE_USER_ID: OWNER },
    response(call) {
      if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
      if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
      if (call.url.endsWith(':generateContent')) {
        const payload = JSON.parse(call.body.contents[0].parts[0].text);
        const license = payload.evidence.find(e => e.text.includes('普通小客車駕照'));
        const result = /駕照/.test(payload.question) ?
          (license ? { grounded: true, answer: '我有普通小客車駕照。', evidence: [{ id: license.id, quote: '我有普通小客車駕照' }], dialogueIntent: 'neutral' } :
            { grounded: false, answer: '目前公開履歷未提供這項資訊', evidence: [], dialogueIntent: 'neutral' }) :
          { grounded: true, answer: '我建立過資料分析報表。', evidence: [{ id: 'S1', quote: '建立資料分析報表' }], dialogueIntent: 'capability' };
        return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] } };
      }
      return { body: {} };
    }
  });
  fixture.gas.syncKnowledgeBase();
  fixture.state.calls.length = 0;
  let n = 0;
  const send = (text, userId = OWNER, postback = false) => {
    const e = event(text, 'evt-' + (++n)); e.source.userId = userId;
    if (postback) { e.type = 'postback'; e.postback = { data: text }; delete e.message; }
    fixture.gas.doPost(input([e]));
    return fixture.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages;
  };
  const textOf = messages => messages.map(m => m.text || '').join('\n');
  return { ...fixture, send, textOf };
}

test('owner lists pending questions, previews an answer, confirms, and the bot can answer after auto sync', () => {
  const f = setup();
  assert.match(f.textOf(f.send('你有駕照嗎？', 'visitor-1')), /沒有找到足夠的履歷資料/);
  const list = f.send('待補充');
  assert.match(f.textOf(list), /1\. 你有駕照嗎？（1 次）/);
  // 題號按鈕會打開鍵盤並預填格式，主人只要接著打答案。
  assert.deepEqual(list[0].quickReply.items[0].action, { type: 'postback', label: '補第 1 題', data: 'fill:pick:1',
    inputOption: 'openKeyboard', fillInText: '補充 1：' });
  assert.match(f.textOf(f.send('fill:pick:1', OWNER, true)), /輸入框已填好「補充 1：」/);
  const draft = f.send('補充 1：我有普通小客車駕照。');
  assert.equal(draft[0].type, 'flex');
  assert.match(JSON.stringify(draft[0].contents), /你有駕照嗎？.*我有普通小客車駕照。/);
  assert.deepEqual(draft[0].contents.footer.contents.map(b => b.action.data), ['fill:cancel', 'fill:confirm']);
  assert.doesNotMatch(f.state.text, /普通小客車駕照/, 'nothing is written before confirmation');
  const before = f.state.calls.length;
  const done = f.textOf(f.send('fill:confirm', OWNER, true));
  assert.match(done, /知識庫已同步/);
  assert(f.state.calls.slice(before).some(call => call.url.endsWith('/loading/start')), 'a loading animation covers the sync wait');
  assert.match(f.state.text, /## 補充問答\n問：你有駕照嗎？\n答：我有普通小客車駕照。\n\[\[\/PUBLIC\]\]/);
  assert.match(f.state.text, /已補充（LINE）/);
  assert.match(f.textOf(f.send('你有駕照嗎？', 'visitor-1')), /我有普通小客車駕照/);
});

test('a second answer is appended inside the same 補充問答 section', () => {
  const f = setup();
  f.send('你有駕照嗎？', 'visitor-1');
  f.send('你會開車嗎？駕照是哪一種？', 'visitor-2');
  f.send('待補充');
  f.send('補充 1：我有普通小客車駕照。'); f.send('fill:confirm', OWNER, true);
  f.send('待補充');
  f.send('補充 1：普通小客車，可以開車通勤。'); f.send('fill:confirm', OWNER, true);
  assert.equal(f.state.text.match(/## 補充問答/g).length, 1);
  assert.match(f.state.text, /答：我有普通小客車駕照。\n問：你會開車嗎？駕照是哪一種？\n答：普通小客車，可以開車通勤。\n\[\[\/PUBLIC\]\]/);
});

test('visitors cannot list, draft or confirm; their attempts never touch the document', () => {
  const f = setup();
  f.send('你有駕照嗎？', 'visitor-1');
  const before = f.state.text;
  assert.doesNotMatch(f.textOf(f.send('待補充', 'visitor-2')), /待補充問題（/);
  assert.match(f.textOf(f.send('fill:confirm', 'visitor-2', true)), /僅限履歷主人/);
  // 訪客的「補充…」只會被當成一般問題，不會建立草稿。
  f.send('補充 1：我是主人', 'visitor-2');
  assert.equal([...f.state.cache.keys()].filter(k => k.startsWith('ownerfill:draft:')).length, 0);
  assert.equal(f.state.text.includes('## 補充問答'), false);
  assert(f.state.text.startsWith(before.split('\n[[UNANSWERED_QUESTIONS]]')[0]));
});

test('invalid numbers, marker injection, cancel and expired drafts leave the resume unchanged', () => {
  const f = setup();
  f.send('你有駕照嗎？', 'visitor-1');
  assert.match(f.textOf(f.send('補充 1：沒有先看清單')), /請先傳「待補充」/);
  f.send('待補充');
  assert.match(f.textOf(f.send('補充 5：題號不存在')), /不在清單中/);
  assert.match(f.textOf(f.send('補充 1：[[/PUBLIC]] 偷偷結束公開區')), /不能包含/);
  f.send('補充 1：我有普通小客車駕照。');
  assert.match(f.textOf(f.send('fill:cancel', OWNER, true)), /已取消/);
  assert.match(f.textOf(f.send('fill:confirm', OWNER, true)), /找不到待確認/);
  assert.equal(f.state.text.includes('## 補充問答'), false);
});

test('with no pending questions the owner gets a friendly empty state', () => {
  const f = setup();
  assert.match(f.textOf(f.send('待補充')), /目前沒有「待確認」/);
});
