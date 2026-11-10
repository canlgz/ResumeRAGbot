/**
 * 【主人在 LINE 一鍵補答】v3 候選功能
 * 主人傳「待補充」→ 列出文件待補充區中「待確認」的問題 →
 * 回「補充 1：答案」→ 預覽確認 → 寫進 [[PUBLIC]] 的「## 補充問答」、表格標為已補充 → 自動同步。
 * 只認 OWNER_LINE_USER_ID；寫入的文字完全是主人輸入的原文，不經 AI 改寫。
 * 清單與草稿只存在雜湊鍵快取 30 分鐘，不寫 Doc 以外的地方。
 */

var OWNER_FILL_SECONDS_ = 1800, OWNER_FILL_HEADING_ = '## 補充問答', OWNER_FILL_MAX_ = 10;

function ownerFillKey_(kind, userId) { return 'ownerfill:' + kind + ':' + sha256_(ScriptApp.getScriptId() + ':' + userId); }

/**
 * 主人專用指令入口：本週洞察、待補充、補充 N：答案、確認／取消。
 * 非主人送出 fill: 按鈕時回覆限制說明；其他文字回傳 null，交給一般流程。
 */
function ownerCommandMessages_(event, text, cfg) {
  var ownerId = ownerLineUserId_(), isOwner = !!ownerId && event.source.userId === ownerId;
  if (!isOwner) return /^fill:/.test(text) ? [textMessage_('這個操作僅限履歷主人使用。')] : null;
  var insight = ownerInsightMessages_(text, event.source.userId, cfg);
  if (insight) return insight;
  if (/^(?:待補充|待補充問題|補充清單)$/.test(text)) return [ownerFillList_(event.source.userId, cfg)];
  var fill = /^補充\s*(\d{1,2})\s*[：:]\s*([\s\S]+)$/.exec(text);
  if (fill) return [ownerFillDraft_(event.source.userId, Number(fill[1]), fill[2].trim())];
  if (text === 'fill:cancel') {
    CacheService.getScriptCache().remove(ownerFillKey_('draft', event.source.userId));
    return [textMessage_('已取消，履歷沒有變更。')];
  }
  if (text === 'fill:confirm') return [ownerFillConfirm_(event.source.userId, cfg)];
  return null;
}

/** 依設定開啟要寫入的履歷分頁；與待補充紀錄使用同一個分頁。 */
function ownerFillTab_(cfg) {
  var doc = DocumentApp.openById(cfg.docId);
  var tab = cfg.tabIds.indexOf('*') >= 0 ? doc.getTabs()[0] : doc.getTab(cfg.tabIds[0]);
  if (!tab) throw new Error('DOC_TAB_NOT_FOUND');
  return { doc: doc, body: tab.asDocumentTab().getBody() };
}

/** 唯讀找出待補充表格中維護狀態為「待確認」的列；找不到表格時回傳空陣列，不建立表格。 */
function pendingQuestions_(body) {
  var headers = ['使用者問題', '記錄原因', '最近提問／次數', '維護狀態'], rows = [];
  for (var i = 0; i < body.getNumChildren(); i++) {
    var child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TABLE) continue;
    var table = child.asTable();
    if (!table.getNumRows() || table.getRow(0).getNumCells() !== 4 ||
        !headers.every(function (h, n) { return table.getCell(0, n).getText() === h; })) continue;
    for (var r = 1; r < table.getNumRows(); r++) {
      var row = table.getRow(r);
      if (row.getNumCells() !== 4 || row.getCell(3).getText().trim() !== '待確認') continue;
      var question = row.getCell(0).getText().replace(/^問題：/, '').trim(), count = row.getCell(2).getText().match(/次數：(\d+)/);
      if (question) rows.push({ question: question, count: count ? Number(count[1]) : 1, row: row });
    }
  }
  return rows;
}

/** 列出最多 10 題，並把題號對應的問題存成快照，避免之後新增的問題改變題號。 */
function ownerFillList_(userId, cfg) {
  var pending = pendingQuestions_(ownerFillTab_(cfg).body).slice(0, OWNER_FILL_MAX_);
  if (!pending.length) return textMessage_('目前沒有「待確認」的待補充問題 🎉');
  CacheService.getScriptCache().put(ownerFillKey_('list', userId),
    JSON.stringify(pending.map(function (p) { return p.question; })), OWNER_FILL_SECONDS_);
  return textMessage_('待補充問題（' + pending.length + ' 題）\n\n' + pending.map(function (p, i) {
    return (i + 1) + '. ' + Array.from(p.question).slice(0, 80).join('') + '（' + p.count + ' 次）';
  }).join('\n') + '\n\n回覆「補充 題號：答案」即可，例如：\n補充 1：我有普通小客車駕照。\n\n答案會原文寫進履歷公開區，請只寫願意公開的內容。若不想公開，可到文件把維護狀態改成「不公開」。');
}

/** 檢查題號與答案，建立待確認草稿；此時還不寫入文件。 */
function ownerFillDraft_(userId, number, answer) {
  var cache = CacheService.getScriptCache(), list;
  try { list = JSON.parse(cache.get(ownerFillKey_('list', userId)) || 'null'); } catch (_) {}
  if (!Array.isArray(list)) return textMessage_('請先傳「待補充」取得最新題號（清單約 30 分鐘有效）。');
  if (number < 1 || number > list.length) return textMessage_('題號 ' + number + ' 不在清單中，請傳「待補充」重新查看。');
  if (/\[\[|\]\]/.test(answer)) return textMessage_('答案不能包含 [[ 或 ]]，以免破壞履歷的公開標記。');
  answer = answer.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!answer || Array.from(answer).length > 500) return textMessage_('答案需為 1～500 字，請重新輸入。');
  cache.put(ownerFillKey_('draft', userId), JSON.stringify({ question: list[number - 1], answer: answer }), OWNER_FILL_SECONDS_);
  var message = textMessage_('請確認要寫進履歷公開區的內容：\n\n問：' + list[number - 1] + '\n答：' + answer +
    '\n\n確認後會寫入「' + OWNER_FILL_HEADING_.replace('## ', '') + '」段落並自動同步，訪客之後就能查到。');
  message.quickReply = { items: [
    { type: 'action', action: { type: 'postback', label: '確認寫入', data: 'fill:confirm', displayText: '確認寫入' } },
    { type: 'action', action: { type: 'postback', label: '取消', data: 'fill:cancel', displayText: '取消' } }
  ] };
  return message;
}

/**
 * 寫入 [[PUBLIC]] 的補充問答段落並把表格列標為已補充，再同步索引。
 * 寫入前後都核對公開標記；同步失敗時文件仍保留，提示主人到 GAS 手動同步。
 */
function ownerFillConfirm_(userId, cfg) {
  var cache = CacheService.getScriptCache(), key = ownerFillKey_('draft', userId), draft;
  try { draft = JSON.parse(cache.get(key) || 'null'); } catch (_) {}
  if (!draft || typeof draft.question !== 'string' || typeof draft.answer !== 'string') {
    return textMessage_('找不到待確認的補充內容（可能已超過 30 分鐘），請重新傳「待補充」。');
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return textMessage_('文件正在更新中，請稍後再按一次「確認寫入」。');
  try {
    var opened = ownerFillTab_(cfg), body = opened.body;
    extractPublic_(body.getText());
    var start = -1, end = -1, heading = -1;
    for (var i = 0; i < body.getNumChildren(); i++) {
      var child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      var text = child.asParagraph().getText().trim();
      if (text === '[[PUBLIC]]' && start < 0) start = i;
      else if (text === '[[/PUBLIC]]' && start >= 0 && end < 0) end = i;
      else if (start >= 0 && end < 0 && text === OWNER_FILL_HEADING_) heading = i;
    }
    if (start < 0 || end < 0) throw new Error('INVALID_PUBLIC_MARKERS');
    // 已有補充問答段落時接在段落最後；沒有時在公開區結尾新增段落標題。
    var at = end;
    if (heading >= 0) {
      at = heading + 1;
      while (at < end) {
        var next = body.getChild(at);
        if (next.getType() === DocumentApp.ElementType.PARAGRAPH && /^##\s/.test(next.asParagraph().getText().trim())) break;
        at++;
      }
    } else {
      body.insertParagraph(at, OWNER_FILL_HEADING_).setHeading(DocumentApp.ParagraphHeading.NORMAL);
      at++;
    }
    body.insertParagraph(at, '問：' + draft.question).setHeading(DocumentApp.ParagraphHeading.NORMAL);
    body.insertParagraph(at + 1, '答：' + draft.answer).setHeading(DocumentApp.ParagraphHeading.NORMAL);
    extractPublic_(body.getText());
    pendingQuestions_(body).filter(function (p) { return p.question === draft.question; })
      .forEach(function (p) { p.row.getCell(3).setText('已補充（LINE）'); });
    opened.doc.saveAndClose();
    cache.remove(key);
    cache.remove(ownerFillKey_('list', userId));
  } catch (error) {
    safeLog_(errorCode_(error));
    return textMessage_('寫入失敗（' + errorCode_(error) + '），履歷沒有變更。請檢查文件的 [[PUBLIC]] 標記後再試。');
  } finally { lock.releaseLock(); }
  var done = '已寫入履歷公開區：\n問：' + draft.question + '\n答：' + draft.answer;
  try {
    var result = syncKnowledgeBase_();
    if (result.status === 'ok' || result.status === 'unchanged') return textMessage_(done + '\n\n✅ 知識庫已同步，訪客現在可以查到這個答案。');
    return textMessage_(done + '\n\n⚠️ 同步尚未完成（' + result.status + '），請稍後在 GAS 執行 syncKnowledgeBase。');
  } catch (error) {
    safeLog_(errorCode_(error));
    return textMessage_(done + '\n\n⚠️ 同步失敗（' + errorCode_(error) + '），文件已保存。請稍後在 GAS 執行 syncKnowledgeBase。');
  }
}
