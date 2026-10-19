import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGas, unitVector, event } from './harness.mjs';

test('setup rejects placeholder credentials and copied whitespace does not corrupt settings', () => {
  const { gas, state } = createGas({ text: '[[PUBLIC]]\n這是公開履歷。\n[[/PUBLIC]]', properties: {
    GEMINI_API_KEY: ' YOUR_GEMINI_API_KEY ', LINE_CHANNEL_ACCESS_TOKEN: ' REPLACE_LINE_TOKEN '
  } });
  const setup = gas.checkSetup();
  assert.equal(setup.credentials.GEMINI_API_KEY, false);
  assert.equal(setup.credentials.LINE_CHANNEL_ACCESS_TOKEN, false);
  assert(setup.nextSteps.some(step => step.includes('GEMINI_API_KEY')));
  assert.equal(state.calls.length, 0);
  state.properties.set('LINE_CHANNEL_ACCESS_TOKEN', '  student-token\n');
  state.properties.set('BOT_ENABLED', ' TRUE ');
  assert.equal(gas.config_().lineToken, 'student-token');
  assert.equal(gas.config_().enabled, true);
  state.properties.set('BOT_ENABLED', ' FALSE ');
  assert.equal(gas.config_().enabled, false);
  assert(gas.checkSetup().nextSteps.some(step => step.includes('BOT_ENABLED=false')));
});

test('a corrupt index is diagnosed as an index problem while the document remains ready', () => {
  const { gas, state } = createGas({ text: '[[PUBLIC]]\n這是公開履歷。\n[[/PUBLIC]]', response: call => ({ body: {
    embeddings: call.body.requests.map(() => ({ values: unitVector() }))
  } }) });
  gas.syncKnowledgeBase();
  state.files.get(state.properties.get('INDEX_FILE_ID')).content = '{';
  const setup = gas.checkSetup();
  assert.equal(setup.document, 'ready');
  assert.equal(setup.index, 'INDEX_INVALID');
  assert(setup.nextSteps.some(step => step.includes('syncKnowledgeBase')));
  assert(!setup.nextSteps.some(step => step.includes('initializeProject')));
});

test('pasted Docs URLs and exec URLs with old query strings use their canonical destinations', () => {
  const { gas, state } = createGas({ properties: {
    RESUME_DOC_ID: ' https://docs.google.com/document/d/student-document/edit?tab=t.0 ',
    WEB_APP_URL: ' https://script.google.com/macros/s/student-deployment/exec?key=old-key#copy '
  } });
  assert.equal(gas.config_().docId, 'student-document');
  assert.equal(gas.showWebhookUrl(), 'https://script.google.com/macros/s/student-deployment/exec?key=' + 'a'.repeat(64));
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), 'a'.repeat(64));
  state.properties.set('WEB_APP_URL', 'https://script.google.com/macros/s/student-deployment/dev');
  assert.throws(() => gas.rotateWebhookToken(), /SET_PUBLIC_WEB_APP_URL/);
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), 'a'.repeat(64));
});

test('a whitespace-only document setting still creates the student resume and prints its direct link', () => {
  const { gas, state } = createGas({ properties: { RESUME_DOC_ID: '  ', WEBHOOK_TOKEN: '\n ' } });
  const setup = gas.initializeProject();
  assert.equal(state.createdDocuments.length, 1);
  assert.equal(setup.document, 'ready');
  assert.match(state.properties.get('WEBHOOK_TOKEN'), /^[a-f0-9]{64}$/);
  assert(state.logs.some(log => log === '履歷文件：' + setup.documentUrl));
  assert(state.logs.some(log => log.startsWith('下一步 ')));
});

test('LINE account check validates the token without sending messages and safely reports failures', () => {
  const { gas, state } = createGas({ response: () => ({ body: { displayName: '王同學的履歷' } }) });
  const ready = gas.testLineConnection();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.botName, '王同學的履歷');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, 'https://api.line.me/v2/bot/info');
  assert.equal(state.calls[0].method, 'get');
  assert(!state.calls[0].body);
  for (const status of [401, 403, 429, 503]) {
    state.response = () => ({ status, body: { secret: 'sensitive-line-payload' } });
    const failed = gas.testLineConnection();
    assert.equal(failed.status, 'error');
    assert.equal(failed.code, 'LINE_HTTP_' + status);
  }
  state.response = () => { throw new Error('sensitive-network-payload'); };
  assert.equal(gas.testLineConnection().status, 'error');
  state.properties.set('LINE_CHANNEL_ACCESS_TOKEN', 'YOUR_LINE_TOKEN');
  const calls = state.calls.length;
  assert.equal(gas.testLineConnection().code, 'MISSING_LINE_CHANNEL_ACCESS_TOKEN');
  assert.equal(state.calls.length, calls);
  assert(!state.logs.some(log => /sensitive-|test-line/.test(log)));
});

test('accidentally running doPost in the editor explains the right next action without API calls', () => {
  const { gas, state } = createGas();
  assert.match(gas.doPost().text, /checkSetup/);
  assert(state.logs.some(log => log.includes('initializeProject')));
  assert.equal(state.calls.length, 0);
  assert.equal(gas.doGet().text, 'LINE 履歷助理已部署。版本 ' + gas.appVersion_());
});

test('the actual single-file installer completes a fresh student flow through reply, feedback and update', () => {
  const { gas, state } = createGas({ sourceMode: 'bundle', properties: {
    RESUME_DOC_ID: '', GEMINI_API_KEY: '', LINE_CHANNEL_ACCESS_TOKEN: '', WEBHOOK_TOKEN: ''
  } });
  let missing = false;
  state.response = call => {
    if (call.url.endsWith('/bot/info')) return { body: { displayName: 'Student Demo' } };
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector(missing ? 1 : 0) } } };
    if (call.url.endsWith(':generateContent')) return { body: { candidates: [{ finishReason: 'STOP', content: {
      parts: [{ text: JSON.stringify({ grounded: true, answer: '這份模擬履歷的人物是陳沐言。',
        evidence: [{ id: 'S1', quote: '姓名：陳沐言' }] }) }]
    } }] } };
    return { body: {} };
  };
  assert.equal(gas.initializeProject().document, 'ready');
  state.properties.set('GEMINI_API_KEY', ' student-demo-gemini\n');
  state.properties.set('LINE_CHANNEL_ACCESS_TOKEN', ' student-demo-line\n');
  assert.equal(gas.testLineConnection().status, 'ready');
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  state.properties.set('WEB_APP_URL', 'https://script.google.com/macros/s/student-public/exec');
  const webhookUrl = gas.showWebhookUrl();
  const key = webhookUrl.split('?key=')[1];
  const input = events => ({ parameter: { key }, postData: { contents: JSON.stringify({ events }) } });
  assert.equal(gas.doPost(input([])).text, 'OK');
  gas.doPost(input([event('選單', 'menu')]));
  assert.equal(state.calls.at(-1).body.messages[0].type, 'flex');
  gas.doPost(input([event('個人介紹', 'introduction')]));
  assert.match(state.calls.at(-1).body.messages[0].text, /陳沐言/);
  missing = true;
  gas.doPost(input([event('有南極研究站工作經驗嗎？', 'unknown')]));
  assert.match(state.calls.at(-1).body.messages[0].text, /已將問題記錄/);
  assert(state.text.includes('問題：有南極研究站工作經驗嗎？'));
  assert.equal(gas.checkSetup().index, 'ready');
  state.text = state.text.replace(/\n\[\[\/PUBLIC\]\]\n/, '\n## 課堂測試\n課堂展示時間為週三下午。\n[[/PUBLIC]]\n');
  assert.equal(gas.checkSetup().index, 'needs_sync');
  gas.doPost(input([event('課堂展示時間？', 'stale')]));
  assert.match(state.calls.at(-1).body.messages[0].text, /等待同步/);
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  assert.equal(gas.checkSetup().index, 'ready');
  assert.equal(state.createdDocuments.length, 1);
});

test('a failed testResumeAnswer is explained and checkSetup stops repeating the same advice once it passes', () => {
  const { gas, state } = createGas({ sourceMode: 'bundle', properties: { RESUME_DOC_ID: '', WEBHOOK_TOKEN: '' } });
  let quote = '這段文字不在履歷裡面';
  state.response = call => {
    if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
    if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
    return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      grounded: true, answer: '陳沐言是 AI 自動化工程師。', evidence: [{ id: 'S1', quote }] }) }] } }] } };
  };
  gas.initializeProject();
  gas.syncKnowledgeBase();
  const advice = () => [...gas.checkSetup().nextSteps].filter(step => step.includes('testResumeAnswer'));
  assert.deepEqual(advice(), ['執行 testResumeAnswer，核對 Gemini 真實回答與來源。']);
  assert.throws(() => gas.testResumeAnswer(), /ANSWER_INVALID_EVIDENCE/);
  assert(state.logs.some(log => /testResumeAnswer 未通過（ANSWER_INVALID_EVIDENCE）：.*不代表履歷沒有相關資料/.test(log)));
  assert.equal(gas.checkSetup().answerTest, 'ANSWER_INVALID_EVIDENCE');
  assert.match(advice()[0], /上次 testResumeAnswer 未通過（ANSWER_INVALID_EVIDENCE）.*再執行一次/);
  quote = '職涯定位:AI應用與流程自動化工程師';
  assert.match(gas.testResumeAnswer(), /資料來源：個人介紹/);
  assert.equal(gas.checkSetup().answerTest, 'OK');
  assert.deepEqual(advice(), []);
});

test('the offline installation page contains exact copyable code and manifest', async () => {
  const [html, code, manifest, packageText] = await Promise.all([
    readFile(new URL('../START_HERE.html', import.meta.url), 'utf8'),
    readFile(new URL('../dist/Code.gs', import.meta.url), 'utf8'),
    readFile(new URL('../gas/appsscript.json', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8')
  ]);
  const data = JSON.parse(html.match(/<script id="installData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.code, code);
  assert.equal(data.manifest, manifest);
  assert.equal(createGas().gas.appVersion_(), JSON.parse(packageText).version);
  assert(!/<script[^>]+src=/.test(html));
  const executable = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  assert(!/fetch\(/.test(executable));
});
