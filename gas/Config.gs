/** Set credentials in Project settings > Script properties, never in source. */
function config_() {
  var p = PropertiesService.getScriptProperties();
  var get = function (key, fallback) { return p.getProperty(key) || fallback || ''; };
  var num = function (key, fallback, min, max) {
    var value = Number(get(key, String(fallback)));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error('CONFIG_' + key);
    return value;
  };
  return {
    docId: get('RESUME_DOC_ID'),
    tabIds: get('DOC_TAB_IDS', 't.0').split(',').map(function (s) { return s.trim(); }),
    name: get('DISPLAY_NAME', '個人履歷'),
    tagline: get('TAGLINE', '從經歷、作品與技能，認識下一位合作夥伴。'),
    lineToken: get('LINE_CHANNEL_ACCESS_TOKEN'),
    geminiKey: get('GEMINI_API_KEY'),
    webhookToken: get('WEBHOOK_TOKEN'),
    generationModel: get('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
    embeddingModel: 'gemini-embedding-001',
    dimensions: 768,
    minSimilarity: num('MIN_SIMILARITY', 0.4, 0, 1),
    topK: 5,
    enabled: get('BOT_ENABLED', 'true') === 'true'
  };
}

function requireValue_(value, key) {
  if (!value || /^(YOUR_|REPLACE_|貼上|待填)/i.test(value)) throw new Error('MISSING_' + key);
  return value;
}

function sha256_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function safeLog_(code) {
  // Only application error codes; never log questions, credentials, reply tokens or API bodies.
  console.log(JSON.stringify({ code: String(code).replace(/[^A-Z0-9_]/g, '').slice(0, 80) }));
}

function errorCode_(error) {
  var message = String(error && error.message || 'UNKNOWN');
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(message) ? message : 'UNEXPECTED_ERROR';
}

function requireOwner_() {
  // HtmlService can expose public functions via google.script.run. Never rely on editor-only documentation.
  var active = Session.getActiveUser().getEmail();
  var effective = Session.getEffectiveUser().getEmail();
  if (!active || !effective || active !== effective) throw new Error('OWNER_ONLY');
}
