/** Run in the Apps Script editor. Public management functions enforce owner identity. */
function initializeProject() {
  requireOwner_();
  var props = PropertiesService.getScriptProperties();
  var defaults = {
    DOC_TAB_IDS: 't.0', DISPLAY_NAME: '個人履歷',
    GEMINI_MODEL: 'gemini-3.5-flash-lite', BOT_ENABLED: 'true'
  };
  Object.keys(defaults).forEach(function (key) {
    if (!props.getProperty(key)) props.setProperty(key, defaults[key]);
  });
  if (!props.getProperty('WEBHOOK_TOKEN')) {
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
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
    throw new Error('SET_PUBLIC_WEB_APP_URL');
  }
  return url;
}

function rotateWebhookToken() {
  requireOwner_();
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_TOKEN', sha256_(Utilities.getUuid() + Utilities.getUuid()));
  return showWebhookUrl();
}

function checkSetup() {
  requireOwner_();
  var cfg = config_();
  var result = {
    credentials: {
      LINE_CHANNEL_ACCESS_TOKEN: Boolean(cfg.lineToken),
      GEMINI_API_KEY: Boolean(cfg.geminiKey),
      WEBHOOK_TOKEN: /^[a-f0-9]{64}$/.test(cfg.webhookToken)
    },
    document: 'unchecked', publicChunks: 0, index: 'missing',
    model: cfg.generationModel,
    lastSync: PropertiesService.getScriptProperties().getProperty('LAST_SYNC_STATUS') || 'NOT_RUN'
  };
  try {
    var source = readPublicSource_(cfg);
    result.documentUrl = source.documentUrl;
    result.document = source.chunks.length ? 'ready' : 'NO_PUBLIC_CONTENT';
    result.publicChunks = source.chunks.length;
    var index = loadIndex_(cfg);
    result.index = index ? (index.fingerprint === source.fingerprint ? 'ready' : 'needs_sync') : 'missing';
  } catch (error) { result.document = errorCode_(error); }
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
  var answer = answerQuestion_('請介紹這位求職者的專長與代表作品。', config_());
  console.log(answer);
  return answer;
}
