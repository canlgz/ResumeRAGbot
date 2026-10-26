import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, unitVector } from './harness.mjs';

const publicUrl = 'https://script.google.com/macros/s/student-deployment/exec';
const isProbe = call => call.url.startsWith(publicUrl + '?version_check=');

function fixture() {
  const f = createGas({ text: '[[PUBLIC]]\n## 作品\n這是公開的課程專題。\n[[/PUBLIC]]' });
  f.state.response = call => isProbe(call) ? { text: f.gas.doGet().text } : {
    body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) }
  };
  return f;
}

test('a fresh installation can sync before deployment and reports that deployment is not configured', () => {
  const { gas, state } = fixture();
  assert.equal(gas.checkDeployment().status, 'not_configured');
  assert.equal(state.calls.length, 0);
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  assert.equal(gas.loadIndex_(gas.config_()).builtWithAppVersion, gas.appVersion_());
});

test('deployment check reads the actual public URL without sending webhook tokens or credentials', () => {
  const { gas, state } = fixture();
  state.properties.set('WEB_APP_URL', publicUrl + '?key=do-not-send-this');
  const result = gas.checkDeployment();
  assert.equal(result.status, 'ready');
  assert.equal(result.editorVersion, gas.appVersion_());
  assert.equal(result.webAppVersion, gas.appVersion_());
  const call = state.calls[0];
  assert(isProbe(call));
  assert.equal(call.method, 'get');
  assert(!call.url.includes('key='));
  assert(!JSON.stringify(call).includes('test-gemini'));
  assert(!JSON.stringify(call).includes('test-line'));
  assert(!JSON.stringify(result).includes('do-not-send-this'));
});

test('version extraction handles Google HtmlService wrappers and the pre-marker deployment page', () => {
  const { gas, state } = fixture();
  state.properties.set('WEB_APP_URL', publicUrl);
  for (const text of [
    '...userHtml\\x22:\\x22LINE 履歷助理已部署。版本 ' + gas.appVersion_() + '\\x22...',
    '...\\x3c!--RESUMERAGBOT_VERSION=' + gas.appVersion_() + '--\\x3e...'
  ]) {
    state.response = () => ({ text });
    assert.equal(gas.checkDeployment().status, 'ready');
  }
  state.response = () => ({ text: 'LINE 履歷助理已部署。版本 0.9.0' });
  assert.equal(gas.checkDeployment().status, 'version_mismatch');
});

test('a confirmed editor/deployment mismatch stops both manual and hourly rebuilds before touching a working index', () => {
  const { gas, state } = fixture();
  gas.syncKnowledgeBase();
  const id = state.properties.get('INDEX_FILE_ID');
  const fingerprint = state.properties.get('INDEX_FINGERPRINT');
  const embeddingsBefore = state.calls.filter(call => call.url.endsWith(':batchEmbedContents')).length;
  state.properties.set('WEB_APP_URL', publicUrl);
  state.response = () => ({ text: 'LINE 履歷助理已部署。版本 0.9.0' });
  for (const sync of [() => gas.syncKnowledgeBase(), () => gas.syncKnowledgeBase_()]) {
    assert.throws(sync, /DEPLOYMENT_VERSION_MISMATCH/);
    assert.equal(state.properties.get('INDEX_FILE_ID'), id);
    assert.equal(state.properties.get('INDEX_FINGERPRINT'), fingerprint);
    assert.equal(state.files.get(id).trashed, false);
    assert.equal(state.properties.get('SYNC_LEASE'), undefined);
  }
  assert.equal(state.calls.filter(call => call.url.endsWith(':batchEmbedContents')).length, embeddingsBefore);
  const setup = gas.checkSetup();
  assert.equal(setup.index, 'ready', 'a version mismatch does not erase compatible indexed content');
  assert.equal(setup.deploymentCheck.status, 'version_mismatch');
  assert(setup.nextSteps.some(step => step.includes('版本不一致') && step.includes('管理部署')));
  assert(!setup.nextSteps.some(step => step.includes('索引尚未就緒')));
  assert.match(gas.ragErrorMessage_(new Error('DEPLOYMENT_VERSION_MISMATCH')), /現有索引已保留/);
});

test('after the public deployment matches, an unchanged source reuses its working index', () => {
  const f = fixture();
  f.gas.syncKnowledgeBase();
  const id = f.state.properties.get('INDEX_FILE_ID');
  f.state.properties.set('WEB_APP_URL', publicUrl);
  const result = f.gas.syncKnowledgeBase();
  assert.equal(result.status, 'unchanged');
  assert.equal(result.deploymentCheck, 'ready');
  assert.equal(f.state.properties.get('INDEX_FILE_ID'), id);
  assert.equal(f.state.calls.filter(call => call.url.endsWith(':batchEmbedContents')).length, 1);
});

test('HTTP errors, login pages and network errors are unknown versions rather than false mismatches', () => {
  for (const [response, expected] of [
    [() => ({ status: 403, text: 'private HTTP payload' }), 'unreachable'],
    [() => ({ text: '<html>Please sign in</html>' }), 'unrecognized'],
    [() => { throw new Error('private network payload'); }, 'unreachable']
  ]) {
    const { gas, state } = fixture();
    state.properties.set('WEB_APP_URL', publicUrl);
    state.response = call => isProbe(call) ? response() : {
      body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) }
    };
    const result = gas.checkDeployment();
    assert.equal(result.status, expected);
    assert.equal(result.webAppVersion, null);
    assert(!JSON.stringify(result).includes('private'));
    assert.equal(gas.syncKnowledgeBase().status, 'ok', 'an unknown version does not become a false hard stop');
  }
});

test('legacy index metadata is informational: unchanged processing does not force a rebuild after a patch update', () => {
  const { gas, state } = fixture();
  gas.syncKnowledgeBase();
  const id = state.properties.get('INDEX_FILE_ID'), file = state.files.get(id);
  const legacy = JSON.parse(file.content);
  delete legacy.builtWithAppVersion;
  file.content = JSON.stringify(legacy);
  state.properties.set('WEB_APP_URL', publicUrl);
  assert.equal(gas.checkSetup().index, 'ready');
  assert.equal(gas.checkSetup().indexBuiltWith, 'unknown');
  assert.equal(gas.previewImageText().version, gas.appVersion_());
  assert.equal(gas.syncKnowledgeBase().status, 'unchanged');
  assert.equal(state.properties.get('INDEX_FILE_ID'), id);
  assert.equal(state.calls.filter(call => call.url.endsWith(':batchEmbedContents')).length, 1);
});

test('an index from an older compatible application patch remains ready when source processing is unchanged', () => {
  const { gas, state } = fixture();
  const currentVersion = gas.appVersion_;
  gas.appVersion_ = () => '1.2.1';
  gas.syncKnowledgeBase();
  const id = state.properties.get('INDEX_FILE_ID');
  gas.appVersion_ = currentVersion;
  state.properties.set('WEB_APP_URL', publicUrl);
  const setup = gas.checkSetup();
  assert.equal(setup.deploymentCheck.status, 'ready');
  assert.equal(setup.index, 'ready');
  assert.equal(setup.indexBuiltWith, '1.2.1');
  assert.equal(gas.syncKnowledgeBase().status, 'unchanged');
  assert.equal(state.properties.get('INDEX_FILE_ID'), id);
  assert.equal(state.calls.filter(call => call.url.endsWith(':batchEmbedContents')).length, 1);
});
