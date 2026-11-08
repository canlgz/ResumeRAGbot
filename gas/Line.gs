/**
 * 【LINE 顯示與訊息傳送】
 * 本檔只負責將資料組成文字、貼圖與 Flex 首頁，以及呼叫 LINE API。
 * Quick Reply 使用同步後的同一份代表主題；操作指令不混入代表關鍵字。
 */

/**
 * 固定兩個基本入口，加上本次有效的適性主題；不在聊天時重新分類。
 */
/** 每則訊息底下的快速回覆固定與導覽卡一致，不靠 AI 產生，每次都一樣。 */
var QUICK_REPLY_ITEMS_ = [
  ['名片', 'nav:home'], ['個人特質', '個人特質'], ['專業技能', '專業技能'], ['工作經歷', '工作經歷'],
  ['專案', '專案作品'], ['其他', '其他'], ['貼職缺比對', 'jobmatch:start']
];
function quickReply_() {
  return { items: QUICK_REPLY_ITEMS_.map(function (item) {
    return { type: 'action', action: { type: 'postback', label: item[0], data: item[1], displayText: item[0] } };
  }) };
}

var LINE_STICKERS_ = {
  celebrate: { packageId: '11537', stickerId: '52002734' }, // 熊大慶祝（適合專案成果、代表作品、亮點成就）
  greet:     { packageId: '11537', stickerId: '52002738' }, // 兔兔與莎莉探頭招呼：開始認識
  thanks:    { packageId: '11537', stickerId: '52002739' }, // 熊大感謝（適合聯絡方式、作品連結、期待合作）
  confident: { packageId: '11537', stickerId: '52002735' }, // 兔兔比讚：有履歷依據的能力肯定，不承諾錄取或勝任
  interested:{ packageId: '11537', stickerId: '52002752' }, // 兔兔期待：回應明確表達的關注，不推定已決定合作
  attentive: { packageId: '11537', stickerId: '52002768' }, // 兔兔探頭聆聽：願意釐清，不用問號嘲弄訪客
  received:  { packageId: '11537', stickerId: '52002740' }, // 兔兔 OK：只表示已保存邀約，不代表面試已排定
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
 * 貼圖表達交流目的，不猜測訪客內心。優先採取可觀察的文字訊號，再使用回答模型的意圖。
 * 技術細節、資料不足、服務錯誤或未提供關鍵條件時，留白比不相稱的表情更清楚。
 */
function dialogueStickerIntent_(text, conversation) {
  if (conversation && conversation.answerStatus === 'clarification') return 'clarification';
  if (!conversation || conversation.answerStatus !== 'answered') return 'neutral';
  var request = conversation.request || {}, answer = conversation.messages[0] && conversation.messages[0].text || '';
  if (/不太懂|看不懂|不懂|不明白|不確定|擔心|疑慮|真的嗎|確定嗎|怎麼證明|說明一下/.test(text)) return 'clarification';
  if (request.answerMode === 'intro') return 'introduction';
  if (/配色|構圖|色碼|哪個欄位|什麼欄位|用什麼技術|哪個套件|哪個函式|怎麼計算|如何計算|程式碼/.test(text)) return 'neutral';
  if (/尚未提供|未提供|無法確認|未記載|不符合|不具備|沒有相關經驗/.test(answer)) return 'neutral';
  if (/勝任|適合|符合|匹配|能力|擅長/.test(text)) return 'capability';
  if (/成果|成效|改善|節省|省了|縮短|提升/.test(text) && /\d|提升|縮短|節省|改善/.test(answer)) return 'achievement';
  return ['introduction', 'capability', 'achievement', 'interest', 'appreciation', 'clarification'].indexOf(conversation.dialogueIntent) >= 0 ? conversation.dialogueIntent : 'neutral';
}

/** 明確的簡短社交訊息不必向量搜尋，也不記成履歷缺漏；邀約草稿仍由 Contact 先處理。 */
function socialDialogue_(text, cfg, prepared) {
  if (/^(?:你好|您好|嗨|哈囉|哈啰|hello|hi)[！!。～~\s]*$/i.test(text)) return {
    intent: 'introduction', messages: [textMessage_('你好！可以從「我是誰」或「快速一覽」開始，也能直接問你感興趣的經歷與作品。')] };
  if (/^(?:謝謝(?:你|您|啦)?|多謝|感謝(?:你|您)?|了解了[，,]?謝謝|明白了[，,]?謝謝|thank you|thanks)[！!。～~\s]*$/i.test(text)) return {
    intent: 'appreciation', messages: [textMessage_('謝謝你的交流！有想深入了解的部分，隨時可以繼續問。')] };
  if (/^(?:(?:我|我們)?(?:覺得|看起來)?(?:不錯|很有意思|挺有意思)|(?:我|我們)?(?:很|蠻|滿|非常)?有興趣|(?:我|我們)?想進一步了解)[！!。～~\s]*$/.test(text)) return {
    intent: 'interest', messages: [textMessage_('謝謝你的關注！可以繼續看看經歷與作品；想進一步聊聊時，也可以使用「聯繫本人」。'), contactMessage_(cfg, prepared)] };
  return null;
}

function stickerHistoryKey_(userId) { return 'dialogue-sticker:' + sha256_(ScriptApp.getScriptId() + ':' + userId); }

/** 同一訪客 10 分鐘內不重複相同意圖；每次最多一張，不擠掉卡片或超過 LINE 五則上限。 */
function contextualSticker_(messages, intent, userId) {
  var moods = { introduction: 'greet', capability: 'confident', achievement: 'celebrate', interest: 'interested',
    appreciation: 'thanks', clarification: 'attentive', contact: 'thanks', invitation_received: 'received' };
  var mood = moods[intent];
  if (!mood || messages.length >= 5 || messages.some(function (message) { return message.type === 'sticker'; })) return null;
  try {
    var history = JSON.parse(CacheService.getScriptCache().get(stickerHistoryKey_(userId)) || 'null');
    if (history && history[intent] > Date.now() - 600000) return null;
  } catch (_) { return null; }
  return stickerMessage_(mood);
}

/** 只有 LINE 回覆成功才記錄貼圖使用時間，傳送失敗可安全重試，不保存訊息正文或 userId。 */
function rememberDialogueSticker_(intent, userId) {
  try {
    var cache = CacheService.getScriptCache(), key = stickerHistoryKey_(userId), history = JSON.parse(cache.get(key) || '{}');
    Object.keys(history).forEach(function (name) { if (history[name] <= Date.now() - 600000) delete history[name]; });
    history[intent] = Date.now(); cache.put(key, JSON.stringify(history), 600);
  } catch (_) { safeLog_('DIALOGUE_STICKER_CACHE_UNAVAILABLE'); }
}

/**
 * 建立 LINE 文字訊息，並附上相同的代表主題 Quick Reply。
 */
function textMessage_(text) {
  return { type: 'text', text: Array.from(String(text)).slice(0, 4500).join(''), quickReply: quickReply_() };
}

/**
 * 無肖像時以 LINE 原生幾何元件畫出親和人物，不使用姓名首字或生成真人照片。
 * 圖形只存在於訊息中：不用讀外部圖片、不呼叫 AI，更不寫入 Google Doc。
 */
function friendlyAvatar_() {
  function shape(width, height, left, top, color, radius, contents) {
    return { type: 'box', layout: 'vertical', position: 'absolute', width: width + 'px', height: height + 'px',
      offsetStart: left + 'px', offsetTop: top + 'px', backgroundColor: color, cornerRadius: radius + 'px', contents: contents || [] };
  }
  return { type: 'box', layout: 'vertical', width: '80px', height: '80px', cornerRadius: '40px', backgroundColor: '#E6EFE6', contents: [
    shape(56, 34, 12, 48, '#377E6B', 28),
    shape(12, 16, 34, 38, '#E6B989', 6),
    shape(34, 36, 23, 13, '#F1CCA2', 17, [
      shape(34, 12, 0, 0, '#3D5149', 8),
      shape(3, 3, 9, 17, '#3D5149', 2), shape(3, 3, 22, 17, '#3D5149', 2),
      shape(12, 9, 11, 22, '#8D5944', 6), shape(14, 6, 10, 20, '#F1CCA2', 3)
    ])
  ] };
}

/** 名片與導覽卡共用的色票；LINE 卡片顏色只能寫死，不跟隨深淺色模式。 */
var CARD_COLORS_ = { ink: '#1B2233', sub: '#5B6475', rule: '#E6E9EF', accent: '#2F4F8F', soft: '#EAF0FA', chip: '#F3F5F9', chevron: '#B8C0D0' };

/**
 * 讀取目前公開履歷的名片資料。新舊索引不符時回空物件，不把已從文件刪掉的個資繼續顯示。
 */
function homeProfile_(cfg, prepared) {
  var profile = {}, portrait = null;
  if (prepared && prepared.index && prepared.source && prepared.index.fingerprint === prepared.source.fingerprint) {
    profile = validateHomeProfile_(prepared.index.quickTopics && prepared.index.quickTopics.homeProfile, prepared.index.chunks);
    try { portrait = portfolioEntries_(prepared.index, prepared.source, cfg, null, 'portrait')[0]; } catch (_) {}
  }
  return { profile: profile, portrait: portrait, name: profile.name || cfg.name };
}

function cardText_(value, size, color, bold, extra) {
  var text = { type: 'text', text: value, size: size, color: color, weight: bold ? 'bold' : 'regular', wrap: true };
  Object.keys(extra || {}).forEach(function (key) { text[key] = extra[key]; });
  return text;
}

function linkButton_(label, data) {
  return { type: 'button', height: 'sm', style: 'link', color: CARD_COLORS_.accent, action: { type: 'postback', label: label, data: data, displayText: label } };
}

/**
 * 【首頁＝一張名片】人資加入好友或輸入「首頁」時先看到：照片、姓名、職務、學校、三個標籤、公開聯繫方式，
 * 以及「想了解這個人」入口。所有文字都來自同步時逐字摘錄的 homeProfile，履歷沒寫的欄位整列不顯示。
 */
function welcomeMessage_(cfg, prepared) {
  var home = homeProfile_(cfg, prepared), profile = home.profile, c = CARD_COLORS_;
  var name = Array.from(home.name).slice(0, 24).join(''), role = profile.role || '歡迎認識我的經歷與作品';
  var who = [cardText_(name, 'lg', c.ink, true), cardText_(role, 'xs', c.sub, false)];
  if (profile.school) who.push(cardText_(profile.school, 'xxs', c.sub, false));
  var identity = { type: 'box', layout: 'horizontal', spacing: 'lg', alignItems: 'center', contents: [
    home.portrait ? { type: 'box', layout: 'vertical', width: '68px', height: '68px', cornerRadius: '34px', flex: 0, contents: [
      { type: 'image', url: home.portrait.imageUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'cover' }
    ] } : friendlyAvatar_(),
    { type: 'box', layout: 'vertical', spacing: 'xs', contents: who }
  ] };
  var body = [identity];
  // 三個標籤各佔三分之一寬，值太長會在標籤內換行，不會撐破卡片。
  var tags = profile.tags || {}, chips = [['個性', tags.personality], ['地區', tags.region], ['專長', tags.specialty]]
    .filter(function (pair) { return pair[1]; }).map(function (pair) {
      return { type: 'box', layout: 'vertical', flex: 1, paddingAll: '8px', cornerRadius: '10px', backgroundColor: c.chip, contents: [
        cardText_(pair[0], 'xxs', c.accent, false), cardText_(pair[1], 'xs', c.ink, true)
      ] };
    });
  if (chips.length) body.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: chips });
  var facts = [];
  // 聯繫資料逐字顯示，避免把範例地址變成貌似可用的寄信按鈕；只去掉「Email：」這類前綴與句尾標點，標籤改用偵測到的類型。
  (profile.contacts || []).forEach(function (contact) {
    var match = String(contact).match(/^(?:示範\s*)?(E-?mail|信箱|電子郵件|電話|手機|網站|作品集|GitHub|LinkedIn|個人網站)\s*[：:]\s*(.+)$/i);
    var label = match ? match[1].replace(/^e-?mail$/i, 'Email').replace(/^(信箱|電子郵件)$/, 'Email').replace(/^(手機)$/, '電話').replace(/^(作品集|個人網站)$/, '網站') : '聯繫';
    var value = (match ? match[2] : String(contact)).replace(/[。；;，,\s]+$/, '');
    if (value) facts.push([label, value]);
  });
  if (profile.years) facts.push(['年資', profile.years]);
  if (facts.length) {
    body.push({ type: 'separator', color: c.rule });
    body.push({ type: 'box', layout: 'vertical', spacing: 'xs', contents: facts.map(function (pair) {
      return { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        cardText_(pair[0], 'xxs', c.accent, false, { flex: 0 }), cardText_(pair[1], 'xxs', c.sub, false)
      ] };
    }) });
  }
  // 主要入口用色塊而非 button 元件：LINE 電腦版對自訂顏色的 primary 按鈕有時不顯示文字。
  var explore = { type: 'box', layout: 'vertical', paddingAll: '12px', cornerRadius: '10px', backgroundColor: c.accent, justifyContent: 'center',
    action: { type: 'postback', label: '想了解這個人', data: 'nav:explore', displayText: '想了解這個人' },
    contents: [cardText_('想了解這個人', 'sm', '#FFFFFF', true, { align: 'center' })] };
  return { type: 'flex', altText: name + '｜履歷名片', quickReply: quickReply_(), contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'horizontal', paddingAll: '12px', paddingStart: '16px', backgroundColor: c.accent, contents: [
      cardText_('RESUME CARD', 'xxs', '#FFFFFF', false), cardText_('LINE 履歷', 'xxs', '#B9C8E6', false, { align: 'end' })
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'lg', backgroundColor: '#FFFFFF', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', spacing: 'xs', backgroundColor: '#FFFFFF', contents: [
      explore, { type: 'box', layout: 'horizontal', contents: [linkButton_('聯繫本人', 'nav:contact'), linkButton_('使用說明', '使用說明')] }
    ] } } };
}

/**
 * 【導覽卡】按下「想了解這個人」後的五個入口：個人特質、專業技能、工作經歷、專案、其他。
 * 每項下方一行提示取自 homeProfile 與同步產生的主題，履歷沒有的就不顯示提示；點下去走原本的履歷問答。
 */
function exploreMenu_(cfg, prepared) {
  var home = homeProfile_(cfg, prepared), profile = home.profile, c = CARD_COLORS_;
  var adaptive = prepared && prepared.index && prepared.index.quickTopics && prepared.index.quickTopics.status === 'ready' ? prepared.index.quickTopics.topics || [] : [];
  var projects = adaptive.filter(function (topic) { return topic.category === '專案' || topic.category === '作品'; }).map(function (topic) { return topic.title || topic.label; });
  var items = [
    { icon: 'traits', label: '個人特質', data: '個人特質', hint: (profile.traits || [])[0] || '' },
    { icon: 'skills', label: '專業技能', data: '專業技能', hint: (profile.skills || []).join('、') },
    { icon: 'experience', label: '工作經歷', data: '工作經歷', hint: profile.years ? profile.years + '的經驗' : '' },
    { icon: 'projects', label: '專案', data: '專案作品', hint: projects.join('、') },
    { icon: 'more', label: '其他', data: '其他', hint: '學歷、語言、證照，或直接提問' }
  ];
  var rows = [];
  items.forEach(function (item, i) {
    if (i) rows.push({ type: 'separator', color: c.rule });
    var text = [cardText_(item.label, 'sm', c.ink, true)];
    if (item.hint) text.push(cardText_(Array.from(item.hint).slice(0, 40).join(''), 'xxs', c.sub, false, { maxLines: 1 }));
    rows.push({ type: 'box', layout: 'horizontal', spacing: 'md', paddingTop: '10px', paddingBottom: '10px', alignItems: 'center',
      action: { type: 'postback', label: item.label, data: item.data, displayText: item.label }, contents: [
        { type: 'box', layout: 'vertical', width: '36px', height: '36px', cornerRadius: '10px', backgroundColor: c.soft, flex: 0, justifyContent: 'center', alignItems: 'center', contents: [
          { type: 'image', url: cfg.iconBaseUrl + item.icon + '.png', size: '20px', aspectRatio: '1:1' }
        ] },
        { type: 'box', layout: 'vertical', spacing: 'none', contents: text },
        cardText_('›', 'md', c.chevron, false, { flex: 0 })
      ] });
  });
  return { type: 'flex', altText: '想先了解' + home.name + '的哪一面？', quickReply: quickReply_(), contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingBottom: '6px', backgroundColor: '#FFFFFF', contents: [
      cardText_('EXPLORE', 'xxs', c.accent, false), cardText_('想先了解' + Array.from(home.name).slice(0, 20).join('') + '的哪一面？', 'md', c.ink, true)
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '0px', backgroundColor: '#FFFFFF', contents: rows },
    footer: { type: 'box', layout: 'horizontal', paddingAll: '8px', backgroundColor: '#FFFFFF', contents: [
      linkButton_('回名片', 'nav:home'), linkButton_('貼職缺比對', 'jobmatch:start')
    ] } } };
}

/**
 * 訪客輸入「使用說明」時顯示的操作方法。
 */
function helpText_() {
  return '怎麼用這個履歷助理\n\n' +
    '• 名片：輸入「名片」或「首頁」，看姓名、職務、學校、標籤與聯繫方式。\n' +
    '• 想了解這個人：五個入口（個人特質、專業技能、工作經歷、專案、其他），點了就會依履歷回答。\n' +
    '• 貼職缺比對：把職缺貼上來，直接列出有履歷依據、待確認、不符的條件，可再產生面談問題。\n' +
    '• 聯繫本人／留下邀約：取得 Email，或在 LINE 填三個問題送出邀約，本人會收到通知。\n\n' +
    '也可以直接打字提問，例如「做過哪些資料分析專案？」「這份履歷符合產品經理職缺嗎？」。\n\n' +
    '回答只依據公開履歷，履歷沒寫的會明說；短時間內可針對同一件作品追問，輸入「清除對話」可重來。輸入「隱私」查看資料使用方式。';
}

/**
 * 向訪客說明提問、短期記憶與待補充問題的資料使用方式。
 */
function privacyText_() {
  return '我是 AI 履歷助理，回答可能有誤，重要資訊請向本人確認。\n\n資料使用方式：\n• 邀約填寫內容不交給 AI。未確認草稿暫存約 30 分鐘，可能提早失效；確認後存於履歷主人的私有邀約收件匣，並以 Email 與已設定的 LINE 通知本人；由本人查看、處理或刪除，不作為 RAG 知識。\n• 僅使用履歷擁有者標示為公開的內容。\n• LINE 訊息由 Google Apps Script 處理，問題和檢索片段會送至 Google Gemini。\n• 資料不足的問題會寫入履歷主人的 Google 文件，包含問題文字、原因、時間與次數，供本人維護；不附上 LINE 使用者識別碼。\n• 使用雜湊識別的短期記憶，暫存近期問題及作品指向約 10 分鐘，不保存完整回答；另以雜湊快取短暫保存貼圖意圖與使用時間，避免重複；不儲存對情緒或人格的判斷。輸入「清除對話」可立即清除。LINE 與 Google 本身仍適用各自的資料政策。\n• 使用者識別碼用於處理中動畫及產生短期記憶的雜湊鍵，不保存訪客原始識別碼；主人若設定 LINE 通知，會另存本人的 userId 作為推播收件人。事件識別碼以雜湊形式保存，處理狀態保留約一天以避免重複回覆。\n\n請勿傳送密碼、證件、薪資機密或其他敏感資料。';
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
  // fallbackText 是程式自己的欄位，送給 LINE 前要拿掉。
  function send(list) {
    return UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.lineToken },
      payload: JSON.stringify({ replyToken: token, messages: list.map(function (m) { var copy = {}; Object.keys(m).forEach(function (k) { if (k !== 'fallbackText') copy[k] = m[k]; }); return copy; }) }), muteHttpExceptions: true
    }).getResponseCode();
  }
  var status = send(messages);
  if (status >= 200 && status < 300) return 'replied';
  // 卡片格式被退（400）時 replyToken 尚未用掉：改送純文字版，訪客至少看得到結果，不會只剩已讀。
  if (status === 400 && messages.some(function (m) { return m.type === 'flex'; })) {
    safeLog_('LINE_REPLY_400_FLEX_FALLBACK');
    var plain = messages.filter(function (m) { return m.type !== 'sticker'; }).map(function (m) {
      return m.type === 'flex' ? textMessage_(Array.from(String(m.fallbackText || m.altText || '卡片顯示失敗，請稍後再試。')).slice(0, 4500).join('')) : m;
    });
    status = send(plain);
    if (status >= 200 && status < 300) return 'replied';
  }
  // replyToken 只能使用一次；結果不明時不改用 Push，避免重複或額外計費。
  if (status === 400) { safeLog_('LINE_REPLY_400'); return 'reply_rejected'; }
  throw new Error('LINE_HTTP_' + status);
}
