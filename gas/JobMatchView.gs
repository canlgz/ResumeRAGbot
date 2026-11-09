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

/** 對照結果（Task 4 會換成燈號熱圖卡）。 */
function jobMatchResultMessages_(draft) {
  return [textMessage_(draft.results.map(function (r) { return r.id + '：' + r.status; }).join('\n'))];
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
