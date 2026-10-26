/**
 * 【待補充問題：記錄在原文件，但不當成履歷事實】
 * 只在確定「找不到足夠履歷證據」時記錄；API 錯誤不記成資料缺漏。
 * 以問題文字合併次數、保留主人註記；不附上 LINE 使用者識別碼。
 */

/**
 * 產生待補充區說明，提醒主人把可公開答案補回履歷正文。
 */
function feedbackSectionText_() {
  return '\n[[UNANSWERED_QUESTIONS]]\n待補充問題\n' +
    '機器人無法從履歷取得足夠答案時，會在此記錄問題、原因、最近提問時間與次數。檢索未命中不代表履歷一定缺漏，請先核對現有內容。\n' +
    '此區不會作為 RAG 知識。確認後請將可公開的答案補進 [[PUBLIC]] 與 [[/PUBLIC]] 之間，再執行 syncKnowledgeBase；可在表格的維護狀態填寫「已補充」或「不公開」，也可刪除已處理的列。\n' +
    '[[/UNANSWERED_QUESTIONS]]\n';
}

/**
 * 整理訪客問題為一般文字，避免問題中的標記被當成控制指令。
 */
function feedbackQuestion_(question) {
  // 訪客問題保持單行，內含的標記字串才不會成為文件控制標記。
  return String(question || '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * 找到或建立待補充問題表格；保留既有列與主人維護狀態。
 */
function feedbackTable_(body) {
  var headers = ['使用者問題', '記錄原因', '最近提問／次數', '維護狀態'];
  var start = -1, end = -1, table = null;
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var text = child.asParagraph().getText().trim();
      if (text === '[[UNANSWERED_QUESTIONS]]') {
        if (start >= 0) throw new Error('INVALID_FEEDBACK_SECTION');
        start = i;
      } else if (text === '[[/UNANSWERED_QUESTIONS]]') {
        if (start < 0 || end >= 0) throw new Error('INVALID_FEEDBACK_SECTION');
        end = i;
      }
    } else if (start >= 0 && end < 0 && child.getType() === DocumentApp.ElementType.TABLE) {
      var candidate = child.asTable();
      if (candidate.getNumRows() && candidate.getRow(0).getNumCells() === headers.length &&
          headers.every(function (header, n) { return candidate.getCell(0, n).getText() === header; })) {
        if (table) throw new Error('INVALID_FEEDBACK_SECTION');
        table = candidate;
      }
    }
  }
  if (start < 0 && end < 0) {
    feedbackSectionText_().trim().split('\n').forEach(function (text) {
      body.appendParagraph(text).setHeading(text === '待補充問題'
        ? DocumentApp.ParagraphHeading.HEADING1 : DocumentApp.ParagraphHeading.NORMAL);
    });
    end = body.getNumChildren() - 1;
  } else if (start < 0 || end <= start) throw new Error('INVALID_FEEDBACK_SECTION');
  return table || body.insertTable(end, [headers]);
}

/**
 * 以鎖避免同時寫入；同題累計次數，未知錯誤不暴露原文。
 */
function recordUnansweredQuestion_(question, reason, cfg) {
  var labels = {
    NO_RELEVANT_CHUNKS: '檢索未找到符合門檻的履歷片段，請確認內容或檢索結果。',
    INSUFFICIENT_EVIDENCE: '已檢索到片段，但 AI 判定內容不足以回答，請確認或補充。'
  };
  if (!Object.prototype.hasOwnProperty.call(labels, reason)) return false;
  question = feedbackQuestion_(question);
  if (!question) return false;
  var lock = LockService.getScriptLock(), locked = false;
  try {
    locked = lock.tryLock(1500);
    if (!locked) { safeLog_('FEEDBACK_BUSY'); return false; }
    var doc = DocumentApp.openById(cfg.docId);
    var tab = cfg.tabIds.indexOf('*') >= 0 ? doc.getTabs()[0] : doc.getTab(cfg.tabIds[0]);
    if (!tab) throw new Error('DOC_TAB_NOT_FOUND');
    var body = tab.asDocumentTab().getBody();
    // 公開／私人標記未成對時拒絕寫入，避免破壞文件的公開範圍。
    extractPublic_(body.getText());
    var table = feedbackTable_(body), row = null, count = 1;
    for (var i = 1; i < table.getNumRows(); i++) {
      var candidate = table.getRow(i);
      if (candidate.getNumCells() !== 4) continue;
      if (candidate.getCell(0).getText() === '問題：' + question) {
        row = candidate;
        var previous = row.getCell(2).getText().match(/次數：(\d+)$/);
        count = previous ? Number(previous[1]) + 1 : 1;
        break;
      }
    }
    if (!row) {
      row = table.appendTableRow();
      ['問題：' + question, '', '', '待確認'].forEach(function (value) { row.appendTableCell(value); });
    }
    row.getCell(1).setText(labels[reason]);
    row.getCell(2).setText(Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') +
      '（台北時間）\n次數：' + count);
    // 保留主人維護狀態；實際存檔成功後才能向訪客表示已記錄。
    doc.saveAndClose();
    safeLog_('FEEDBACK_RECORDED');
    return true;
  } catch (_) {
    safeLog_('FEEDBACK_WRITE_FAILED');
    return false;
  } finally { if (locked) lock.releaseLock(); }
}
