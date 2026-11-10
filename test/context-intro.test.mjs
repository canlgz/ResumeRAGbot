import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const resume = '私人電話：不可公開\n[[PUBLIC]]\n## 工作經歷\n我曾在光譜工作室實習，負責整理每週資料報表。\n## 專案作品\n我與團隊開發校園地圖，個人負責資料整理與介面測試。\n## 興趣\n我平常喜歡登山，也關注自然攝影。\n[[PRIVATE]]\n家庭住址：不可公開\n[[/PRIVATE]]\n[[/PUBLIC]]';
const noInterest = resume.replace('## 興趣\n我平常喜歡登山，也關注自然攝影。\n', '');

function fixture(text = resume, options = {}) {
  const f = createGas({ text, response: call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return options.apiError ? { status: 503, body: {} } : { body: { embedding: { values: unitVector() } } };
    if (call.url.endsWith(':generateContent')) {
      const input = JSON.parse(call.body.contents[0].parts[0].text);
      const hit = input.evidence[0];
      const answer = options.ungrounded ? '沒有足夠資料' : '我' + hit.text.slice(0, 46);
      return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        grounded: !options.ungrounded, answer, dialogueIntent: 'neutral',
        evidence: options.ungrounded ? [] : [{ id: hit.id, quote: hit.text.slice(0, 24) }]
      }) }] } }] } };
    }
    return { body: {} };
  } });
  f.gas.syncKnowledgeBase();
  f.state.calls.length = 0;
  let seq = 0;
  function send(text, user = 'user-1', postback = false, id) {
    const e = event(text, id || 'context-' + ++seq);
    e.source.userId = user;
    if (postback) { e.type = 'postback'; e.postback = { data: text }; delete e.message; }
    f.gas.handleEvent_(e, f.gas.config_());
    return f.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages;
  }
  const generation = () => f.state.calls.filter(call => call.url.endsWith(':generateContent'))
    .map(call => JSON.parse(call.body.contents[0].parts[0].text));
  return { ...f, send, generation };
}

test('home offers context entry and menu offers exactly three situations', () => {
  const f = fixture();
  const home = f.send('首頁')[0];
  assert.equal(home.contents.contents[2].footer.contents[1].action.data, 'ctx:menu');
  const menu = f.send('ctx:menu', 'user-1', true)[0];
  assert.deepEqual(Array.from(menu.contents.footer.contents, x => x.action.label), ['人資面試', '專案合作', '一般認識', '回首頁']);
});

test('three introductions retrieve only their matching public sections and cite sources', () => {
  for (const [kind, section] of [['hr', '工作經歷'], ['project', '專案作品'], ['personal', '興趣']]) {
    const f = fixture();
    const messages = f.send('ctx:select:' + kind, 'user-1', true);
    assert.equal(messages.length, 3);
    assert.match(messages[1].text, new RegExp('資料來源：' + section));
    assert.deepEqual(f.generation().at(-1).evidence.map(e => e.section), [section]);
    assert(!JSON.stringify(f.state.calls).includes('家庭住址'));
    assert(!JSON.stringify(f.state.calls).includes('私人電話'));
    assert.equal(f.generation().at(-1).conversation.contextIntro, true);
  }
});

test('missing explicit interests never calls generation or writes maintenance notes', () => {
  const f = fixture(noInterest);
  const messages = f.send('ctx:select:personal', 'user-1', true);
  assert.match(messages[0].text, /沒有足夠/);
  assert.equal(f.generation().length, 0);
  assert.equal(f.state.documentWrites, 0);
  assert.equal(f.gas.readConversation_('user-1', f.gas.loadIndex_(f.gas.config_()).fingerprint).contextId, 'personal');
  assert.match(f.send('ctx:ask:personal:0', 'user-1', true)[0].text, /沒有足夠/);
  assert.equal(f.state.documentWrites, 0);
});

test('an ungrounded suggestion is not written into the maintenance section', () => {
  const f = fixture(resume, { ungrounded: true });
  f.send('ctx:select:hr', 'user-1', true);
  const messages = f.send('ctx:ask:hr:0', 'user-1', true);
  assert.match(messages[0].text, /沒有足夠/);
  assert.equal(f.state.documentWrites, 0);
});

test('suggested question and free question use the existing RAG flow with context as tone only', () => {
  const f = fixture();
  const intro = f.send('ctx:select:hr', 'user-1', true);
  assert.equal(intro[2].quickReply.items[0].action.data, 'ctx:ask:hr:0');
  const suggested = f.send('ctx:ask:hr:0', 'user-1', true);
  assert.match(suggested[1].text, /資料來源/);
  assert.equal(f.generation().at(-1).conversation.contextId, 'hr');
  assert.equal(f.generation().at(-1).conversation.contextIntro, false);
  f.send('你做過哪些專案？');
  assert.equal(f.generation().at(-1).conversation.contextId, 'hr');
  assert(f.generation().at(-1).evidence.some(e => e.section === '專案作品'), 'free question may retrieve another section');
});

test('switching situation isolates visitors and rejects old suggested buttons', () => {
  const f = fixture();
  f.send('ctx:select:hr', 'user-1', true);
  f.send('ctx:select:project', 'user-2', true);
  f.send('ctx:select:personal', 'user-1', true);
  assert.equal(f.send('ctx:ask:hr:0', 'user-1', true)[0].text.includes('已過期'), true);
  f.send('你的專案是什麼？', 'user-2');
  assert.equal(f.generation().at(-1).conversation.contextId, 'project');
  f.send('你喜歡什麼？', 'user-1');
  assert.equal(f.generation().at(-1).conversation.contextId, 'personal');
});

test('cache loss, expiry, home, unknown buttons and duplicate events recover safely', () => {
  const f = fixture();
  f.send('ctx:select:hr', 'user-1', true);
  f.state.cache.clear();
  assert.match(f.send('ctx:ask:hr:0', 'user-1', true)[0].text, /已過期/);
  f.send('ctx:select:hr', 'user-1', true);
  const key = f.gas.conversationKey_('user-1');
  const old = JSON.parse(f.state.cache.get(key)); old.expiresAt = Date.now() - 1; f.state.cache.set(key, JSON.stringify(old));
  assert.match(f.send('ctx:ask:hr:0', 'user-1', true)[0].text, /已過期/);
  assert.match(f.send('ctx:ask:obsolete:0', 'user-1', true)[0].text, /已失效/);
  f.send('ctx:select:hr', 'user-1', true);
  f.send('ctx:cancel', 'user-1', true);
  assert.equal(f.state.cache.has(f.gas.conversationKey_('user-1')), false);
  f.send('ctx:select:hr', 'user-1', true);
  f.send('首頁');
  assert.equal(f.state.cache.has(key), false);
  const before = f.generation().length;
  f.send('ctx:select:hr', 'user-1', true, 'same-event');
  f.send('ctx:select:hr', 'user-1', true, 'same-event');
  assert.equal(f.generation().length, before + 1);
});

test('changed public Doc blocks stale intro and suggested questions', () => {
  const f = fixture();
  f.send('ctx:select:hr', 'user-1', true);
  const count = f.generation().length;
  f.state.text = noInterest.replace('光譜工作室', '另一間工作室');
  assert.match(f.send('ctx:ask:hr:0', 'user-1', true)[0].text, /已過期/);
  assert.match(f.send('ctx:select:hr', 'user-1', true)[0].text, /等待同步/);
  assert.equal(f.generation().length, count);
});

test('a document edit during introduction generation cannot return old evidence', () => {
  const f = fixture();
  const respond = f.state.response;
  f.state.response = call => {
    if (call.url.endsWith(':generateContent')) f.state.text = noInterest.replace('光譜工作室', '另一間工作室');
    return respond(call);
  };
  const messages = f.send('ctx:select:hr', 'user-1', true);
  assert.match(messages[0].text, /等待同步/);
  assert(!messages.some(m => /資料來源/.test(m.text || '')));
});

test('API failures produce a safe error, while ordinary Q&A and invitation still route normally', () => {
  const f = fixture(resume, { apiError: true });
  assert.match(f.send('ctx:select:hr', 'user-1', true)[0].text, /暫時無法/);
  assert.equal(f.generation().length, 0);
  assert.equal(f.send('invite:start', 'user-1', true)[0].type, 'text');
  const reply = f.send('ctx:select:project', 'user-1', true);
  assert(!reply.some(m => /資料來源/.test(m.text || '')), 'active invitation takes priority');
  const normal = fixture();
  assert.match(normal.send('你的工作經驗？')[1].text, /資料來源/);
});
