function quickReply_() {
  return { items: ['個人介紹', '專業技能', '工作經歷', '專案作品', '聯絡方式', '使用說明'].map(function (label) {
    return { type: 'action', action: { type: 'message', label: label, text: label } };
  }) };
}

function textMessage_(text) {
  return { type: 'text', text: Array.from(String(text)).slice(0, 4500).join(''), quickReply: quickReply_() };
}

function welcomeMessage_(cfg) {
  var buttons = ['個人介紹', '專業技能', '工作經歷', '專案作品', '聯絡方式'];
  return { type: 'flex', altText: cfg.name + '｜互動履歷，點選主題或直接提問', quickReply: quickReply_(),
    contents: { type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#143D35', paddingAll: '24px', contents: [
        { type: 'text', text: 'HELLO, LET’S CONNECT', size: 'xs', color: '#A9DEC8', weight: 'bold' },
        { type: 'text', text: cfg.name.slice(0, 50), size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'md', wrap: true },
        { type: 'text', text: cfg.tagline.slice(0, 150), size: 'sm', color: '#D4E9E2', margin: 'md', wrap: true }
      ] },
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: '你想先了解哪個部分？', size: 'md', weight: 'bold', color: '#143D35', wrap: true },
        { type: 'text', text: '我是 AI 履歷助理。可以點選下方主題，也可以直接問：「有哪些專案成果？」', size: 'sm', color: '#53635E', wrap: true },
        { type: 'text', text: '提問會交由 Google AI 處理；資料不足的問題會記錄給履歷主人補充。輸入「隱私」了解詳情。', size: 'xs', color: '#687770', wrap: true }
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons.map(function (label, i) {
        return { type: 'button', style: i === 0 ? 'primary' : 'secondary',
          color: i === 0 ? '#23735B' : '#EEF4F0', height: 'sm', action: { type: 'message', label: label, text: label } };
      }) }
    }
  };
}

function helpText_() {
  return '你可以直接提問，例如：\n• 請用 30 秒介紹這位求職者。\n• 有哪些工作經歷與具體成果？\n• 做過哪些與資料分析相關的專案？\n• 這份履歷有哪些符合產品經理職缺的條件？\n• 如何聯絡本人？\n\n每題獨立回答，追問時請寫出專案或公司名稱。回答依據公開履歷；找不到足夠資料的問題會記錄給履歷主人確認與補充。\n\n輸入「選單」回到首頁；輸入「隱私」查看資料使用方式。';
}

function privacyText_() {
  return '我是 AI 履歷助理，回答可能有誤，重要資訊請向本人確認。\n\n資料使用方式：\n• 僅使用履歷擁有者標示為公開的內容。\n• LINE 訊息由 Google Apps Script 處理，問題和檢索片段會送至 Google Gemini。\n• 資料不足的問題會寫入履歷主人的 Google 文件，包含問題文字、原因、時間與次數，供本人維護；不附上 LINE 使用者識別碼。\n• 不保存完整對話或讀取訪客個人檔案；LINE 與 Google 本身仍適用各自的資料政策。\n• 使用者識別碼用於向 LINE 請求顯示處理中動畫，不另行保存。事件識別碼以雜湊形式保存，處理狀態保留約一天以避免重複回覆。\n\n請勿傳送密碼、證件、薪資機密或其他敏感資料。';
}

function startLoading_(userId, cfg) {
  // A failed visual hint must not prevent the normal answer or consume its reply token.
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

function lineReply_(token, messages, cfg) {
  requireValue_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN');
  var result = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.lineToken },
    payload: JSON.stringify({ replyToken: token, messages: messages }), muteHttpExceptions: true
  });
  var status = result.getResponseCode();
  if (status >= 200 && status < 300) return 'replied';
  // A token can be used once only. Do not send a push after an ambiguous reply failure.
  if (status === 400) { safeLog_('LINE_REPLY_400'); return 'reply_rejected'; }
  throw new Error('LINE_HTTP_' + status);
}
