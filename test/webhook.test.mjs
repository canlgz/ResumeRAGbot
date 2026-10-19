import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const input = (events, key = 'a'.repeat(64)) => ({ parameter: { key }, postData: { contents: JSON.stringify({ events }) } });

function ragResponse(call) {
  if (call.url.endsWith(':batchEmbedContents')) return { body: {
    embeddings: call.body.requests.map(() => ({ values: unitVector() }))
  } };
  if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
  if (call.url.endsWith(':generateContent')) return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    grounded: true, answer: '曾建立資料分析報表。', evidence: [{ id: 'S1', quote: '建立資料分析報表' }]
  }) }] } }] } };
  return { body: {} };
}

function readyRag(options = {}) {
  const fixture = createGas({ text: '[[PUBLIC]]\n## 專案作品\n建立資料分析報表。\n[[/PUBLIC]]', response: ragResponse, ...options });
  fixture.gas.syncKnowledgeBase();
  fixture.state.calls.length = 0;
  fixture.state.logs.length = 0;
  return fixture;
}

test('webhook URL uses the installation property even when GAS returns a dev URL', () => {
  const publicUrl = 'https://script.google.com/macros/s/example-public-deployment/exec';
  const { gas, state } = createGas({
    properties: { WEB_APP_URL: publicUrl },
    serviceUrl: 'https://script.google.com/macros/s/example-test-deployment/dev'
  });
  const url = gas.showWebhookUrl();
  assert.equal(url, publicUrl + '?key=' + 'a'.repeat(64));
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), 'a'.repeat(64));
  assert.equal(state.calls.length, 0);
});

test('every installation must configure its own exec URL instead of trusting getService or rewriting dev', () => {
  const serviceUrl = 'https://script.google.com/macros/s/another-test-id/dev';
  const { gas, state } = createGas({ serviceUrl });
  assert.throws(() => gas.showWebhookUrl(), /SET_PUBLIC_WEB_APP_URL/);
  assert.equal(state.logs.length, 0);
  assert.throws(() => createGas().gas.showWebhookUrl(), /SET_PUBLIC_WEB_APP_URL/);
  const publicUrl = 'https://script.google.com/macros/s/another-public-id/exec';
  state.properties.set('WEB_APP_URL', publicUrl);
  assert.equal(gas.showWebhookUrl(), publicUrl + '?key=' + 'a'.repeat(64));
  assert.throws(() => createGas({ serviceUrl: publicUrl }).gas.publicWebAppUrl_(), /SET_PUBLIC_WEB_APP_URL/);
});

test('invalid explicit webhook destinations cannot receive a generated secret URL', () => {
  for (const url of ['https://example.test/exec', 'https://script.google.com/macros/s/test/dev',
    'https://script.google.com/macros/s/test/exec?key=old', 'http://script.google.com/macros/s/test/exec']) {
    const { gas, state } = createGas({ properties: { WEB_APP_URL: url } });
    assert.throws(() => gas.showWebhookUrl(), /SET_PUBLIC_WEB_APP_URL/);
    assert.equal(state.logs.length, 0);
  }
});

test('anonymous and other-account HtmlService callers cannot invoke management functions', () => {
  const { gas, state } = createGas();
  for (const email of ['', 'visitor@example.test']) {
    state.activeEmail = email;
    for (const fn of ['initializeProject', 'showWebhookUrl', 'rotateWebhookToken', 'checkSetup',
      'installHourlySync', 'removeHourlySync', 'testResumeAnswer', 'syncKnowledgeBase']) {
      assert.throws(() => gas[fn](), /OWNER_ONLY/);
    }
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), 'a'.repeat(64));
});

test('missing, malformed and incorrect URL keys fail before any API calls', () => {
  const { gas, state } = createGas();
  for (const key of ['', 'bad', 'b'.repeat(64)]) assert.equal(gas.doPost(input([event()], key)).text, 'Ignored');
  assert.equal(state.calls.length, 0);
  assert.throws(() => gas.verifyWebhookToken_('a'.repeat(64), ''), /MISSING_WEBHOOK_TOKEN/);
});

test('LINE verification and malformed bodies are handled without reply or AI calls', () => {
  const { gas, state } = createGas();
  assert.equal(gas.doPost(input([])).text, 'OK');
  for (const body of ['{', 'null', '{}', JSON.stringify({ events: 'wrong' })]) {
    assert.equal(gas.doPost({ ...input([]), postData: { contents: body } }).text, 'Ignored');
  }
  assert.equal(state.calls.length, 0);
});

test('full direct webhook to LINE reply chain and persistent duplicate suppression', () => {
  const { gas, state } = createGas();
  assert.equal(gas.doPost(input([event()])).text, 'OK');
  assert.equal(gas.doPost(input([event()])).text, 'OK');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].body.messages[0].type, 'flex');
  assert(!JSON.stringify(Object.fromEntries(state.properties)).includes('user-1'));
  assert(!state.logs.some(line => line.includes('reply-event-1')));
});

test('one invalid event does not suppress other events in a batch', () => {
  const { gas, state } = createGas();
  const invalid = { ...event(), webhookEventId: 123, replyToken: 'invalid' };
  gas.doPost(input([invalid, event('使用說明', 'event-2'), event('隱私', 'event-3')]));
  assert.equal(state.calls.length, 2);
  assert.match(state.calls[0].body.messages[0].text, /每題獨立/);
  assert.match(state.calls[1].body.messages[0].text, /資料使用方式/);
});

test('group and standby events are ignored; non-text gets a useful response', () => {
  const { gas, state } = createGas();
  assert.equal(gas.handleEvent_({ ...event(), source: { type: 'group' } }, gas.config_()), 'ignored');
  assert.equal(gas.handleEvent_({ ...event(), mode: 'standby' }, gas.config_()), 'ignored');
  assert.equal(state.calls.length, 0);
  gas.handleEvent_({ ...event(), message: { type: 'image' } }, gas.config_());
  assert.match(state.calls[0].body.messages[0].text, /文字問題/);
});

test('repeated RAG questions ignore legacy daily and hourly settings and exhausted counters', () => {
  const legacyBudget = JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 99999 });
  const { gas, state } = readyRag({ properties: {
    DAILY_AI_LIMIT: '1', USER_HOURLY_LIMIT: '1', AI_BUDGET: legacyBudget
  } });
  const cacheKey = 'rate:' + gas.sha256_('user-1').slice(0, 32) + ':' + Math.floor(Date.now() / 3600000);
  state.cache.set(cacheKey, '99999');
  for (let i = 0; i < 105; i++) gas.doPost(input([event('專案作品', 'question-' + i)]));
  const replies = state.calls.filter(call => call.url.endsWith('/message/reply'));
  assert.equal(replies.length, 105);
  assert(replies.every(call => call.body.messages[0].text.includes('資料來源：專案作品')));
  assert.equal(state.calls.filter(call => call.url.endsWith(':generateContent')).length, 105);
  assert.equal(state.properties.get('AI_BUDGET'), legacyBudget);
  assert.equal(state.cache.size, 1);
  assert.equal(state.cache.get(cacheKey), '99999');
  state.properties.set('DAILY_AI_LIMIT', 'obsolete-value');
  state.properties.set('USER_HOURLY_LIMIT', 'obsolete-value');
  assert.doesNotThrow(() => gas.config_());
});

test('RAG starts a loading animation before AI and sends a single reply without duplicate work', () => {
  const { gas, state } = readyRag();
  const request = input([event('個人介紹')]);
  gas.doPost(request);
  assert.deepEqual(state.calls.map(call => call.url.split('/').at(-1)), [
    'start', 'gemini-embedding-001:embedContent', 'gemini-3.5-flash-lite:generateContent', 'reply'
  ]);
  assert.deepEqual(state.calls[0].body, { chatId: 'user-1', loadingSeconds: 60 });
  assert(!('replyToken' in state.calls[0].body));
  assert.match(state.calls[3].body.messages[0].text, /建立資料分析報表/);
  gas.doPost(request);
  assert.equal(state.calls.length, 4);
  assert(!JSON.stringify(Object.fromEntries(state.properties)).includes('user-1'));
});

test('loading HTTP or network failure does not prevent the RAG answer or expose error payloads', () => {
  for (const failure of ['http', 'network']) {
    const { gas, state } = readyRag();
    state.response = call => {
      if (call.url.endsWith('/loading/start')) {
        if (failure === 'network') throw new Error('sensitive-network-payload');
        return { status: 403, body: { message: 'sensitive-http-payload' } };
      }
      return ragResponse(call);
    };
    gas.doPost(input([event('專業技能')]));
    const replies = state.calls.filter(call => call.url.endsWith('/message/reply'));
    assert.equal(replies.length, 1);
    assert.match(replies[0].body.messages[0].text, /資料來源/);
    assert(state.logs.some(log => log.includes(failure === 'network' ? 'LINE_LOADING_FAILED' : 'LINE_LOADING_HTTP_403')));
    assert(!state.logs.some(log => log.includes('sensitive-')));
  }
});

test('embedding and generation API failures report provider quota separately from other failures', () => {
  const cases = [
    [429, /Google Gemini API.*使用額度或呼叫頻率.*HTTP 429/],
    [402, /Google Gemini API.*付款或預付額度不足.*HTTP 402/],
    [401, /Google Gemini API.*驗證或存取權限失敗.*HTTP 401/],
    [403, /Google Gemini API.*驗證或存取權限失敗.*HTTP 403/],
    [503, /Google Gemini API.*暫時無法處理.*HTTP 503/],
    [400, /目前暫時無法讀取履歷或產生回答/]
  ];
  for (const stage of ['embedContent', 'generateContent']) for (const [status, expected] of cases) {
    const { gas, state } = readyRag();
    state.response = call => call.url.endsWith(':' + stage)
      ? { status, body: { error: { message: 'sensitive-api-payload', key: 'test-gemini' } } }
      : ragResponse(call);
    gas.doPost(input([event('個人介紹')]));
    const replies = state.calls.filter(call => call.url.endsWith('/message/reply'));
    assert.equal(replies.length, 1);
    const message = replies[0].body.messages[0].text;
    assert.match(message, expected);
    if (![429, 402].includes(status)) assert(!message.includes('額度'));
    assert(!message.includes('sensitive-api-payload') && !message.includes('test-gemini'));
    assert(state.logs.some(log => log.includes('GEMINI_HTTP_' + status)));
    assert(!state.logs.some(log => log.includes('sensitive-api-payload') || log.includes('test-gemini')));
    assert.equal(state.calls.filter(call => call.url.endsWith(':' + stage)).length, 1);
    assert.equal(state.documentWrites, 0);
  }
});

test('failed LINE delivery releases claim; rejected token never triggers a push', () => {
  const { gas, state } = createGas({ response: () => ({ status: 503, body: {} }) });
  assert.throws(() => gas.handleEvent_(event(), gas.config_()), /LINE_HTTP_503/);
  assert.equal(state.properties.get(gas.eventKey_(event())), undefined);
  state.response = () => ({ status: 400, body: {} });
  assert.equal(gas.handleEvent_(event(), gas.config_()), 'reply_rejected');
  assert.equal(gas.handleEvent_(event(), gas.config_()), 'duplicate');
  assert.equal(state.calls.length, 2);
});

test('initialization preserves credentials and generates a token only when missing', () => {
  const { gas, state } = createGas();
  gas.initializeProject();
  assert.equal(state.properties.get('GEMINI_API_KEY'), 'test-gemini');
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), 'a'.repeat(64));
  state.properties.delete('WEBHOOK_TOKEN');
  gas.initializeProject();
  assert.match(state.properties.get('WEBHOOK_TOKEN'), /^[a-f0-9]{64}$/);
  assert(!state.logs.some(line => line.includes('test-gemini')));
});

test('disabled bot and long questions avoid all AI calls', () => {
  const { gas, state } = createGas({ properties: { BOT_ENABLED: 'false' } });
  gas.handleEvent_(event('工作經歷'), gas.config_());
  assert.match(state.calls[0].body.messages[0].text, /暫停/);
  state.properties.set('BOT_ENABLED', 'true');
  gas.handleEvent_(event('a'.repeat(801), 'event-2'), gas.config_());
  assert.match(state.calls[1].body.messages[0].text, /800/);
  assert.equal(state.calls.filter(c => c.url.includes('generativelanguage')).length, 0);
});
