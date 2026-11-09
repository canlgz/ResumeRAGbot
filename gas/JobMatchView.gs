/**
 * 【V3 候選：職缺對照的 LINE 畫面】
 * 只負責把草稿組成文字與 Flex 訊息，不呼叫 API、不改草稿，方便測試。
 */

/** 輸入階段的 Quick Reply：完成輸入與取消。 */
function withInputReply_(draft) {
  return function (message) {
    message.quickReply = { items: [
      { type: 'action', action: { type: 'postback', label: '完成輸入', data: 'jm:done:' + draft.id, displayText: '完成輸入' } },
      { type: 'action', action: { type: 'postback', label: '取消', data: 'jm:cancel', displayText: '取消職缺對照' } }
    ] };
    return message;
  };
}

var JOB_LEVEL_LABEL_ = { must: '必要', plus: '加分', unspecified: '未指定' };
var JOB_LEVEL_COLOR_ = { must: '#143D35', plus: '#A18150', unspecified: '#687770' };

function jobText_(value, size, color, bold) {
  return { type: 'text', text: String(value), size: size, color: color, weight: bold ? 'bold' : 'regular', wrap: true };
}

function jobButton_(label, data, style) {
  return { type: 'button', height: 'sm', style: style || 'secondary', action: { type: 'postback', label: label, data: data, displayText: label } };
}

/** 等級標籤小膠囊。 */
function jobLevelTag_(level) {
  return { type: 'box', layout: 'vertical', flex: 0, paddingStart: '8px', paddingEnd: '8px', paddingTop: '2px', paddingBottom: '2px',
    cornerRadius: '8px', backgroundColor: JOB_LEVEL_COLOR_[level] || '#687770',
    contents: [jobText_(JOB_LEVEL_LABEL_[level] || '未指定', 'xxs', '#FFFFFF', true)] };
}

/**
 * 確認卡：每項條件一張（等級、條件、職缺原句、調整按鈕），再加一則操作說明。
 * 人資按「開始對照」前，不做任何履歷分析。
 */
function criteriaConfirmMessages_(draft) {
  var bubbles = draft.criteria.map(function (c, i) {
    var buttons = [];
    if (c.level !== 'must') buttons.push(jobButton_('設為必要', 'jm:lv:' + draft.id + ':' + c.id + ':must'));
    if (c.level !== 'plus') buttons.push(jobButton_('設為加分', 'jm:lv:' + draft.id + ':' + c.id + ':plus'));
    buttons.push(jobButton_('刪除', 'jm:del:' + draft.id + ':' + c.id));
    return { type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'horizontal', paddingAll: '12px', backgroundColor: '#143D35', contents: [
        jobText_('條件 ' + (i + 1) + '／' + draft.criteria.length, 'xs', '#FFFFFF', true), jobLevelTag_(c.level)] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: [
        jobText_(c.text, 'md', '#143D35', true),
        jobText_(c.source === 'hr' ? '人資補充' : '職缺原句：「' + c.quote + '」', 'xxs', '#687770', false)] },
      footer: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '10px', contents: buttons } };
  });
  var lines = ['職缺對照 2／3：請確認' + (draft.title ? '「' + draft.title + '」的' : '') + '條件（共 ' + draft.criteria.length + ' 項）。',
    '可以在卡片上調整必要／加分或刪除；沒問題就按「開始對照」。'];
  if (draft.excluded.length) lines.push('不評估（與工作能力無關）：' + draft.excluded.join('、'));
  var guide = textMessage_(lines.join('\n\n'));
  guide.quickReply = { items: [
    { type: 'action', action: { type: 'postback', label: '開始對照', data: 'jm:run:' + draft.id, displayText: '開始對照' } },
    { type: 'action', action: { type: 'postback', label: '補充條件', data: 'jm:add:' + draft.id, displayText: '補充條件' } },
    { type: 'action', action: { type: 'postback', label: '重新輸入', data: 'jm:restart', displayText: '重新輸入職缺' } },
    { type: 'action', action: { type: 'postback', label: '取消', data: 'jm:cancel', displayText: '取消職缺對照' } }
  ] };
  if (!bubbles.length) return [guide];
  return [{ type: 'flex', altText: '請確認職缺條件', contents: { type: 'carousel', contents: bubbles } }, guide];
}

// 待確認用灰色、不用紅色：履歷沒寫不代表不會。
var JOB_STATUS_STYLE_ = {
  supported: { label: '有依據', color: '#2E7D32', rank: 2 },
  partial: { label: '部分相符', color: '#F9A825', rank: 1 },
  unconfirmed: { label: '待確認', color: '#BDBDBD', rank: 0 }
};
var JOB_LEVEL_RANK_ = { must: 0, plus: 1, unspecified: 2 };

/** 必要 → 加分 → 未指定；同等級內「待確認 → 部分相符 → 有依據」，要追問的放上面。 */
function sortedRows_(draft) {
  var results = {};
  draft.results.forEach(function (r) { results[r.id] = r; });
  return draft.criteria.map(function (c, i) { return { criterion: c, result: results[c.id], order: i }; })
    .filter(function (row) { return row.result; })
    .sort(function (a, b) {
      return (JOB_LEVEL_RANK_[a.criterion.level] - JOB_LEVEL_RANK_[b.criterion.level]) ||
        (JOB_STATUS_STYLE_[a.result.status].rank - JOB_STATUS_STYLE_[b.result.status].rank) || (a.order - b.order);
    });
}

/** 「必要條件 X／Y 有依據・加分條件 X／Y 有依據」；用比例，不叫分數。 */
function jobMatchSummary_(draft) {
  var rows = sortedRows_(draft), parts = [];
  [['must', '必要條件'], ['plus', '加分條件'], ['unspecified', '未指定條件']].forEach(function (pair) {
    var group = rows.filter(function (row) { return row.criterion.level === pair[0]; });
    if (!group.length) return;
    var ok = group.filter(function (row) { return row.result.status === 'supported'; }).length;
    parts.push(pair[1] + ' ' + ok + '／' + group.length + ' 有依據');
  });
  return parts.join('・');
}

/** 燈號熱圖卡：每列 = 色塊＋條件＋等級＋一句說明，底部附圖例。 */
function heatmapMessage_(draft) {
  var rows = sortedRows_(draft).map(function (row) {
    var style = JOB_STATUS_STYLE_[row.result.status];
    return { type: 'box', layout: 'horizontal', spacing: 'md', paddingTop: '6px', paddingBottom: '6px', contents: [
      { type: 'box', layout: 'vertical', width: '56px', flex: 0, cornerRadius: '6px', backgroundColor: style.color, justifyContent: 'center', paddingAll: '6px',
        contents: [jobText_(style.label, 'xxs', row.result.status === 'unconfirmed' ? '#31483D' : '#FFFFFF', true)] },
      { type: 'box', layout: 'vertical', flex: 1, spacing: 'xs', contents: [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [jobText_(row.criterion.text, 'sm', '#143D35', true), jobLevelTag_(row.criterion.level)] },
        jobText_(row.result.note || style.label, 'xxs', '#53635E', false)] }
    ] };
  });
  var legend = { type: 'box', layout: 'horizontal', spacing: 'md', margin: 'lg', contents: ['supported', 'partial', 'unconfirmed'].map(function (key) {
    return { type: 'box', layout: 'horizontal', spacing: 'xs', contents: [
      { type: 'box', layout: 'vertical', width: '10px', height: '10px', flex: 0, cornerRadius: '2px', backgroundColor: JOB_STATUS_STYLE_[key].color, contents: [] },
      jobText_(JOB_STATUS_STYLE_[key].label, 'xxs', '#687770', false)] };
  }) };
  var summary = jobMatchSummary_(draft);
  return { type: 'flex', altText: '職缺對照結果：' + summary, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#143D35', spacing: 'xs', contents: [
      jobText_('職缺對照 3／3', 'xxs', '#B7D8C9', false),
      jobText_(draft.title || '職缺對照結果', 'md', '#FFFFFF', true),
      jobText_(summary, 'xs', '#FFFFFF', false)] },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: rows.concat([{ type: 'separator', margin: 'md' }, legend,
      jobText_('只依公開履歷判斷有沒有依據，不是能力評分；待確認代表履歷未提及，不代表不具備。', 'xxs', '#687770', false)]) } } };
}

/** 有依據／部分相符的項目各一張證據卡：履歷原句＋來源章節。 */
function evidenceCarousel_(draft) {
  var bubbles = sortedRows_(draft).filter(function (row) { return row.result.evidence.length; }).slice(0, JOB_MATCH_LIMITS_.criteria).map(function (row) {
    var style = JOB_STATUS_STYLE_[row.result.status];
    return { type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'horizontal', paddingAll: '10px', backgroundColor: style.color, contents: [
        jobText_(style.label, 'xs', row.result.status === 'unconfirmed' ? '#31483D' : '#FFFFFF', true)] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px', contents: [jobText_(row.criterion.text, 'sm', '#143D35', true)]
        .concat(row.result.evidence.map(function (e) { return jobText_('「' + e.quote + '」', 'xs', '#31483D', false); }))
        .concat([jobText_('資料來源：' + Array.from(new Set(row.result.evidence.map(function (e) { return e.section; }))).join('、'), 'xxs', '#687770', false)]) } };
  });
  return bubbles.length ? { type: 'flex', altText: '履歷證據', contents: { type: 'carousel', contents: bubbles } } : null;
}

/** 面談問題與後續動作。 */
function followupMessage_(draft) {
  var questions = sortedRows_(draft).filter(function (row) { return row.result.question; })
    .map(function (row, i) { return (i + 1) + '. ' + row.result.question; });
  var text = questions.length
    ? '建議面談時請本人說明（履歷未寫清楚，不代表不具備）：\n\n' + questions.join('\n')
    : '每項條件都在履歷中找到依據。面談時可以請本人補充細節與成果。';
  var message = textMessage_(text + '\n\n想進一步聯繫，可以按「邀約面談」，以上問題會自動帶入邀約。');
  message.quickReply = { items: [
    { type: 'action', action: { type: 'postback', label: '邀約面談', data: 'jm:invite:' + draft.id, displayText: '邀約面談' } },
    { type: 'action', action: { type: 'postback', label: '換職缺', data: 'jm:restart', displayText: '換一份職缺' } },
    { type: 'action', action: { type: 'postback', label: '回首頁', data: 'nav:home', displayText: '首頁' } }
  ] };
  return message;
}

/** 依序：熱圖、證據卡（若有）、面談問題；不超過 LINE 單次 5 則。 */
function jobMatchResultMessages_(draft) {
  var evidence = evidenceCarousel_(draft);
  return [heatmapMessage_(draft)].concat(evidence ? [evidence] : []).concat([followupMessage_(draft)]);
}

/** 輸入階段的提示：開始、收到內容或提醒下一步。 */
function jobInputPrompt_(draft, mode) {
  var status = '（共 ' + jobTextLength_(draft) + ' 字／' + draft.imageCount + ' 張圖）';
  var text = mode === 'start'
    ? '職缺對照 1／3：請貼上職缺內容，可以分成多則傳送，也可以直接傳職缺截圖（最多 ' + JOB_MATCH_LIMITS_.images + ' 張）。\n\n' +
      '全部貼完後按「完成輸入」。職缺內容只用於這次對照，30 分鐘後自動清除，不會寫入履歷。'
    : mode === 'received'
      ? '已收到第 ' + (draft.texts.length) + ' 段' + status + '。繼續貼，或按「完成輸入」。'
      : '目前在職缺輸入階段' + status + '。請繼續貼職缺內容，或按「完成輸入」。';
  return [textMessage_(text)].map(withInputReply_(draft));
}
