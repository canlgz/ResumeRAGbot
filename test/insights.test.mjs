import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

const input = events => ({ parameter: { key: 'a'.repeat(64) }, postData: { contents: JSON.stringify({ events }) } });
const OWNER = 'U' + 'b'.repeat(32);

function setup(options = {}) {
  const fixture = createGas({
    text: '[[PUBLIC]]\n## 專案作品\n建立資料分析報表。\n[[/PUBLIC]]', properties: options.properties,
    response(call) {
      if (call.url.endsWith(':batchEmbedContents')) return { body: { embeddings: call.body.requests.map(() => ({ values: unitVector() })) } };
      if (call.url.endsWith(':embedContent')) return { body: { embedding: { values: unitVector() } } };
      if (call.url.endsWith(':generateContent')) {
        const question = JSON.parse(call.body.contents[0].parts[0].text).question;
        const grounded = !/駕照|license/i.test(question);
        return { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(grounded ?
          { grounded, answer: '我建立過資料分析報表。', evidence: [{ id: 'S1', quote: '建立資料分析報表' }], dialogueIntent: 'capability' } :
          { grounded, answer: '目前公開履歷未提供這項資訊', evidence: [], dialogueIntent: 'neutral' }) }] } }] } };
      }
      if (call.url.endsWith('/message/push')) return { status: 200, body: {} };
      return { body: {} };
    }
  });
  fixture.gas.syncKnowledgeBase();
  fixture.state.calls.length = 0;
  const send = (text, id, userId = 'user-1') => {
    const e = event(text, id); e.source.userId = userId;
    fixture.gas.doPost(input([e]));
    return fixture.state.calls.filter(call => call.url.endsWith('/message/reply')).at(-1).body.messages.map(m => m.text || '').join('\n');
  };
  const week = () => fixture.gas.insightWeekKey_(new Date());
  const stats = () => JSON.parse(fixture.state.properties.get('INSIGHT_' + week()));
  return { ...fixture, send, week, stats };
}

test('week keys use the Taipei Monday, including late Sunday UTC that is already Monday in Taipei', () => {
  const { gas } = createGas();
  assert.equal(gas.insightWeekKey_(new Date('2026-11-11T03:00:00Z')), '2026-11-09'); // 週三
  assert.equal(gas.insightWeekKey_(new Date('2026-11-15T15:30:00Z')), '2026-11-09'); // 台北週日 23:30
  assert.equal(gas.insightWeekKey_(new Date('2026-11-15T16:30:00Z')), '2026-11-16'); // 台北週一 00:30
});

test('answered, missing and English questions are counted anonymously without question text or userId', () => {
  const f = setup();
  f.send('你做過什麼報表？', 'a1');
  f.send('What reports have you built?', 'a2');
  f.send('你有駕照嗎？', 'a3');
  const s = f.stats();
  assert.equal(s.total, 3);
  assert.equal(s.answered, 2);
  assert.equal(s.missing, 1);
  assert.deepEqual(s.languages, { zh: 2, en: 1 });
  assert.equal(s.sections['專案作品'], 2);
  assert.equal(s.intents.capability, 2);
  const stored = f.state.properties.get('INSIGHT_' + f.week());
  for (const secret of ['你做過什麼報表', 'What reports', '駕照', 'user-1']) assert(!stored.includes(secret), secret);
});

test('menus, help and language switches are not counted as questions', () => {
  const f = setup();
  f.send('選單', 'n1'); f.send('說明', 'n2'); f.send('English', 'n3');
  assert.equal(f.state.properties.get('INSIGHT_' + f.week()), undefined);
});

test('the weekly report gives counts, top sections and concrete next steps', () => {
  const f = setup();
  f.send('你做過什麼報表？', 'r1');
  f.send('What reports have you built?', 'r2');
  f.send('你有駕照嗎？', 'r3');
  const report = f.gas.insightReport_(f.week(), '測試履歷');
  assert.match(report, /測試履歷｜每週提問洞察/);
  assert.match(report, /提問數：3 題（成功回答 2、資料不足 1）/);
  assert.match(report, /回答率：67%/);
  assert.match(report, /英文 1 題/);
  assert.match(report, /1\. 專案作品 2 次/);
  assert.match(report, /待補充問題/);
  assert.match(report, /英文名稱/);
  assert.match(f.gas.insightReport_('2020-01-06'), /這週還沒有訪客提問/);
});

test('only the configured owner can open the report from LINE; visitors fall through to normal Q&A', () => {
  const f = setup({ properties: { OWNER_LINE_USER_ID: OWNER } });
  f.send('你做過什麼報表？', 'o1');
  const owner = f.send('本週洞察', 'o2', OWNER);
  assert.match(owner, /每週提問洞察/);
  assert.match(owner, /上週回顧/);
  const visitor = f.send('本週洞察', 'o3', 'visitor-2');
  assert.doesNotMatch(visitor, /每週提問洞察/);
  assert.equal(f.stats().total, 2, 'the owner command itself is not counted; the visitor attempt is a normal question');
});

test('weekly trigger is installed once, sends last week by LINE when an owner is set, and email otherwise', () => {
  const f = setup({ properties: { OWNER_LINE_USER_ID: OWNER } });
  f.gas.installWeeklyInsight(); f.gas.installWeeklyInsight();
  const triggers = f.state.triggers.filter(t => t.getHandlerFunction() === 'sendWeeklyInsight_');
  assert.equal(triggers.length, 1);
  assert.deepEqual(triggers[0].schedule, { day: 'MONDAY', hour: 9 });
  assert.equal(f.gas.sendWeeklyInsight_().channel, 'line');
  const push = f.state.calls.find(call => call.url.endsWith('/message/push'));
  assert.equal(push.body.to, OWNER);
  assert.match(push.body.messages[0].text, /每週提問洞察/);
  f.state.properties.delete('OWNER_LINE_USER_ID');
  assert.deepEqual(f.gas.sendWeeklyInsight_().channel, 'email');
  assert.match(f.state.emails.at(-1).subject, /每週提問洞察/);
  f.gas.removeWeeklyInsight();
  assert.equal(f.state.triggers.length, 0);
});

test('only the last 8 weeks are kept and management functions are owner-only', () => {
  const f = setup();
  f.state.properties.set('INSIGHT_2020-01-06', JSON.stringify({ week: '2020-01-06', total: 1 }));
  f.send('你做過什麼報表？', 'k1');
  assert.equal(f.state.properties.get('INSIGHT_2020-01-06'), undefined);
  f.state.activeEmail = 'visitor@example.test';
  for (const fn of ['previewWeeklyInsight', 'installWeeklyInsight', 'removeWeeklyInsight']) assert.throws(() => f.gas[fn](), /OWNER_ONLY/);
});
