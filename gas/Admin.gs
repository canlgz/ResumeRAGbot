/** Run in the Apps Script editor. Public management functions enforce owner identity. */
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

/** Owner editor utility. Copy the secret URL only to LINE Developers. */
function showWebhookUrl() {
  requireOwner_();
  var url = publicWebAppUrl_();
  var token = config_().webhookToken;
  verifyWebhookToken_(token, token);
  var webhookUrl = url + '?key=' + encodeURIComponent(token);
  console.log(webhookUrl);
  return webhookUrl;
}

function publicWebAppUrl_() {
  var url = (PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '').trim();
  // Each installation must use its own explicit public deployment URL.
  // getService().getUrl() can return /dev; never rewrite that deployment ID.
  var match = url.match(/^(https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)(?:[?#].*)?$/);
  if (!match) throw new Error('SET_PUBLIC_WEB_APP_URL');
  // Ignore a pasted old query/key; showWebhookUrl always uses the current secret.
  return match[1];
}

function rotateWebhookToken() {
  requireOwner_();
  publicWebAppUrl_();
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_TOKEN', sha256_(Utilities.getUuid() + Utilities.getUuid()));
  return showWebhookUrl();
}

/** Owner-only comparison of saved editor code and the configured public /exec URL. */
function checkDeployment() {
  requireOwner_();
  var result = deploymentVersionStatus_();
  console.log(JSON.stringify(result));
  return result;
}

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

function requireMatchingDeployment_() {
  var result = deploymentVersionStatus_();
  // Only a confirmed mismatch blocks a rebuild. A probe failure is reported as unknown.
  if (result.status === 'version_mismatch') throw new Error('DEPLOYMENT_VERSION_MISMATCH');
  return result;
}

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
  if (result.publicImages) result.nextSteps.push('公開區有 ' + result.publicImages + ' 張圖片；同步時辨識文字及畫面，完成後可執行 previewImageText 核對。');
  var answerTest = PropertiesService.getScriptProperties().getProperty('LAST_ANSWER_TEST') || 'NOT_RUN';
  result.answerTest = answerTest;
  if (result.index === 'ready') {
    if (answerTest === 'NOT_RUN') result.nextSteps.push('執行 testResumeAnswer，確認 Gemini 能根據文件回答。');
    // ANSWER_* is only stored by versions before 1.1.5; rerunning records OK or GEMINI_OK.
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

/** Owner-only preview of already indexed image text; does not call Gemini. */
function previewImageText() {
  requireOwner_();
  var cfg = config_(), source = readPublicSource_(cfg), index = loadIndex_(cfg);
  if (!index || index.fingerprint !== source.fingerprint) throw new Error('IMAGE_PREVIEW_NEEDS_SYNC');
  var images = (index.imageSources || []).map(function (entry) {
    var result = index.imageTexts[entry.imageKey];
    return { section: entry.section, tabId: entry.tabId, status: result.status, text: result.text,
      transcription: result.transcription || '', visualDescription: result.visualDescription || '' };
  });
  var result = { status: 'ready', version: appVersion_(), indexBuiltWith: index.builtWithAppVersion || 'unknown', images: images };
  console.log(JSON.stringify(result));
  return result;
}

/** Checks the bot account only; never sends a LINE message. */
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

function installHourlySync() {
  requireOwner_();
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ['syncKnowledgeBase', 'syncKnowledgeBase_'].indexOf(trigger.getHandlerFunction()) >= 0;
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('syncKnowledgeBase_').timeBased().everyHours(1).create();
  return { status: 'installed' };
}

function removeHourlySync() {
  requireOwner_();
  ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ['syncKnowledgeBase', 'syncKnowledgeBase_'].indexOf(trigger.getHandlerFunction()) >= 0;
  }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
}

/** Calls Gemini but never sends a LINE message. */
function testResumeAnswer() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  try {
    var answer = answerQuestion_('請介紹這位求職者的專長與代表作品。', config_());
  } catch (error) {
    var code = errorCode_(error);
    // ANSWER_* only follows a successful Gemini response: key, model and index all work.
    // The AI's quote check fails now and then; that must not block a student's installation.
    if (/^ANSWER_/.test(code)) {
      props.setProperty('LAST_ANSWER_TEST', 'GEMINI_OK');
      var note = '安裝設定正常：Gemini 已成功回應，但這次 AI 的回答沒通過來源檢查（' + code +
        '），所以沒有顯示回答。這是 AI 偶發的狀況，不是設定錯誤，可以直接繼續下一步；LINE 上偶爾也可能請訪客稍後再試。';
      console.log(note);
      // Owner-only editor run: show which public-resume quote failed so the cause can be reported.
      (error.details || []).forEach(function (d) {
        console.log('未對上原文的引用（片段 ' + d.id + '，相符 ' + d.coverage + '%）：' + d.quote);
      });
      return note;
    }
    props.setProperty('LAST_ANSWER_TEST', code);
    console.log('testResumeAnswer 未通過（' + code + '）：' + ragErrorMessage_(error));
    throw error;
  }
  // Only a grounded answer carries a source line; waiting/missing replies are not a pass.
  props.setProperty('LAST_ANSWER_TEST', /\n\n資料來源：/.test(answer) ? 'OK' : 'NO_ANSWER');
  console.log(answer);
  return answer;
}
