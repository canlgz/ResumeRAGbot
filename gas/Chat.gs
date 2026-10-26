/**
 * 【把檢索、作品選擇、短期記憶與 LINE 回覆串起來】
 * prepared 沿用入口已讀取的索引與來源，避免同一題重複準備資料。
 * 真正送出訊息與保存記憶由 Webhook.gs 處理，本檔只組合回覆結果。
 */

/**
 * 回傳要送出的訊息與待保存記憶；此處不直接傳訊息。
 * 依目前主題或作品限定檢索來源，選擇不明時先提供作品選擇卡。
 */
function answerLineConversation_(question, cfg, originalQuestion, userId, explicitKey, gallery, topicId, prepared) {
  var index = prepared ? prepared.index : loadIndex_(cfg);
  if (!index) return { messages: [textMessage_('履歷資料正在準備中，請稍後再來，或直接與本人聯繫。')] };
  var source = prepared ? prepared.source : readPublicSource_(cfg);
  try { reconcilePortfolioAssets_(source, cfg); } catch (error) { safeLog_(errorCode_(error)); }
  if (source.fingerprint !== index.fingerprint) {
    MESSAGE_TOPICS_ = [];
    clearConversation_(userId);
    return { messages: [textMessage_('履歷資料正在等待同步。請稍後再試，或直接與本人聯繫。')] };
  }
  setMessageTopics_(index, source);
  var memory = readConversation_(userId, index.fingerprint);
  var request = conversationRequest_(question, memory, index, explicitKey);
  var topic = topicId && ((index.quickTopics || {}).topics || []).find(function (entry) { return entry.id === topicId; });
  if (topicId && !topic) return { messages: [textMessage_('履歷主題已更新，請輸入「選單」使用最新主題。')] };
  if (!topic && !explicitKey && request.previousQuestion && memory && memory.topicId) {
    topic = ((index.quickTopics || {}).topics || []).find(function (entry) { return entry.id === memory.topicId; });
  }
  if (topic) {
    request.topicId = topic.id; request.topicScope = topic.scope; request.selectedTitle = topic.label;
    request.retrievalQuestion = '主題：' + topic.label + '\n範圍：' + topic.scope + '\n問題：' + question;
    originalQuestion = topic.label;
  }
  if (explicitKey && request.focus !== explicitKey) return { messages: [textMessage_('這件作品目前無法選取，請重新開啟作品圖庫。')] };
  if (gallery) {
    var entries = portfolioEntries_(index, source, cfg);
    if (readPublicSource_(cfg).fingerprint !== index.fingerprint) {
      MESSAGE_TOPICS_ = [];
      return { messages: [textMessage_('履歷資料正在等待同步，請稍後再試。')] };
    }
    var card = portfolioMessage_(entries);
    return { messages: card ? [textMessage_('以下是可查看的作品，點「問這件作品」即可接續詢問。'), card] :
      [textMessage_('目前尚未提供作品圖片預覽，你仍可直接詢問專案內容。')],
      fingerprint: index.fingerprint, request: request, works: entries.map(function (entry) { return entry.imageKey; }) };
  }
  if (request.ambiguous) {
    var keys = memory && memory.works.length ? memory.works : (index.imageSources || []).map(function (entry) { return entry.imageKey; });
    var candidates = (index.imageSources || []).filter(function (entry) { return keys.indexOf(entry.imageKey) >= 0; });
    candidates.sort(function (a, b) { return keys.indexOf(a.imageKey) - keys.indexOf(b.imageKey); });
    var message = textMessage_('你指的是哪一件作品？請點選下方作品，或寫出作品名稱。');
    var choices = { type: 'flex', altText: '請選擇要追問的作品', quickReply: quickReply_(), contents: {
      type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '選擇作品', weight: 'bold' }] },
      footer: { type: 'box', layout: 'vertical', contents: candidates.slice(0, 5).map(function (entry) {
        return { type: 'button', action: { type: 'postback', label: Array.from(portfolioTitle_(entry.section)).slice(0, 20).join(''),
          data: 'work:' + entry.imageKey, displayText: '詢問「' + portfolioTitle_(entry.section) + '」' } };
      }) } } };
    return { messages: [message, choices] };
  }
  var result = answerResult_(question, cfg, originalQuestion, request, { index: index, source: source });
  if (result.status !== 'answered') {
    var missingMessages = [textMessage_(result.message)], confused = result.status === 'missing' ? stickerMessage_('confused') : null;
    if (confused) missingMessages.push(confused);
    return { messages: missingMessages, fingerprint: result.status === 'missing' ? index.fingerprint : null,
      request: request, works: request.focus ? [request.focus] : [] };
  }
  var messages = [textMessage_(result.answerText), textMessage_(result.source)];
  var sticker = stickerMessage_(result.sticker);
  if (sticker) messages.push(sticker);
  var cards = [];
  try {
    cards = portfolioEntries_(index, result.sourceData, cfg, result.imageKeys);
    var portfolio = portfolioMessage_(cards);
    if (portfolio) messages.push(portfolio);
  } catch (error) { safeLog_(errorCode_(error)); }
  return { messages: messages.slice(0, 5), fingerprint: index.fingerprint, request: request,
    works: cards.length ? cards.map(function (entry) { return entry.imageKey; }) : result.imageKeys };
}
