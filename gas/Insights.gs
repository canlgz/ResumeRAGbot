/**
 * 【主人的每週提問洞察】v3 候選功能
 * 每次問答只累加「狀態、語言、被引用的履歷章節、交流目的」的匿名次數，
 * 不保存訪客問題原文、回答內容或 userId；問題原文仍只由待補充區記錄資料不足的題目。
 * 統計存在指令碼屬性 INSIGHT_YYYY-MM-DD（台北時間週一），保留最近 8 週。
 */

var INSIGHT_PREFIX_ = 'INSIGHT_', INSIGHT_KEEP_WEEKS_ = 8, INSIGHT_MAX_SECTIONS_ = 40;
var INSIGHT_INTENT_LABELS_ = { introduction: '初次認識', capability: '評估能力／職務適配', achievement: '關注成果亮點',
  interest: '表達想深入交流', appreciation: '致謝收尾', clarification: '需要釐清', neutral: '一般資訊' };

/** 以台北時間計算該週週一的日期，作為統計的週次鍵。 */
function insightWeekKey_(date) {
  var taipei = new Date((date || new Date()).getTime() + 8 * 3600000);
  var monday = new Date(Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), taipei.getUTCDate() - (taipei.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/** 空白統計結構；欄位固定，報告不必猜測舊資料格式。 */
function emptyInsight_(week) {
  return { week: week, total: 0, answered: 0, missing: 0, other: 0, languages: { zh: 0, en: 0 }, sections: {}, intents: {} };
}

/** 讀取某週統計；損壞時視為空白，不讓統計錯誤影響問答。 */
function readInsight_(week) {
  try {
    var value = JSON.parse(PropertiesService.getScriptProperties().getProperty(INSIGHT_PREFIX_ + week) || 'null');
    if (value && value.week === week && Number.isFinite(value.total)) return value;
  } catch (_) {}
  return emptyInsight_(week);
}

/**
 * 累加一次問答。只在 LINE 回覆成功後由入口呼叫；取不到鎖就略過，統計是盡力而為。
 * entry：{ status: 'answered'|'missing'|其他, language: 'zh'|'en', sections: [章節名稱], intent }
 */
function recordInsight_(entry, now) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) { safeLog_('INSIGHT_BUSY'); return false; }
  try {
    var props = PropertiesService.getScriptProperties(), week = insightWeekKey_(now), stats = readInsight_(week);
    stats.total++;
    if (entry.status === 'answered') stats.answered++;
    else if (entry.status === 'missing') stats.missing++;
    else stats.other++;
    var language = entry.language === 'en' ? 'en' : 'zh';
    stats.languages[language] = (stats.languages[language] || 0) + 1;
    (entry.sections || []).slice(0, 5).forEach(function (section) {
      var name = Array.from(String(section)).slice(0, 40).join('');
      if (!name) return;
      if (stats.sections[name] || Object.keys(stats.sections).length < INSIGHT_MAX_SECTIONS_) stats.sections[name] = (stats.sections[name] || 0) + 1;
    });
    if (entry.status === 'answered' && INSIGHT_INTENT_LABELS_[entry.intent]) stats.intents[entry.intent] = (stats.intents[entry.intent] || 0) + 1;
    props.setProperty(INSIGHT_PREFIX_ + week, JSON.stringify(stats));
    pruneInsights_(props, week);
    return true;
  } catch (_) {
    safeLog_('INSIGHT_SAVE_FAILED');
    return false;
  } finally { lock.releaseLock(); }
}

/** 只保留最近 INSIGHT_KEEP_WEEKS_ 週，避免指令碼屬性無限增加。 */
function pruneInsights_(props, currentWeek) {
  var oldest = new Date(Date.parse(currentWeek + 'T00:00:00Z') - (INSIGHT_KEEP_WEEKS_ - 1) * 7 * 86400000).toISOString().slice(0, 10);
  Object.keys(props.getProperties()).filter(function (key) {
    return key.indexOf(INSIGHT_PREFIX_) === 0 && key.slice(INSIGHT_PREFIX_.length) < oldest;
  }).forEach(function (key) { props.deleteProperty(key); });
}

/** 依次數排序，取前幾名，格式為「名稱 n 次」。 */
function insightTop_(counts, limit, labels) {
  return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); }).slice(0, limit)
    .map(function (key) { return (labels ? labels[key] || key : key) + ' ' + counts[key] + ' 次'; });
}

/**
 * 把一週統計整理成主人看得懂的文字報告，並依數字給出可行的維護建議。
 * 建議只根據統計，不推測訪客身分或心情。
 */
function insightReport_(week, name) {
  var stats = readInsight_(week);
  var end = new Date(Date.parse(week + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  var lines = ['📊 ' + (name || '履歷') + '｜每週提問洞察', '統計期間：' + week + ' ～ ' + end + '（台北時間）', ''];
  if (!stats.total) {
    lines.push('這週還沒有訪客提問。可以把 LINE 好友連結放進履歷、作品集或求職平台，增加曝光。');
    return lines.join('\n');
  }
  var rate = Math.round(stats.answered / stats.total * 100);
  lines.push('提問數：' + stats.total + ' 題（成功回答 ' + stats.answered + '、資料不足 ' + stats.missing +
    (stats.other ? '、其他 ' + stats.other : '') + '）', '回答率：' + rate + '%',
    '語言：中文 ' + (stats.languages.zh || 0) + ' 題、英文 ' + (stats.languages.en || 0) + ' 題');
  var sections = insightTop_(stats.sections, 5);
  if (sections.length) lines.push('', '最常被引用的履歷章節：', sections.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n'));
  var intents = insightTop_(stats.intents, 3, INSIGHT_INTENT_LABELS_);
  if (intents.length) lines.push('', '訪客交流目的（AI 依提問判斷）：', intents.join('、'));
  var tips = [];
  if (stats.missing) tips.push('有 ' + stats.missing + ' 題資料不足：打開履歷文件末尾的「待補充問題」，把可公開的答案補進 [[PUBLIC]] 區，再執行 syncKnowledgeBase。');
  if (stats.languages.en) tips.push('有英文提問：檢查英文回答的專有名詞是否正確；必要時在履歷中補上公司、學校或專案的英文名稱。');
  if (sections.length) tips.push('「' + Object.keys(stats.sections).sort(function (a, b) { return stats.sections[b] - stats.sections[a]; })[0] +
    '」最受關注，可補充更具體的做法、本人角色或成果數據。');
  if (tips.length) lines.push('', '建議下一步：', tips.map(function (t) { return '• ' + t; }).join('\n'));
  lines.push('', '此報告只統計次數，不保存訪客問題原文或身分。');
  return lines.join('\n');
}

/**
 * 每週排程：週一寄出上一週報告。有設定 OWNER_LINE_USER_ID 用 LINE 推播，否則寄 Email 給專案擁有者。
 */
function sendWeeklyInsight_() {
  var cfg = config_(), week = insightWeekKey_(new Date(Date.now() - 7 * 86400000));
  var text = insightReport_(week, cfg.name), ownerId = ownerLineUserId_(), result = { week: week };
  if (ownerId) {
    result.channel = 'line';
    result.status = sendOwnerLineText_(ownerId, text, cfg, Utilities.getUuid()).status;
  } else {
    result.channel = 'email';
    try {
      MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: 'ResumeRAGbot 每週提問洞察（' + week + '）', body: text });
      result.status = 'sent';
    } catch (_) { result.status = 'failed'; safeLog_('INSIGHT_EMAIL_FAILED'); }
  }
  console.log(JSON.stringify(result));
  return result;
}

/** 主人在 LINE 輸入「本週洞察」時回覆本週與上週報告；只認 OWNER_LINE_USER_ID，訪客輸入同樣文字視為一般問題。 */
function ownerInsightMessages_(text, userId, cfg) {
  if (!/^(?:本週洞察|每週洞察|洞察報告|weekly insight)$/i.test(text)) return null;
  var ownerId = ownerLineUserId_();
  if (!ownerId || userId !== ownerId) return null;
  var now = new Date();
  return [textMessage_(insightReport_(insightWeekKey_(now), cfg.name)),
    textMessage_('上週回顧\n\n' + insightReport_(insightWeekKey_(new Date(now.getTime() - 7 * 86400000)), cfg.name))];
}
