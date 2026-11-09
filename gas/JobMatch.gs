/**
 * 【V3 候選：零打字職缺對照】
 * 人資貼文字或截圖 → 確認條件 → 逐項找履歷證據 → 燈號熱圖與面談問題。
 * 職缺內容只放在每位訪客各自的快取草稿（30 分鐘），不寫 Doc、不進索引、不寫待補充問題。
 */

var JOB_MATCH_LIMITS_ = { textChars: 6000, images: 3, criteria: 8, hitsPerCriterion: 4, ttlMs: 1800000 };

/** 以專案、文件與訪客 userId 的雜湊隔離草稿。 */
function jobMatchKey_(userId, cfg) { return 'jobmatch:' + sha256_(ScriptApp.getScriptId() + ':' + cfg.docId + ':' + userId); }

/** 過期或損壞的草稿直接清除，不沿用。 */
function readJobMatchDraft_(key) {
  var value;
  try { value = JSON.parse(CacheService.getScriptCache().get(key) || 'null'); } catch (_) {}
  if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
    CacheService.getScriptCache().remove(key); return null;
  }
  return value;
}

function saveJobMatchDraft_(key, draft) {
  CacheService.getScriptCache().put(key, JSON.stringify(draft), Math.ceil(JOB_MATCH_LIMITS_.ttlMs / 1000));
}

/** 結束職缺對照：草稿與「待填旗標」一起移除。 */
function clearJobMatch_(userId, cfg) {
  var key = jobMatchKey_(userId, cfg);
  CacheService.getScriptCache().remove(key);
  PropertiesService.getScriptProperties().deleteProperty('pending_' + key);
}

/** 訪客目前是否在貼職缺（輸入或補充條件階段），供其他流程讓出文字。 */
function jobMatchCollecting_(userId, cfg) {
  var draft = readJobMatchDraft_(jobMatchKey_(userId, cfg));
  return Boolean(draft && (draft.stage === 'input' || draft.stage === 'adding'));
}

function jobMatchIntent_(text) { return /^(?:jm:start|職缺對照|比對職缺)$/.test(text); }

function newJobMatchDraft_() {
  return { id: sha256_(Utilities.getUuid()).slice(0, 16), stage: 'input', texts: [], imageCount: 0, title: '',
    criteria: [], excluded: [], results: [], fingerprint: null, failedStage: null,
    expiresAt: Date.now() + JOB_MATCH_LIMITS_.ttlMs, lastEvent: null, lastMessages: null };
}

function jobTextLength_(draft) {
  return draft.texts.reduce(function (sum, t) { return sum + Array.from(t).length; }, 0);
}

/** 累加一段職缺文字；超過總長就拒收，不默默截斷。 */
function appendJobText_(draft, text) {
  var value = String(text).replace(/\r\n?/g, '\n').replace(/[ \t　]+/g, ' ').trim();
  if (!value) return { ok: false, reason: 'EMPTY' };
  if (jobTextLength_(draft) + Array.from(value).length > JOB_MATCH_LIMITS_.textChars) return { ok: false, reason: 'TOO_LONG' };
  draft.texts.push(value);
  return { ok: true };
}

var JOB_MATCH_NAVIGATION_ = /^(?:首頁|選單|回首頁|履歷首頁|home|menu|開始|nav:home|nav:contact|清除對話|重新開始|reset|invite:start|留下邀約)$/i;

/**
 * 職缺對照入口：回傳要回覆的訊息；與本流程無關時回傳 null，交給一般流程。
 */
function handleJobMatch_(event, text, cfg, prepared) {
  var userId = event.source.userId, key = jobMatchKey_(userId, cfg), props = PropertiesService.getScriptProperties();
  var pendingKey = 'pending_' + key;
  if (event.type === 'follow' || JOB_MATCH_NAVIGATION_.test(text) || /^(?:topic|work):/.test(text)) {
    clearJobMatch_(userId, cfg); return null;
  }
  var isImage = event.type === 'message' && event.message && event.message.type === 'image';
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var draft = readJobMatchDraft_(key), eventId = eventKey_(event);
    if (draft && draft.lastEvent === eventId && draft.lastMessages) return draft.lastMessages;
    function remember(messages) {
      if (draft) { draft.lastEvent = eventId; draft.lastMessages = messages; saveJobMatchDraft_(key, draft); }
      return messages;
    }
    if (jobMatchIntent_(text) || text === 'jm:restart') {
      draft = newJobMatchDraft_(); props.setProperty(pendingKey, draft.id);
      return remember(jobInputPrompt_(draft, 'start'));
    }
    if (text === 'jm:cancel' || (draft && /^(?:取消|取消對照)$/.test(text))) {
      clearJobMatch_(userId, cfg); draft = null;
      return [textMessage_('已取消職缺對照，剛才的職缺內容已清除。')];
    }
    if (!draft) {
      // 快取提早清除：攔住這一則，不讓職缺內容誤進一般問答或待補充問題。
      if (props.getProperty(pendingKey) && (event.type === 'message' || /^jm:/.test(text))) {
        props.deleteProperty(pendingKey);
        return [textMessage_('職缺草稿已過期，剛才的內容沒有交給 AI。請重新選擇「職缺對照」。')];
      }
      if (/^jm:/.test(text)) return [textMessage_('這張卡片已失效，請重新選擇「職缺對照」。')];
      return null;
    }
    var handled = jobMatchStep_(draft, event, text, isImage, cfg, prepared);
    if (handled === null) return null;
    if (handled.clear) { clearJobMatch_(userId, cfg); draft = null; }
    return remember(handled.messages);
  } finally { lock.releaseLock(); }
}

/** 依草稿階段處理一則訊息；回傳 { messages, clear } 或 null。 */
function jobMatchStep_(draft, event, text, isImage, cfg, prepared) {
  var id = draft.id, match = /^jm:[a-z]+:([a-f0-9]{16})/.exec(text);
  if (match && match[1] !== id) return { messages: [textMessage_('這張卡片已失效，請使用最新的卡片。')] };
  if (draft.stage === 'input') {
    if (isImage) return { messages: jobImageStep_(draft, event, cfg) };
    if (event.type === 'message' && text && !/^jm:/.test(text)) {
      var added = appendJobText_(draft, text);
      if (!added.ok && added.reason === 'TOO_LONG') return { messages: [textMessage_('職缺內容合計最多 ' + JOB_MATCH_LIMITS_.textChars +
        ' 字，這一則沒有加入。請刪減後再傳，或按「完成輸入」用目前的內容。')].map(withInputReply_(draft)) };
      return { messages: jobInputPrompt_(draft, 'received') };
    }
  }
  return jobMatchAction_(draft, event, text, cfg, prepared);
}

/** 其他階段的按鈕與文字；後續功能在此擴充。 */
function jobMatchAction_(draft, event, text, cfg, prepared) {
  if (/^jm:/.test(text)) return { messages: [textMessage_('這張卡片已失效，請使用最新的卡片。')] };
  return { messages: jobInputPrompt_(draft, 'remind') };
}

/** 截圖輸入（Task 5 實作）；在此之前先請人資改貼文字。 */
function jobImageStep_(draft, event, cfg) {
  return [textMessage_('目前請先貼上職缺文字。')].map(withInputReply_(draft));
}
