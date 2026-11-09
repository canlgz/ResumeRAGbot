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
