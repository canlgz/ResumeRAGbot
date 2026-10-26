/**
 * 【主人 LINE 通知】收件人直接使用本頻道 Basic settings → Your user ID。
 * 主人 ID 存在 OWNER_LINE_USER_ID 指令碼屬性；不從訪客訊息推測、不使用 bot 自己的 ID。
 * 通知需要保存這個收件 ID，但不寫 Doc、不送 AI、不回傳給訪客。
 */
function ownerLineUserId_() {
  var value = String(PropertiesService.getScriptProperties().getProperty('OWNER_LINE_USER_ID') || '').trim();
  return /^U[0-9a-f]{32}$/.test(value) ? value : '';
}

/** 僅主人管理頁可設定接收通知的 LINE userId。空值代表停用 LINE 通知，Email 不受影響。 */
function setOwnerLineNotification(token, userId) {
  return reviewRpc_(token, function () {
    userId = String(userId || '').trim();
    if (userId && !/^U[0-9a-f]{32}$/.test(userId)) throw new Error('請填入本頻道 Your user ID，以 U 開頭、共 33 個字元。');
    var lock = LockService.getScriptLock(); lock.waitLock(5000);
    try { var props = PropertiesService.getScriptProperties();
      if (userId) props.setProperty('OWNER_LINE_USER_ID', userId); else props.deleteProperty('OWNER_LINE_USER_ID');
    } finally { lock.releaseLock(); }
    return { configured: !!userId };
  });
}

/** 已持鎖；先保存通知狀態與 retry key，再送出。LINE 失敗不影響 Email 和邀約保存。 */
function notifyInvitationLine_(store, record, cfg, options) {
  if (record.lineNotification) return;
  var state = { status: 'not_configured', updatedAt: new Date().toISOString() };
  record.lineNotification = state;
  function persist() { try { savePortfolioStore_(store, cfg); } catch (_) { safeLog_('INVITATION_LINE_STATUS_SAVE_FAILED'); } }
  if (options && options.skipNotification) { state.status = 'test_skipped'; persist(); return; }
  var ownerId = ownerLineUserId_();
  if (!ownerId) return;
  state.status = 'attempting'; state.retryKey = Utilities.getUuid();
  try { savePortfolioStore_(store, cfg); } catch (_) { state.status = 'not_attempted'; return; }
  var text = '您收到一份新邀約\n\n' + INVITATION_FIELDS_.map(function (field) {
    return field.label + '：\n' + (record.fields[field.key] || '不限定');
  }).join('\n\n') + '\n\n請透過對方留下的回覆方式聯繫。這則通知不代表面試或合作已排定。';
  Object.assign(state, sendOwnerLineText_(ownerId, text, cfg, state.retryKey));
  persist();
}

/** LINE 的 200／409 只表示平台已接受，不代表已送達或已讀。 */
function sendOwnerLineText_(ownerId, text, cfg, retryKey) {
  var state = {};
  try {
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', { method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.lineToken, 'X-Line-Retry-Key': retryKey },
      payload: JSON.stringify({ to: ownerId, messages: [{ type: 'text', text: text }] }), muteHttpExceptions: true });
    var code = response.getResponseCode();
    state.status = code === 200 || code === 409 ? 'sent' : code === 429 ? 'quota_or_rate_limit' : code >= 500 ? 'delivery_unknown' : 'rejected';
    state.httpStatus = code;
    if (state.status === 'sent') state.sentAt = new Date().toISOString();
  } catch (_) { state.status = 'delivery_unknown'; safeLog_('INVITATION_LINE_DELIVERY_UNKNOWN'); }
  return state;
}

/** 主人管理憑證驗證後，只向已設定的本人發送明確標記的測試通知。 */
function testOwnerLineNotification(token) {
  return reviewRpc_(token, function (cfg) {
    var id = ownerLineUserId_();
    if (!id) throw new Error('OWNER_LINE_USER_ID 尚未設定。');
    return sendOwnerLineText_(id, 'ResumeRAGbot：LINE 邀約通知測試\n\n您的通知收件人已設定。之後有人確認送出邀約，您會在這裡收到邀約內容與回覆方式；Email 通知也會保留。', cfg, Utilities.getUuid());
  });
}
