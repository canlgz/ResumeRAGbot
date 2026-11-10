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

/**
 * 主人在 LINE 輸入「本週洞察」時回覆儀表卡片；按「上週回顧」看上週。
 * 只認 OWNER_LINE_USER_ID，訪客輸入同樣文字視為一般問題。
 */
function ownerInsightMessages_(text, userId, cfg) {
  var lastWeek = text === 'insight:last';
  if (!lastWeek && !/^(?:本週洞察|每週洞察|洞察報告|weekly insight)$/i.test(text)) return null;
  var ownerId = ownerLineUserId_();
  if (!ownerId || userId !== ownerId) return null;
  var date = lastWeek ? new Date(Date.now() - 7 * 86400000) : new Date();
  return [insightFlex_(insightWeekKey_(date), cfg.name, lastWeek)];
}

/**
 * 週報儀表卡：大數字看總量與回答率，橫條看中英比例，再列熱門章節與下一步。
 * 卡片內容與文字版 insightReport_ 使用同一份統計；altText 放文字摘要供通知預覽。
 */
function insightFlex_(week, name, isLastWeek) {
  var stats = readInsight_(week), end = new Date(Date.parse(week + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  var rate = stats.total ? Math.round(stats.answered / stats.total * 100) : 0;
  function t(text, size, color, bold, extra) {
    return Object.assign({ type: 'text', text: String(text), size: size, color: color, weight: bold ? 'bold' : 'regular', wrap: true }, extra || {});
  }
  function kpi(value, label, color) {
    return { type: 'box', layout: 'vertical', flex: 1, paddingAll: '10px', cornerRadius: '10px', backgroundColor: '#F1F5F2', contents: [
      t(value, 'xl', color || '#143D35', true, { align: 'center' }), t(label, 'xxs', '#687770', false, { align: 'center' })] };
  }
  var body = [t((isLastWeek ? '上週回顧｜' : '') + week.slice(5) + ' ～ ' + end.slice(5), 'xs', '#687770', false)];
  if (!stats.total) {
    body.push(t('這週還沒有訪客提問。', 'md', '#143D35', true, { margin: 'lg' }),
      t('可以把 LINE 好友連結放進履歷、作品集或求職平台，增加曝光。', 'sm', '#53635E', false));
  } else {
    body.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', contents: [
      kpi(stats.total, '提問數'), kpi(rate + '%', '回答率', rate >= 80 ? '#23735B' : '#A15C2E'), kpi(stats.missing, '資料不足', stats.missing ? '#A15C2E' : '#143D35')] });
    var zh = stats.languages.zh || 0, en = stats.languages.en || 0;
    body.push(t('語言　中文 ' + zh + '・英文 ' + en, 'xs', '#31483D', true, { margin: 'lg' }),
      { type: 'box', layout: 'horizontal', height: '8px', cornerRadius: '4px', margin: 'sm', backgroundColor: '#DDE6DF', contents: [
        { type: 'box', layout: 'vertical', flex: Math.max(zh, 0), backgroundColor: '#23735B', contents: [] },
        { type: 'box', layout: 'vertical', flex: Math.max(en, 0), backgroundColor: '#C9A46A', contents: [] }].filter(function (b) { return b.flex > 0; }) });
    var sections = insightTop_(stats.sections, 3);
    if (sections.length) {
      body.push(t('最常被引用的章節', 'xs', '#31483D', true, { margin: 'lg' }));
      sections.forEach(function (s, i) { body.push(t((i + 1) + '. ' + s, 'xs', '#53635E', false)); });
    }
    var intents = insightTop_(stats.intents, 2, INSIGHT_INTENT_LABELS_);
    if (intents.length) body.push(t('交流目的（AI 判斷）', 'xs', '#31483D', true, { margin: 'lg' }), t(intents.join('、'), 'xs', '#53635E', false));
    if (stats.missing) body.push({ type: 'box', layout: 'vertical', margin: 'lg', paddingAll: '10px', cornerRadius: '8px', backgroundColor: '#FBF1E7', contents: [
      t('💡 有 ' + stats.missing + ' 題資料不足，按下方「處理待補充」就能直接補答。', 'xs', '#7A4520', false)] });
  }
  body.push(t('只統計次數，不保存訪客問題原文或身分。', 'xxs', '#8A9690', false, { margin: 'lg' }));
  function button(label, data, primary) {
    return { type: 'button', height: 'sm', style: primary ? 'primary' : 'secondary', color: primary ? '#23735B' : undefined,
      action: { type: 'postback', label: label, data: data, displayText: label } };
  }
  var footer = [button(isLastWeek ? '本週洞察' : '上週回顧', isLastWeek ? '本週洞察' : 'insight:last', false)];
  if (stats.missing) footer.unshift(button('處理待補充', '待補充', true));
  var alt = (name || '履歷') + '｜' + (isLastWeek ? '上週' : '本週') + '提問 ' + stats.total + ' 題、回答率 ' + rate + '%';
  return { type: 'flex', altText: alt, quickReply: quickReply_(), contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: '#143D35', contents: [
      t('📊 每週提問洞察', 'md', '#FFFFFF', true), t(Array.from(name || '履歷').slice(0, 30).join(''), 'xxs', '#B7D8C9', false)] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: footer } } };
}
