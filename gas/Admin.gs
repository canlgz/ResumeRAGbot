/**
 * 【履歷主人在 GAS 編輯器執行的管理入口】
 * 初次安裝依序：initializeProject → testLineConnection → syncKnowledgeBase → checkSetup。
 * 完成正式部署後用 checkDeployment 核對版本；用 openImageReview 開啟圖片校對頁。
 * 這些管理函式先核對登入身分，訪客不能經由網頁任意呼叫。
 */

/**
 * 【學生首次執行】建立缺少的預設設定與履歷，再顯示下一步。
 * 只補缺少的值，不會覆蓋原金鑰、文件 ID 或主人已修改的內容。
 */
function initializeProject() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  var defaults = {
    DOC_TAB_IDS: 't.0', DISPLAY_NAME: '個人履歷',
    GEMINI_MODEL: 'gemini-3.5-flash-lite', BOT_ENABLED: 'true'
  };
  Object.keys(defaults).forEach(function (key) {
    if (!String(props.getProperty(key) || '').trim()) props.setProperty(key, defaults[key]);
  });
  if (!String(props.getProperty('WEBHOOK_TOKEN') || '').trim()) {
    props.setProperty('WEBHOOK_TOKEN', sha256_(Utilities.getUuid() + Utilities.getUuid()));
  }
  ensureResumeDocument_(props);
  return checkSetup();
}

/**
 * 【部署後執行】輸出要貼到 LINE Developers 的完整秘密入口網址。
 * 含 ?key= 的網址只供本人設定頻道，不可貼到公開作業或 GitHub。
 */
function showWebhookUrl() {
  requireOwner_();
  var url = publicWebAppUrl_();
  var token = config_().webhookToken;
  verifyWebhookToken_(token, token);
  var webhookUrl = url + '?key=' + encodeURIComponent(token);
  console.log(webhookUrl);
  return webhookUrl;
}

/**
 * 讀取本人明確設定的正式 /exec 網址；不把 /dev 自行改寫成 /exec。
 */
function publicWebAppUrl_() {
  var url = (PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '').trim();
  // 每位學生都須設定自己的正式部署網址，不能沿用教師的網址。
  // 在編輯器執行時 getService().getUrl() 可能是 /dev，不能改字尾冒充正式部署。
  var match = url.match(/^(https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)(?:[?#].*)?$/);
  if (!match) throw new Error('SET_PUBLIC_WEB_APP_URL');
  // 若貼入舊的查詢參數就先去掉，完整入口一律使用目前密鑰重新組合。
  return match[1];
}

/**
 * 重新產生入口密鑰；更換後須把新完整網址重新貼到 LINE 後台。
 */
function rotateWebhookToken() {
  requireOwner_();
  publicWebAppUrl_();
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_TOKEN', sha256_(Utilities.getUuid() + Utilities.getUuid()));
  return showWebhookUrl();
}

/**
 * 【版本檢查】比較編輯器與實際正式網址，不發送 LINE 訊息。
 */
function checkDeployment() {
  requireOwner_();
  var result = deploymentVersionStatus_();
  console.log(JSON.stringify(result));
  return result;
}

/**
 * 讀取不含密鑰的正式網址，從回應辨識程式版本。
 * 連不上或讀不到版本屬於「無法確認」，不冒稱已確認版本不同。
 */
function deploymentVersionStatus_() {
  var result = { status: 'not_configured', editorVersion: appVersion_(), webAppVersion: null };
  var url;
  try { url = publicWebAppUrl_(); } catch (_) {
    result.message = '尚未設定有效的正式 /exec 網址；首次安裝可先同步，部署後再執行 checkDeployment。';
    return result;
  }
  try {
    var response = UrlFetchApp.fetch(url + '?version_check=' + Date.now(), {
      method: 'get', followRedirects: true, muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' }
    });
    result.httpStatus = response.getResponseCode();
    if (result.httpStatus !== 200) {
      result.status = 'unreachable';
      result.message = '正式網址回傳 HTTP ' + result.httpStatus + '，無法確認版本。請確認部署以「我」執行、「所有人」可存取。';
      return result;
    }
    var body = response.getContentText();
    var match = body.match(/RESUMERAGBOT_VERSION=([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/)
      || body.match(/LINE 履歷助理已部署。版本\s+([0-9]+\.[0-9]+\.[0-9]+)(?![0-9.])/);
    if (!match) {
      result.status = 'unrecognized';
      result.message = '正式網址沒有可辨識的版本資訊，尚未確認一致。請用無痕視窗開啟不含 key 的 /exec 網址，核對版本及是否要求登入。';
      return result;
    }
    result.webAppVersion = match[1];
    result.status = result.webAppVersion === result.editorVersion ? 'ready' : 'version_mismatch';
    result.message = result.status === 'ready' ? '編輯器與正式部署版本一致。' :
      '版本不一致：編輯器 ' + result.editorVersion + '、正式部署 ' + result.webAppVersion +
      '。先確認兩者要使用的版本；下載的安裝包、完整程式與 manifest 必須來自同一版。儲存並重新整理編輯器，再到「部署 → 管理部署」編輯原部署，版本選「新版本」。';
  } catch (_) {
    result.status = 'unreachable';
    result.message = '暫時無法連線到正式網址，無法確認版本；這不代表版本不同。請稍後再執行 checkDeployment，或用無痕視窗核對。';
  }
  return result;
}

/**
 * 只在已確認版本不同時阻止同步；此時原索引仍保留。
 */
function requireMatchingDeployment_() {
  var result = deploymentVersionStatus_();
  // 已確認不同才阻止重建；連不上只表示無法確認，兩者必須分開。
  if (result.status === 'version_mismatch') throw new Error('DEPLOYMENT_VERSION_MISMATCH');
  return result;
}

/**
 * 【安裝診斷】彙整文件、金鑰是否填妥、索引、主題選單與部署狀態。
 * credentials=true 不等於 API 已通過驗證，仍須做連線及問答測試。
 */
function checkSetup() {
  requireOwner_();
  var cfg = config_();
  var result = {
    version: appVersion_(),
    credentials: {
      LINE_CHANNEL_ACCESS_TOKEN: valueConfigured_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN'),
      GEMINI_API_KEY: valueConfigured_(cfg.geminiKey, 'GEMINI_API_KEY'),
      WEBHOOK_TOKEN: /^[a-f0-9]{64}$/.test(cfg.webhookToken)
    },
    document: 'unchecked', publicChunks: 0, index: 'missing',
    model: cfg.generationModel, deployment: 'not_configured', nextSteps: [],
    lastSync: PropertiesService.getScriptProperties().getProperty('LAST_SYNC_STATUS') || 'NOT_RUN'
  };
  var source = null;
  try {
    source = readPublicSource_(cfg);
    result.documentUrl = source.documentUrl;
    result.document = source.chunks.length ? 'ready' : 'NO_PUBLIC_CONTENT';
    result.publicChunks = source.chunks.length;
    result.publicImages = source.imageCount;
    result.imageModel = cfg.imageModel;
  } catch (error) {
    result.document = errorCode_(error) === 'UNEXPECTED_ERROR' ? 'DOC_UNAVAILABLE' : errorCode_(error);
  }
  if (source) {
    try {
      var index = loadIndex_(cfg);
      result.index = index ? (index.fingerprint === source.fingerprint ? 'ready' : 'needs_sync') : 'missing';
      result.indexBuiltWith = index && index.builtWithAppVersion || 'unknown';
      result.quickReplies = { status: result.index === 'ready' && index.quickTopics && index.quickTopics.version === 4 ? index.quickTopics.status : 'needs_sync',
        labels: menuTopics_(result.index === 'ready' ? index : null).map(function (topic) { return topic.label; }) };
    } catch (error) {
      result.index = errorCode_(error) === 'UNEXPECTED_ERROR' ? 'INDEX_INVALID' : errorCode_(error);
    }
  } else result.index = 'unchecked';
  result.deploymentCheck = deploymentVersionStatus_();
  if (result.deploymentCheck.status !== 'not_configured') result.deployment = 'url_configured';
  if (result.document !== 'ready') result.nextSteps.push('文件尚未就緒（' + result.document + '）：先執行 initializeProject，或檢查文件權限、分頁及公開標記。');
  ['LINE_CHANNEL_ACCESS_TOKEN', 'GEMINI_API_KEY'].forEach(function (key) {
    if (!result.credentials[key]) result.nextSteps.push('在「專案設定 → 指令碼屬性」填入自己的 ' + key + '；不要填 YOUR_ 等範例值。');
  });
  if (!result.credentials.WEBHOOK_TOKEN) result.nextSteps.push('執行 initializeProject 產生入口密鑰；若手動改過，請按安裝說明恢復有效設定。');
  if (result.document === 'ready' && result.credentials.GEMINI_API_KEY && result.index !== 'ready' &&
      result.deploymentCheck.status !== 'version_mismatch') {
    result.nextSteps.push('索引尚未就緒（' + result.index + '）：執行 syncKnowledgeBase，再執行 checkSetup。');
  }
  if (result.publicImages) result.nextSteps.push('公開區有 ' + result.publicImages + ' 張圖片；同步後可執行 previewImageText，或在完成部署後執行 openImageReview 校對及設定作品預覽。');
  if (result.index === 'ready' && result.quickReplies.status === 'needs_sync') {
    result.nextSteps.push('版本一致後執行 syncKnowledgeBase，更新為「我是誰、快速一覽」加適性特色的選單；公開內容未變時沿用原向量與圖片快取。');
  }
  var answerTest = PropertiesService.getScriptProperties().getProperty('LAST_ANSWER_TEST') || 'NOT_RUN';
  result.answerTest = answerTest;
  if (result.index === 'ready') {
    if (answerTest === 'NOT_RUN') result.nextSteps.push('執行 testResumeAnswer，確認 Gemini 能根據文件回答。');
    // ANSWER_* 是舊版留下的狀態，重新測試可更新為 OK 或 GEMINI_OK。
    else if (/^ANSWER_/.test(answerTest)) result.nextSteps.push('上次 testResumeAnswer 的結果（' + answerTest + '）來自舊版程式，不代表設定錯誤；再執行一次 testResumeAnswer 即可更新。');
    else if (answerTest === 'NO_ANSWER') result.nextSteps.push('上次 testResumeAnswer 沒有產生附來源的回答：查看當次執行記錄（例如等待同步或資料不足），處理後再執行。');
    else if (answerTest !== 'OK' && answerTest !== 'GEMINI_OK') result.nextSteps.push('上次 testResumeAnswer 未通過（' + answerTest + '）：依安裝說明「常見錯誤」處理後，再執行 testResumeAnswer。');
  }
  if (result.credentials.LINE_CHANNEL_ACCESS_TOKEN) result.nextSteps.push('執行 testLineConnection，確認 Token 有效且帳號名稱正確。');
  if (result.deployment !== 'url_configured') result.nextSteps.push('部署網頁應用程式（我／所有人），把正式 /exec 網址存入 WEB_APP_URL。');
  else if (result.deploymentCheck.status !== 'ready') result.nextSteps.push(result.deploymentCheck.message);
  else result.nextSteps.push('正式部署版本一致。執行 showWebhookUrl，把完整結果存到 LINE，開啟 Use webhook 後傳送「選單」。');
  if (!cfg.enabled) result.nextSteps.push('目前 BOT_ENABLED=false；要測試問答請改成 true。');
  console.log(JSON.stringify(result));
  if (result.documentUrl) console.log('履歷文件：' + result.documentUrl);
  result.nextSteps.forEach(function (step, i) { console.log('下一步 ' + (i + 1) + '：' + step); });
  return result;
}

/**
 * 【主題驗收】逐一實測目前每個 Quick Reply，包含從舊作品切換到新主題。
 * 使用真實 Gemini 配額，輸出答案與來源；不傳送 LINE 訊息，也不改履歷。
 */
function testQuickReplyTopics() {
  requireOwner_();
  var cfg = config_(), index = loadIndex_(cfg);
  if (!index || !index.quickTopics || index.quickTopics.status !== 'ready') throw new Error('IMAGE_PREVIEW_NEEDS_SYNC');
  var results = menuTopics_(index).map(function (topic) { return testTopicAnswer_(topic.id, cfg); });
  var result = { version: appVersion_(), status: results.every(function (entry) { return entry.status === 'answered'; }) ? 'ready' : 'needs_review', results: results };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * 【辨識預覽】讀取已同步的圖片文字／校對結果，不重新呼叫 Gemini。
 */
function previewImageText() {
  requireOwner_();
  var cfg = config_(), source = readPublicSource_(cfg), index = loadIndex_(cfg);
  if (!index || index.fingerprint !== source.fingerprint) throw new Error('IMAGE_PREVIEW_NEEDS_SYNC');
  var images = (index.imageSources || []).map(function (entry) {
    var result = (index.imageReviewedTexts || {})[entry.imageKey] || index.imageTexts[entry.imageKey];
    return { section: entry.section, tabId: entry.tabId, status: result.status, text: result.text,
      reviewed: Boolean((index.imageReviewedTexts || {})[entry.imageKey]),
      transcription: result.transcription || '', visualDescription: result.visualDescription || '' };
  });
  var result = { status: 'ready', version: appVersion_(), indexBuiltWith: index.builtWithAppVersion || 'unknown', images: images };
  console.log(JSON.stringify(result));
  return result;
}

/**
 * 【連線測試】只讀取 LINE 帳號名稱，確認 Token 屬於自己的頻道。
 */
function testLineConnection() {
  requireOwner_();
  var result;
  try {
    var cfg = config_();
    requireValue_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN');
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
      method: 'get', headers: { Authorization: 'Bearer ' + cfg.lineToken }, muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) throw new Error('LINE_HTTP_' + status);
    var bot = JSON.parse(response.getContentText());
    if (!bot || typeof bot.displayName !== 'string' || !bot.displayName.trim()) throw new Error('LINE_INVALID_RESPONSE');
    result = { status: 'ready', botName: bot.displayName, message: 'LINE Token 可使用。請確認這是自己的官方帳號；接著完成 Webhook 設定並傳送「選單」。' };
  } catch (error) {
    var code = errorCode_(error);
    result = { status: 'error', code: code, message:
      code === 'MISSING_LINE_CHANNEL_ACCESS_TOKEN' ? '請先在指令碼屬性填入自己的 LINE_CHANNEL_ACCESS_TOKEN。' :
      code === 'LINE_HTTP_401' || code === 'LINE_HTTP_403' ? 'LINE 驗證或權限失敗，請確認填的是此 Messaging API 頻道的 Channel access token，而不是 Channel secret。' :
      'LINE 連線檢查未成功，請依錯誤碼排查權限、網路或服務狀態後再試。' };
  }
  console.log(JSON.stringify(result));
  return result;
}

/**
 * 安裝每小時同步觸發器；時間由 GAS 排程，不保證精準整點。
 */
function installHourlySync() {
  requireOwner_();
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ['syncKnowledgeBase', 'syncKnowledgeBase_'].indexOf(trigger.getHandlerFunction()) >= 0;
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('syncKnowledgeBase_').timeBased().everyHours(1).create();
  return { status: 'installed' };
}

/**
 * 移除這個專案的同步排程，不會刪除履歷或索引。
 */
function removeHourlySync() {
  requireOwner_();
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ['syncKnowledgeBase', 'syncKnowledgeBase_'].indexOf(trigger.getHandlerFunction()) >= 0;
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
}

/**
 * 【問答測試】使用 Gemini 驗證檢索及回答，不傳 LINE 訊息。
 */
function testResumeAnswer() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  try {
    var answer = answerQuestion_('請介紹這位求職者的專長與代表作品。', config_());
  } catch (error) {
    var code = errorCode_(error);
    // ANSWER_* 表示 Gemini 已成功回應，金鑰、模型與索引均可運作。
    // 偶發的 AI 引用不合格不等於安裝失敗，避免學生卡在同一步反覆測試。
    if (/^ANSWER_/.test(code)) {
      props.setProperty('LAST_ANSWER_TEST', 'GEMINI_OK');
      var note = '安裝設定正常：Gemini 已成功回應，但這次 AI 的回答沒通過來源檢查（' + code +
        '），所以沒有顯示回答。這是 AI 偶發的狀況，不是設定錯誤，可以直接繼續下一步；LINE 上偶爾也可能請訪客稍後再試。';
      console.log(note);
      // 僅限主人在編輯器測試，列出未通過的公開引用以便核對。
      (error.details || []).forEach(function (d) {
        console.log('未對上原文的引用（片段 ' + d.id + '，相符 ' + d.coverage + '%）：' + d.quote);
      });
      return note;
    }
    props.setProperty('LAST_ANSWER_TEST', code);
    console.log('testResumeAnswer 未通過（' + code + '）：' + ragErrorMessage_(error));
    throw error;
  }
  // 有證據的回答才會帶來源；「等待同步」或「資料不足」不能算驗收通過。
  props.setProperty('LAST_ANSWER_TEST', /\n\n資料來源：/.test(answer) ? 'OK' : 'NO_ANSWER');
  console.log(answer);
  return answer;
}
