import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFixture } from './job-match-fixture.mjs';

const aiCalls = f => f.state.calls.filter(c => c.url.includes('generativelanguage')).length;

// ===== Task 1：入口、草稿與文字輸入 =====

test('jm:start opens an input draft and texts accumulate without AI calls', () => {
  const f = jobFixture();
  let m = f.send('jm:start', { postback: true });
  assert.match(m[0].text, /貼上職缺/); assert.match(m[0].text, /截圖/);
  f.send('職稱：資料分析師'); m = f.send('必要：熟悉 Python');
  assert.match(m[0].text, /第 2 段/);
  assert.equal(f.draft().texts.length, 2);
  assert.equal(aiCalls(f), 0);
});

test('typed 職缺對照 also starts a draft', () => {
  const f = jobFixture(); f.send('職缺對照');
  assert.equal(f.draft().stage, 'input');
});

test('text over 6000 chars total is refused, not truncated', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  f.send('甲'.repeat(5000)); const m = f.send('乙'.repeat(1001));
  assert.match(m[0].text, /6000/); assert.equal(f.draft().texts.length, 1);
});

test('job text longer than 800 chars is accepted while a draft is open', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  const m = f.send('職'.repeat(1500));
  assert.match(m[0].text, /第 1 段/); assert.equal(aiCalls(f), 0);
});

test('pasted job text mentioning interviews stays in the job draft', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  const m = f.send('通過書審後想約面試');
  assert.match(m[0].text, /第 1 段/);
  assert.equal(f.draft().texts[0], '通過書審後想約面試');
});

test('invitation draft keeps priority over job match', () => {
  const f = jobFixture(); f.send('invite:start', { postback: true });
  f.send('職缺對照');
  assert.equal(f.draft(), null);
  assert.equal(f.gas.invitationDraft_(f.gas.invitationKey_('user-1', f.gas.config_())).fields.company, '職缺對照');
});

test('two visitors keep separate drafts; home and cancel clear', () => {
  const f = jobFixture();
  f.send('jm:start', { postback: true }); f.send('jm:start', { postback: true, user: 'user-2' });
  f.send('A 公司職缺'); assert.equal(f.draft('user-2').texts.length, 0);
  f.send('首頁'); assert.equal(f.draft(), null);
  const m = f.send('jm:cancel', { postback: true, user: 'user-2' });
  assert.match(m[0].text, /已取消/); assert.equal(f.draft('user-2'), null);
});

test('contact and invitation entry points end the job draft', () => {
  for (const [text, postback] of [['nav:contact', true], ['invite:start', true]]) {
    const f = jobFixture(); f.send('jm:start', { postback: true });
    f.send(text, { postback }); assert.equal(f.draft(), null, text);
  }
});

test('evicted draft never reaches RAG', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.state.cache.clear();
  const m = f.send('必要：熟悉 Python');
  assert.match(m[0].text, /已過期/);
  assert.equal(aiCalls(f), 0);
  assert.equal(f.state.documentWrites, 0);
  // 旗標只攔一次，之後回到一般問答。
  f.send('有哪些技能？'); assert(aiCalls(f) > 0);
});

test('quick reply shows 職缺對照 third and stays within 6 items', () => {
  const f = jobFixture(); f.send('首頁');
  const home = f.state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  const items = home.quickReply.items;
  assert.equal(items[2].action.data, 'jm:start'); assert.equal(items[2].action.label, '職缺對照');
  assert(items.length <= 6);
  assert(JSON.stringify(home.contents.contents[2]).includes('jm:start'));
});
