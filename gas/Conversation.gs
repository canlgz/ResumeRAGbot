/**
 * 【短期對話記憶：只記住問題指向，不把 AI 回答當成事實】
 * 每位訪客使用各自的雜湊快取鍵，約 10 分鐘有效，GAS 可能提早清除。
 * 保存上一題、作品順序及目前主題；不保存原始 userId 或完整回答。
 */

/**
 * 以專案 ID 與訪客 userId 的雜湊產生隔離的快取鍵。
 */
function conversationKey_(userId) { return 'conversation:' + sha256_(ScriptApp.getScriptId() + ':' + userId); }

/**
 * 訪客輸入「清除對話」或「重新開始」時立即清除。
 */
function clearConversation_(userId) { CacheService.getScriptCache().remove(conversationKey_(userId)); }

/**
 * 過期、資料損壞或來源已更新時，捨棄舊指向，不硬套前一題。
 */
function readConversation_(userId, fingerprint) {
  var value;
  try { value = JSON.parse(CacheService.getScriptCache().get(conversationKey_(userId)) || 'null'); } catch (_) {}
  if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || value.fingerprint !== fingerprint ||
      !Array.isArray(value.works) || typeof value.lastQuestion !== 'string') {
    try { clearConversation_(userId); } catch (_) { safeLog_('CONVERSATION_CACHE_UNAVAILABLE'); }
    return null;
  }
  return value;
}

/**
 * 解析「這張」「第二件」等追問；無法唯一決定作品時回傳 ambiguous。
 */
function conversationRequest_(question, memory, index, explicitKey) {
  var available = (index.imageSources || []).map(function (entry) { return entry.imageKey; });
  var focus = explicitKey && available.indexOf(explicitKey) >= 0 ? explicitKey : null;
  var ordinal = String(question).match(/第([一二三四五1-5])(?:個|件|張|項)/);
  if (!focus && ordinal && memory) {
    var position = '一二三四五'.indexOf(ordinal[1]);
    if (position < 0) position = Number(ordinal[1]) - 1;
    focus = memory.works[position] || null;
  }
  var followup = /這[個件張項]|那[個件張項]|它|剛才|上一[個件張]|配色呢|構圖呢|還有呢|誰負責|用什麼技術/.test(question);
  if (!focus && followup && memory) focus = memory.focus || (memory.works.length === 1 ? memory.works[0] : null);
  if (focus && available.indexOf(focus) < 0) focus = null;
  var imageReference = /這[張件]|那[張件]|第[一二三四五1-5][件張]/.test(question);
  var ambiguous = !focus && Boolean(((ordinal || followup) && memory && memory.works.length > 1) ||
    (imageReference && available.length && (!memory || !memory.works.length)));
  var section = focus ? portfolioTitle_(index.imageSources.find(function (entry) { return entry.imageKey === focus; }).section) : '';
  var previous = !explicitKey && followup && memory ? memory.lastQuestion : '';
  return { question: question, focus: focus, ambiguous: ambiguous,
    retrievalQuestion: section ? '作品：' + section + '\n問題：' + question : previous ? '上一題：' + previous + '\n追問：' + question : question,
    previousQuestion: previous, selectedTitle: section };
}

/**
 * 只有 LINE 確認回覆成功才由入口呼叫；較慢的舊題不能覆蓋新題。
 */
function saveConversation_(userId, fingerprint, request, keys, startedAt) {
  var cache = CacheService.getScriptCache(), key = conversationKey_(userId), lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    var current;
    try { current = JSON.parse(cache.get(key) || 'null'); } catch (_) {}
    if (current && current.savedAt > startedAt) return; // 較慢的舊題不可蓋掉已保存的新對話。
    var works = Array.from(new Set(keys || []));
    if (!works.length && request.focus) works = [request.focus];
    var focus = request.focus || (works.length === 1 ? works[0] : null);
    cache.put(key, JSON.stringify({ fingerprint: fingerprint, works: works, focus: focus,
      topicId: request.topicId || null,
      lastQuestion: Array.from(request.memoryAnchor || request.previousQuestion || request.question).slice(0, 800).join(''), savedAt: Date.now(),
      expiresAt: Date.now() + 600000 }), 600);
  } finally { lock.releaseLock(); }
}
