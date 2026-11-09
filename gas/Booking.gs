/**
 * 【V3 候選加分：真實日曆預約】
 * 預設關閉。主人設定 INTERVIEW_BOOKING=true 後，送出邀約的訪客可以從主人 Google 日曆的空檔選一個時段。
 * 只建立「【暫定】」事件、不邀請任何人；選定前在鎖內再查一次，避免兩人搶到同一時段。
 */

var TAIPEI_OFFSET_MS_ = 8 * 3600000; // 台灣不實施夏令時間，固定 UTC+8，與執行環境時區無關。
var BOOKING_LEAD_MS_ = 2 * 3600000;  // 至少預留 2 小時，不讓人資約「等一下」。

/** 讀取預約設定；格式錯誤明確報錯，不帶著錯誤設定執行。 */
function bookingConfig_() {
  var p = PropertiesService.getScriptProperties();
  var get = function (key, fallback) { return String(p.getProperty(key) || '').trim() || fallback; };
  var hours = /^(\d{1,2})-(\d{1,2})$/.exec(get('INTERVIEW_HOURS', '10-17'));
  if (!hours || Number(hours[1]) >= Number(hours[2]) || Number(hours[2]) > 24) throw new Error('CONFIG_INTERVIEW_HOURS');
  var days = Number(get('INTERVIEW_DAYS', '7')), minutes = Number(get('INTERVIEW_MINUTES', '60'));
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('CONFIG_INTERVIEW_DAYS');
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) throw new Error('CONFIG_INTERVIEW_MINUTES');
  return { enabled: get('INTERVIEW_BOOKING', 'false').toLowerCase() === 'true',
    startHour: Number(hours[1]), endHour: Number(hours[2]), days: days, minutes: minutes };
}

/** 這個起點是否為合法的面談時段：整點、平日、上班時間內、在預約範圍內。 */
function bookingSlotAllowed_(startMs, nowMs, conf) {
  if (startMs % 3600000 !== 0 || startMs < nowMs + BOOKING_LEAD_MS_ || startMs > nowMs + conf.days * 86400000) return false;
  var local = new Date(startMs + TAIPEI_OFFSET_MS_), day = local.getUTCDay(), hour = local.getUTCHours();
  return day >= 1 && day <= 5 && hour >= conf.startHour && hour * 60 + conf.minutes <= conf.endHour * 60;
}

function bookingOverlaps_(startMs, conf, busy) {
  var endMs = startMs + conf.minutes * 60000;
  return busy.some(function (b) { return b.start < endMs && b.end > startMs; });
}

/** 從 now 起逐小時找，回傳最多 3 個沒有行程的起始時間（毫秒）。 */
function freeSlots_(nowMs, busy, conf) {
  var slots = [], start = Math.ceil((nowMs + BOOKING_LEAD_MS_) / 3600000) * 3600000;
  for (var t = start; t <= nowMs + conf.days * 86400000 && slots.length < 3; t += 3600000) {
    if (bookingSlotAllowed_(t, nowMs, conf) && !bookingOverlaps_(t, conf, busy)) slots.push(t);
  }
  return slots;
}

/** 按鈕文字：11/12（四）10:00（台北時間）。 */
function bookingSlotLabel_(ms) {
  var d = new Date(ms + TAIPEI_OFFSET_MS_), pad = function (n) { return ('0' + n).slice(-2); };
  return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '（' + '日一二三四五六'[d.getUTCDay()] + '）' + pad(d.getUTCHours()) + ':00';
}

function calendarBusy_(fromMs, toMs) {
  return CalendarApp.getDefaultCalendar().getEvents(new Date(fromMs), new Date(toMs)).map(function (e) {
    return { start: e.getStartTime().getTime(), end: e.getEndTime().getTime() };
  });
}

/** 列出空檔按鈕；沒有空檔時請改用邀約中的聯繫方式。 */
function bookingListMessage_(record, conf, prefix) {
  var now = Date.now(), slots = freeSlots_(now, calendarBusy_(now, now + conf.days * 86400000 + 86400000), conf);
  if (!slots.length) return [textMessage_((prefix || '') + '近期沒有可預約的時段，本人會透過您在邀約中留下的方式與您聯繫。')];
  var message = textMessage_((prefix || '') + '請選擇面談時段（台北時間，每場 ' + conf.minutes + ' 分鐘）。選定後會先標記為暫定，由本人確認後回覆。');
  message.quickReply = { items: slots.map(function (ms) {
    return { type: 'action', action: { type: 'postback', label: bookingSlotLabel_(ms), data: 'book:pick:' + record.id + ':' + ms, displayText: '預約 ' + bookingSlotLabel_(ms) } };
  }) };
  return [message];
}

/** 通知本人：Email 寄到 Doc 公開信箱、LINE 推播到已設定的本人；任一失敗都不影響預約結果。 */
function notifyBooking_(record, cfg) {
  var when = bookingSlotLabel_(record.booking.start);
  var text = '已有暫定面談時段：' + when + '（台北時間）\n\n公司與稱呼：' + (record.fields.company || '') +
    '\n回覆方式：' + (record.fields.replyTo || '') + '\n\n事件已加入您的 Google 日曆並標記為【暫定】，請確認後回覆對方。';
  try {
    var contact = publicContact_(cfg);
    if (contact.available && MailApp.getRemainingDailyQuota() > 0) {
      MailApp.sendEmail({ to: contact.email, subject: '【履歷助理】暫定面談時段 ' + when, body: text });
    }
  } catch (_) { safeLog_('BOOKING_EMAIL_FAILED'); }
  var ownerId = ownerLineUserId_();
  if (ownerId) sendOwnerLineText_(ownerId, text, cfg, Utilities.getUuid());
}

/** 處理 book:list／book:pick；不是預約指令時回傳 null。 */
function handleBooking_(event, text, cfg) {
  var parts = /^book:(list|pick):([a-f0-9]{32})(?::(\d{13}))?$/.exec(text);
  if (!/^book:/.test(text)) return null;
  var conf;
  try { conf = bookingConfig_(); } catch (error) { safeLog_(errorCode_(error)); return [textMessage_('線上預約設定有誤，請透過邀約中的聯繫方式與本人約時間。')]; }
  if (!conf.enabled) return [textMessage_('目前未開放線上預約，本人會透過您在邀約中留下的方式與您聯繫。')];
  if (!parts) return [textMessage_('這張卡片已失效，請重新選擇「預約面談時段」。')];
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var store = loadPortfolioStore_(cfg), record = (store.invitations || {})[parts[2]];
    if (!record || record.visitor !== invitationVisitor_(event.source.userId)) return [textMessage_('找不到可預約的邀約。請先在 LINE 留下邀約並確認送出。')];
    if (record.booking) return [textMessage_('這份邀約已預約 ' + bookingSlotLabel_(record.booking.start) + '（暫定），請等候本人確認。')];
    try {
      if (parts[1] === 'list') return bookingListMessage_(record, conf);
      var start = Number(parts[3]), now = Date.now();
      if (!bookingSlotAllowed_(start, now, conf)) return bookingListMessage_(record, conf, '這個時段無法預約。');
      if (bookingOverlaps_(start, conf, calendarBusy_(start, start + conf.minutes * 60000))) return bookingListMessage_(record, conf, '這個時段剛被預約，請改選其他時段。\n\n');
      var end = start + conf.minutes * 60000;
      var created = CalendarApp.getDefaultCalendar().createEvent('【暫定】面談：' + (record.fields.company || 'LINE 訪客'), new Date(start), new Date(end), {
        description: '由履歷助理 LINE 邀約建立，尚待本人確認。\n\n職缺或合作內容：\n' + (record.fields.message || '') +
          '\n\n回覆方式：' + (record.fields.replyTo || '') });
      record.booking = { start: start, end: end, eventId: created.getId(), createdAt: new Date().toISOString() };
      savePortfolioStore_(store, cfg);
    } catch (error) {
      safeLog_('BOOKING_' + errorCode_(error));
      return [textMessage_('目前無法讀取或寫入日曆，請透過邀約中的聯繫方式與本人約時間。')];
    }
    notifyBooking_(record, cfg);
    return [textMessage_('時段 ' + bookingSlotLabel_(record.booking.start) + '（台北時間）已暫定，本人確認後會透過您留下的方式回覆。這不代表面試已確定。')];
  } finally { lock.releaseLock(); }
}
