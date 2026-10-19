import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, unitVector } from './harness.mjs';

function fresh() {
  return createGas({ properties: { RESUME_DOC_ID: '', GEMINI_API_KEY: '', LINE_CHANNEL_ACCESS_TOKEN: '', WEBHOOK_TOKEN: '' } });
}

test('first run creates an editable sample resume and stores the real tab ID without API keys', () => {
  const { gas, state } = fresh();
  assert.throws(() => gas.readPublicSource_(gas.config_()), /MISSING_RESUME_DOC_ID/);
  const setup = gas.initializeProject();
  assert.equal(state.createdDocuments.length, 1);
  assert.equal(state.properties.get('RESUME_DOC_ID'), state.createdDocuments[0].getId());
  assert.equal(state.properties.get('DOC_TAB_IDS'), 'created-tab-1');
  assert.equal(setup.document, 'ready');
  assert.equal(setup.publicChunks, 11);
  assert.equal(setup.index, 'missing');
  assert.equal(setup.credentials.WEBHOOK_TOKEN, true);
  assert.equal(setup.credentials.GEMINI_API_KEY, false);
  assert.equal(setup.credentials.LINE_CHANNEL_ACCESS_TOKEN, false);
  assert(setup.documentUrl.includes(state.createdDocuments[0].getId()));
  assert(state.text.includes('虛構'));
  assert(!JSON.stringify(gas.readPublicSource_(gas.config_()).chunks).includes('PRIVATE_ONLY_DEMO_8421'));
  assert.equal(state.calls.length, 0);
  state.text += '\n學生修改的私人備註';
  const token = state.properties.get('WEBHOOK_TOKEN');
  gas.initializeProject();
  assert.equal(state.createdDocuments.length, 1);
  assert(state.text.endsWith('學生修改的私人備註'));
  assert.equal(state.properties.get('WEBHOOK_TOKEN'), token);
});

test('initialization preserves an existing student document and configuration', () => {
  const text = '[[PUBLIC]]\n## 個人介紹\n學生自己的履歷\n[[/PUBLIC]]';
  const { gas, state } = createGas({ text, properties: { RESUME_DOC_ID: 'student-chosen-document', DOC_TAB_IDS: '*' } });
  assert.equal(gas.initializeProject().document, 'ready');
  assert.equal(state.createdDocuments.length, 0);
  assert.equal(state.documentWrites, 0);
  assert.equal(state.text, text);
  assert.equal(state.properties.get('DOC_TAB_IDS'), '*');
});

test('a failed sample document creation does not leave a broken configured document', () => {
  for (const flag of ['createError', 'saveError']) {
    const { gas, state } = fresh();
    state[flag] = true;
    assert.throws(() => gas.initializeProject(), /STARTER_DOC_CREATE_FAILED/);
    assert.equal(state.properties.get('RESUME_DOC_ID'), '');
    assert(state.createdDocuments.every(doc => doc.isTrashed()));
    assert(!state.logs.some(log => log.includes('private-')));
    assert.equal(state.calls.length, 0);
  }
});

test('a fresh student installation can initialize, sync and resolve its own webhook URL', () => {
  const { gas, state } = fresh();
  gas.initializeProject();
  state.properties.set('GEMINI_API_KEY', 'student-test-key');
  state.properties.set('LINE_CHANNEL_ACCESS_TOKEN', 'student-test-token');
  const url = 'https://script.google.com/macros/s/student-public-deployment/exec';
  state.properties.set('WEB_APP_URL', url);
  state.response = call => ({ body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } });
  assert.equal(gas.syncKnowledgeBase().status, 'ok');
  const setup = gas.checkSetup();
  assert.equal(setup.index, 'ready');
  assert(Object.values(setup.credentials).every(Boolean));
  assert.equal(gas.showWebhookUrl(), url + '?key=' + state.properties.get('WEBHOOK_TOKEN'));
});
