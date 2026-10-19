function doGet() {
  return webhookOutput_('LINE 履歷助理已部署。版本 ' + appVersion_());
}

function doPost(e) {
  if (!e) {
    console.log('doPost 需要 LINE Webhook 事件，請勿在編輯器直接測試。初次設定請執行 initializeProject；檢查設定請執行 checkSetup。');
    return webhookOutput_('請透過 LINE 傳送訊息測試，或在編輯器執行 checkSetup。');
  }
  try {
    var cfg = config_();
    // Shared URL token: access control, not proof that a request originated from LINE.
    verifyWebhookToken_(e && e.parameter && e.parameter.key, cfg.webhookToken);
    var body = e && e.postData && e.postData.contents;
    if (typeof body !== 'string' || body.length > 180000) throw new Error('INVALID_BODY');
    var payload = JSON.parse(body);
    if (!payload || !Array.isArray(payload.events) || payload.events.length > 100) throw new Error('INVALID_EVENTS');
    var receivedAt = Date.now();
    payload.events.forEach(function (event) {
      try {
        if (Date.now() - receivedAt > 45000) { safeLog_('BATCH_DEADLINE'); return; }
        handleEvent_(event, cfg);
      } catch (error) { safeLog_(errorCode_(error)); }
    });
    return webhookOutput_('OK');
  } catch (error) {
    safeLog_(errorCode_(error));
    return webhookOutput_('Ignored');
  }
}

function webhookOutput_(message) {
  // Avoid ContentService's response redirect when acknowledging LINE webhooks.
  return HtmlService.createHtmlOutput(message);
}

function verifyWebhookToken_(provided, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('MISSING_WEBHOOK_TOKEN');
  if (typeof provided !== 'string' || !constantEqual_(provided, expected)) throw new Error('INVALID_WEBHOOK_TOKEN');
}

function constantEqual_(a, b) {
  if (a.length !== b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function eventKey_(event) {
  var id = event.webhookEventId || (event.message && event.message.id) || event.replyToken;
  if (typeof id !== 'string' || !id) throw new Error('INVALID_EVENT_ID');
  return 'evt_' + sha256_(id).slice(0, 40);
}

function claimEvent_(key) {
  var lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    var props = PropertiesService.getScriptProperties(), now = Date.now();
    var previous = JSON.parse(props.getProperty(key) || 'null');
    if (previous && previous.until > now) return previous.state === 'done' ? 'duplicate' : 'busy';
    // Bounded persistent deduplication; no raw LINE IDs or message bodies stored here.
    var all = props.getProperties();
    Object.keys(all).filter(function (name) { return name.indexOf('evt_') === 0; }).forEach(function (name) {
      try { if (JSON.parse(all[name]).until <= now) props.deleteProperty(name); }
      catch (_) { props.deleteProperty(name); }
    });
    if (Object.keys(props.getProperties()).filter(function (n) { return n.indexOf('evt_') === 0; }).length >= 1800) {
      throw new Error('EVENT_CAPACITY');
    }
    props.setProperty(key, JSON.stringify({ state: 'busy', until: now + 7 * 60 * 1000 }));
    return 'claimed';
  } finally { lock.releaseLock(); }
}

function handleEvent_(event, cfg) {
  if (!event || event.mode === 'standby' || !event.source || event.source.type !== 'user' ||
      typeof event.source.userId !== 'string' || typeof event.replyToken !== 'string' || !event.replyToken ||
      ['follow', 'message', 'postback'].indexOf(event.type) < 0) return 'ignored';
  var key = eventKey_(event), claim = claimEvent_(key);
  if (claim === 'duplicate') return 'duplicate';
  if (claim === 'busy') throw new Error('EVENT_BUSY');
  try {
    var messages;
    var text = event.type === 'message' && event.message && event.message.type === 'text' ? event.message.text : '';
    if (event.type === 'postback') text = event.postback && event.postback.data || '';
    text = typeof text === 'string' ? text.trim() : '';
    if (!cfg.enabled) messages = [textMessage_('履歷助理目前暫停服務，請稍後再試。')];
    else if (event.type === 'follow' || /^(選單|首頁|menu|開始)$/i.test(text)) messages = [welcomeMessage_(cfg)];
    else if (/^(使用說明|說明|help)$/i.test(text)) messages = [textMessage_(helpText_())];
    else if (/^(隱私|privacy)$/i.test(text)) messages = [textMessage_(privacyText_())];
    else if (!text) messages = [textMessage_('請輸入文字問題，或點選下方的履歷主題。')];
    else if (text.length > 800) messages = [textMessage_('請將問題縮短至 800 字以內；你也可以分開詢問不同的經歷或專案。')];
    else {
      var questions = {
        '個人介紹': '請根據公開履歷，用 30 秒介紹這位求職者的背景、專長與求職方向。',
        '專業技能': '有哪些專業技能？請用履歷中的經驗或作品舉例。',
        '工作經歷': '請整理主要工作經歷、職務和具體成果。',
        '專案作品': '有哪些代表專案？請說明問題、本人負責內容、技術與成果。',
        '聯絡方式': '履歷提供哪些公開聯絡方式與作品連結？請保留原文。'
      };
      startLoading_(event.source.userId, cfg);
      try { messages = [textMessage_(answerQuestion_(questions[text] || text, cfg, text))]; }
      catch (error) {
        safeLog_(errorCode_(error));
        messages = [textMessage_(ragErrorMessage_(error))];
      }
    }
    var result = lineReply_(event.replyToken, messages, cfg);
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({ state: 'done', until: Date.now() + 86400000 }));
    return result;
  } catch (error) {
    PropertiesService.getScriptProperties().deleteProperty(key);
    throw error;
  }
}
