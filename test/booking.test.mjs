import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobFixture } from './job-match-fixture.mjs';

const plain = v => JSON.parse(JSON.stringify(v));
const conf = { enabled: true, startHour: 10, endHour: 17, days: 7, minutes: 60 };
const H = 3600000;

/** 假日曆：記錄建立的事件，並把它們當成忙碌時段。 */
function calendar(f, busy = []) {
  const cal = { events: busy.map(([s, e]) => ({ s, e })), created: [] };
  f.gas.CalendarApp = { getDefaultCalendar: () => ({
    getEvents: (from, to) => cal.events.filter(ev => ev.s < to.getTime() && ev.e > from.getTime())
      .map(ev => ({ getStartTime: () => new Date(ev.s), getEndTime: () => new Date(ev.e) })),
    createEvent: (title, start, end, options) => {
      cal.created.push({ title, start: start.getTime(), end: end.getTime(), options });
      cal.events.push({ s: start.getTime(), e: end.getTime() });
      return { getId: () => 'event-' + cal.created.length };
    } }) };
  return cal;
}

/** 走完 v2 邀約並送出，回傳邀約 id。 */
function submitted(f, user = 'user-1') {
  f.send('invite:start', { postback: true, user });
  const draft = () => f.gas.invitationDraft_(f.gas.invitationKey_(user, f.gas.config_()));
  f.send('青禾公司／王小姐', { user }); f.send('邀請面試資料分析師', { user }); f.send('hr@company.tw', { user });
  f.send('invite:skip:' + draft().id, { postback: true, user });
  const id = draft().id; const receipt = f.send('invite:submit:' + id, { postback: true, user });
  return { id, receipt };
}

const enabled = { INTERVIEW_BOOKING: 'true' };

test('freeSlots_ skips busy ranges and returns Taipei hours regardless of runtime timezone', () => {
  const { gas } = jobFixture();
  const mon9 = Date.UTC(2026, 10, 9, 1, 0); // 2026-11-09（一）09:00 台北
  const slots = gas.freeSlots_(mon9, [{ start: Date.UTC(2026, 10, 9, 4), end: Date.UTC(2026, 10, 9, 6) }], conf);
  assert.deepEqual(plain(slots.map(ms => new Date(ms).toISOString())),
    ['2026-11-09T03:00:00.000Z', '2026-11-09T06:00:00.000Z', '2026-11-09T07:00:00.000Z']);
});

test('freeSlots_ skips weekends and the end of the working day', () => {
  const { gas } = jobFixture();
  const fri16 = Date.UTC(2026, 10, 13, 8, 0); // 2026-11-13（五）16:00 台北
  const slots = gas.freeSlots_(fri16, [], conf);
  assert.equal(new Date(slots[0]).toISOString(), '2026-11-16T02:00:00.000Z'); // 下週一 10:00
  assert.equal(slots.length, 3);
});

test('freeSlots_ returns nothing when the window is fully busy', () => {
  const { gas } = jobFixture();
  const mon9 = Date.UTC(2026, 10, 9, 1, 0);
  assert.equal(gas.freeSlots_(mon9, [{ start: mon9, end: mon9 + 30 * 24 * H }], conf).length, 0);
});

test('bookingConfig_ defaults to disabled and rejects malformed hours', () => {
  assert.equal(jobFixture().gas.bookingConfig_().enabled, false);
  assert.deepEqual(plain(jobFixture({ properties: enabled }).gas.bookingConfig_()), conf);
  assert.throws(() => jobFixture({ properties: { ...enabled, INTERVIEW_HOURS: '18-9' } }).gas.bookingConfig_(), /CONFIG_INTERVIEW_HOURS/);
});

test('booking is unavailable when disabled, and receipt has no booking button', () => {
  const f = jobFixture(); calendar(f);
  const { id, receipt } = submitted(f);
  assert(!JSON.stringify(receipt).includes('book:list'));
  assert.match(f.send('book:list:' + id, { postback: true })[0].text, /未開放/);
});

test('booking requires a submitted invitation of the same visitor', () => {
  const f = jobFixture({ properties: enabled }); calendar(f);
  assert.match(f.send('book:list:' + 'a'.repeat(32), { postback: true })[0].text, /找不到可預約的邀約/);
  const { id } = submitted(f);
  assert.match(f.send('book:list:' + id, { postback: true, user: 'user-2' })[0].text, /找不到可預約的邀約/);
});

test('receipt offers booking and the list shows three slot buttons', () => {
  const f = jobFixture({ properties: enabled }); calendar(f);
  const { id, receipt } = submitted(f);
  assert(receipt[0].quickReply.items.some(i => i.action.data === 'book:list:' + id));
  const m = f.send('book:list:' + id, { postback: true });
  const picks = m[0].quickReply.items.filter(i => i.action.data.startsWith('book:pick:' + id + ':'));
  assert.equal(picks.length, 3); assert.match(picks[0].action.label, /^\d{2}\/\d{2}（.）\d{2}:00$/);
});

test('pick creates one tentative event without guests and repeated pick does not duplicate', () => {
  const f = jobFixture({ properties: enabled }); const cal = calendar(f);
  const { id } = submitted(f);
  const pick = f.send('book:list:' + id, { postback: true })[0].quickReply.items.find(i => i.action.data.startsWith('book:pick:')).action.data;
  const m = f.send(pick, { postback: true });
  assert.match(m[0].text, /已暫定/);
  assert.equal(cal.created.length, 1);
  assert.match(cal.created[0].title, /^【暫定】面談：青禾公司／王小姐/);
  assert.equal(cal.created[0].end - cal.created[0].start, H);
  assert(!('guests' in cal.created[0].options)); assert.match(cal.created[0].options.description, /hr@company\.tw/);
  const record = f.gas.loadPortfolioStore_(f.gas.config_()).invitations[id];
  assert.equal(record.booking.eventId, 'event-1');
  assert.match(f.send(pick, { postback: true })[0].text, /已預約/);
  assert.equal(cal.created.length, 1);
});

test('second pick of a taken slot relists', () => {
  const f = jobFixture({ properties: enabled }); const cal = calendar(f);
  const a = submitted(f, 'user-1'), b = submitted(f, 'user-2');
  const pickA = f.send('book:list:' + a.id, { postback: true, user: 'user-1' })[0].quickReply.items.find(i => i.action.data.startsWith('book:pick:')).action.data;
  const startMs = pickA.split(':').at(-1);
  f.send(pickA, { postback: true, user: 'user-1' });
  const m = f.send('book:pick:' + b.id + ':' + startMs, { postback: true, user: 'user-2' });
  assert.match(m[0].text, /剛被預約/);
  assert(m[0].quickReply.items.some(i => i.action.data.startsWith('book:pick:' + b.id + ':') && !i.action.data.endsWith(startMs)));
  assert.equal(cal.created.length, 1);
});

test('pick outside working hours is refused', () => {
  const f = jobFixture({ properties: enabled }); const cal = calendar(f);
  const { id } = submitted(f);
  const m = f.send('book:pick:' + id + ':' + (Date.now() + 3 * H + 7 * 60000), { postback: true });
  assert.match(m[0].text, /剛被預約|無法預約/); assert.equal(cal.created.length, 0);
});

test('owner is notified by email and LINE after booking', () => {
  const f = jobFixture({ properties: { ...enabled, OWNER_LINE_USER_ID: 'U' + '1'.repeat(32) },
    text: '[[PUBLIC]]\n## 專業技能\nPython、SQL 資料分析。\n## 公開聯絡方式\nEmail：resume@company.tw\n[[/PUBLIC]]' });
  calendar(f); const { id } = submitted(f);
  const emailsBefore = f.state.emails.length, pushBefore = f.state.calls.filter(c => c.url.endsWith('/message/push')).length;
  const pick = f.send('book:list:' + id, { postback: true })[0].quickReply.items.find(i => i.action.data.startsWith('book:pick:')).action.data;
  f.send(pick, { postback: true });
  assert.equal(f.state.emails.length, emailsBefore + 1); assert.match(f.state.emails.at(-1).subject, /暫定面談/);
  assert.equal(f.state.calls.filter(c => c.url.endsWith('/message/push')).length, pushBefore + 1);
});

test('manifest adds calendar scope', () => {
  const manifest = JSON.parse(readFileSync(new URL('../gas/appsscript.json', import.meta.url), 'utf8'));
  assert(manifest.oauthScopes.includes('https://www.googleapis.com/auth/calendar'));
});
