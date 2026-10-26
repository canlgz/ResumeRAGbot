/**
 * 【LINE 顯示與訊息傳送】
 * 本檔只負責將資料組成文字、貼圖與 Flex 首頁，以及呼叫 LINE API。
 * Quick Reply 使用同步後的同一份代表主題；操作指令不混入代表關鍵字。
 */

/**
 * 只顯示本次已確認有效的 3–6 個代表主題；不重新呼叫分類模型。
 */
function quickReply_() {
  if (MESSAGE_TOPICS_.length < 3 || MESSAGE_TOPICS_.length > 6) return undefined;
  return { items: MESSAGE_TOPICS_.map(function (topic) {
    return { type: 'action', action: { type: 'postback', label: topic.label, data: 'topic:' + topic.id, displayText: topic.label } };
  }) };
}

var LINE_STICKERS_ = {
  celebrate: { packageId: '11537', stickerId: '52002734' }, // 熊大慶祝（適合專案成果、代表作品、亮點成就）
  greet:     { packageId: '11537', stickerId: '52002735' }, // 熱情招呼（適合個人介紹、背景簡介、歡迎開場）
  thanks:    { packageId: '11537', stickerId: '52002739' }, // 熊大感謝（適合聯絡方式、作品連結、期待合作）
  confident: { packageId: '11537', stickerId: '52002740' }, // 兔兔沒問題（適合專業技能、工作經歷、職務適配）
  energetic: { packageId: '11537', stickerId: '52002741' }, // 莎莉跳躍（適合學歷學習、工作態度、求職熱忱）
  confused:  { packageId: '11537', stickerId: '52002744' }, // 熊大問號（適合履歷資料不足、待確認補充問題）
  happy:     { packageId: '11537', stickerId: '52002745' }  // 兔兔開心（適合一般正向熱絡交流）
};

/**
 * 從固定允許清單選貼圖，模型不能自行指定任意貼圖 ID。
 */
function stickerMessage_(mood) {
  var sticker = LINE_STICKERS_[mood];
  return sticker ? { type: 'sticker', packageId: sticker.packageId, stickerId: sticker.stickerId, quickReply: quickReply_() } : null;
}

/**
 * 建立 LINE 文字訊息，並附上相同的代表主題 Quick Reply。
 */
function textMessage_(text) {
  return { type: 'text', text: Array.from(String(text)).slice(0, 4500).join(''), quickReply: quickReply_() };
}

/**
 * 首頁按鈕與 Quick Reply 使用同一份履歷主題，沒有固定六類選單。
 */
function welcomeMessage_(cfg) {
  var buttons = MESSAGE_TOPICS_;
  return { type: 'flex', altText: cfg.name + '｜互動履歷，點選主題或直接提問', quickReply: quickReply_(),
    contents: { type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#143D35', paddingAll: '24px', contents: [
        { type: 'text', text: 'HELLO, LET’S CONNECT', size: 'xs', color: '#A9DEC8', weight: 'bold' },
        { type: 'text', text: cfg.name.slice(0, 50), size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'md', wrap: true },
        { type: 'text', text: cfg.tagline.slice(0, 150), size: 'sm', color: '#D4E9E2', margin: 'md', wrap: true }
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: '你想先了解哪個部分？', size: 'md', weight: 'bold', color: '#143D35', wrap: true },
        { type: 'text', text: '我是 AI 履歷助理。可點選從這份履歷整理出的代表主題，或直接提問。輸入「作品圖庫」看作品，輸入「清除對話」重新開始。', size: 'sm', color: '#53635E', wrap: true },
        { type: 'text', text: '提問會交由 Google AI 處理；資料不足的問題會記錄給履歷主人補充。輸入「隱私」了解詳情。', size: 'xs', color: '#687770', wrap: true }
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons.length ? buttons.map(function (topic, i) {
        return { type: 'button', style: i === 0 ? 'primary' : 'secondary',
          color: i === 0 ? '#23735B' : '#EEF4F0', height: 'sm', action: { type: 'postback', label: topic.label, data: 'topic:' + topic.id, displayText: topic.label } };
      }) : [{ type: 'text', text: '你可以直接輸入問題，或輸入「作品圖庫」。', size: 'sm', wrap: true }] }
    }
  };
}

/**
 * 訪客輸入「使用說明」時顯示的操作方法。
 */
function helpText_() {
  return '你可以直接提問，例如：\n• 請用 30 秒介紹這位求職者。\n• 有哪些工作經歷與具體成果？\n• 做過哪些與資料分析相關的專案？\n• 這份履歷有哪些符合產品經理職缺的條件？\n• 如何聯絡本人？\n\n約 10 分鐘內可接續追問同一件作品，例如「這張用了什麼配色？」；輸入「清除對話」可重新開始。短期記憶可能提早失效，屆時請補上作品名稱。回答依據公開履歷；找不到足夠資料的問題會記錄給履歷主人確認與補充。\n\n輸入「選單」回到首頁；輸入「隱私」查看資料使用方式。';
}

/**
 * 向訪客說明提問、短期記憶與待補充問題的資料使用方式。
 */
function privacyText_() {
  return '我是 AI 履歷助理，回答可能有誤，重要資訊請向本人確認。\n\n資料使用方式：\n• 僅使用履歷擁有者標示為公開的內容。\n• LINE 訊息由 Google Apps Script 處理，問題和檢索片段會送至 Google Gemini。\n• 資料不足的問題會寫入履歷主人的 Google 文件，包含問題文字、原因、時間與次數，供本人維護；不附上 LINE 使用者識別碼。\n• 使用雜湊識別的短期記憶，暫存近期問題及作品指向約 10 分鐘，不保存完整回答；輸入「清除對話」可立即清除。LINE 與 Google 本身仍適用各自的資料政策。\n• 使用者識別碼用於處理中動畫及產生短期記憶的雜湊鍵，不保存原始識別碼。事件識別碼以雜湊形式保存，處理狀態保留約一天以避免重複回覆。\n\n請勿傳送密碼、證件、薪資機密或其他敏感資料。';
}

/**
 * 先要求 LINE 顯示處理中動畫；動畫失敗不能阻止正常回答。
 */
function startLoading_(userId, cfg) {
  // 動畫失敗仍繼續回答，也不會為動畫先用掉 replyToken。
  try {
    requireValue_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN');
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.lineToken },
      payload: JSON.stringify({ chatId: userId, loadingSeconds: 60 }), muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    if (status >= 200 && status < 300) return true;
    safeLog_('LINE_LOADING_HTTP_' + status);
  } catch (_) { safeLog_('LINE_LOADING_FAILED'); }
  return false;
}

/**
 * 使用本次 replyToken 回覆一次，最多五則訊息。
 * Token 被拒時不擅自改用 Push 補送，避免重複訊息與額外費用。
 */
function lineReply_(token, messages, cfg) {
  requireValue_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN');
  var result = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.lineToken },
    payload: JSON.stringify({ replyToken: token, messages: messages }), muteHttpExceptions: true
  });
  var status = result.getResponseCode();
  if (status >= 200 && status < 300) return 'replied';
  // replyToken 只能使用一次；結果不明時不改用 Push，避免重複或額外計費。
  if (status === 400) { safeLog_('LINE_REPLY_400'); return 'reply_rejected'; }
  throw new Error('LINE_HTTP_' + status);
}
