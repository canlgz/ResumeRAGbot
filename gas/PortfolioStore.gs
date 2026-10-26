/**
 * 【作品管理的私有資料層】
 * 校對、確認狀態、公開副本資料與限時管理憑證，另存於主人自己的 Drive JSON。
 * 不修改原 Doc；檔案須由本人擁有，且綁定這個 GAS 專案與履歷文件。
 * corrections 用圖片像素雜湊作鍵，換圖後不會誤用上一張的校正。
 */

/**
 * 新管理檔的資料結構；原始憑證不存入檔案，只存其雜湊。
 */
function emptyPortfolioStore_(cfg) {
  return { type: 'ResumeRAGbotPortfolio', version: 1, scriptId: ScriptApp.getScriptId(), docId: cfg.docId,
    reviewRevision: 0, corrections: {}, confirmations: {}, assets: {}, sessions: {} };
}

/**
 * 依 GAS 專案與文件 ID 建立專屬名稱，避免多位學生或多份履歷混用。
 */
function portfolioStoreName_(cfg) {
  return 'ResumeRAGbot-portfolio-' + ScriptApp.getScriptId() + '-' + sha256_(cfg.docId).slice(0, 12) + '.json';
}

/**
 * 確認管理檔屬於執行者且未開放公開連結，不接受他人同名檔案。
 */
function requirePrivatePortfolioStore_(file) {
  if (String(file.getSharingAccess()) !== String(DriveApp.Access.PRIVATE)) throw new Error('PORTFOLIO_STORE_NOT_PRIVATE');
  var owner = file.getOwner();
  if (!owner || owner.getEmail() !== Session.getEffectiveUser().getEmail()) throw new Error('PORTFOLIO_STORE_OWNER');
}

/**
 * 載入專案綁定的管理檔；改用另一份 Doc 時使用另一份管理資料。
 */
function loadPortfolioStore_(cfg) {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('PORTFOLIO_STORE_FILE_ID'), file = null;
  if (id) {
    try { file = DriveApp.getFileById(id); } catch (_) { throw new Error('PORTFOLIO_STORE_UNAVAILABLE'); }
    if (file.isTrashed()) throw new Error('PORTFOLIO_STORE_UNAVAILABLE');
  } else {
    // 也可讀取主人匯入、由本人擁有且綁定本專案的私有管理檔。
    var matches = DriveApp.getFilesByName(portfolioStoreName_(cfg));
    if (matches.hasNext()) {
      file = matches.next();
      if (matches.hasNext()) throw new Error('PORTFOLIO_STORE_AMBIGUOUS');
    }
  }
  if (!file) return emptyPortfolioStore_(cfg);
  requirePrivatePortfolioStore_(file);
  var value;
  try { value = JSON.parse(file.getBlob().getDataAsString('UTF-8')); } catch (_) { throw new Error('PORTFOLIO_STORE_INVALID'); }
  if (value && value.scriptId === ScriptApp.getScriptId() && value.docId !== cfg.docId) {
    // 改用另一份履歷時另開管理資料，不覆蓋舊文件的校正與分享設定。
    var candidates = DriveApp.getFilesByName(portfolioStoreName_(cfg));
    if (!candidates.hasNext()) return emptyPortfolioStore_(cfg);
    file = candidates.next();
    if (candidates.hasNext()) throw new Error('PORTFOLIO_STORE_AMBIGUOUS');
    requirePrivatePortfolioStore_(file);
    try { value = JSON.parse(file.getBlob().getDataAsString('UTF-8')); } catch (_) { throw new Error('PORTFOLIO_STORE_INVALID'); }
  }
  if (!value || value.type !== 'ResumeRAGbotPortfolio' || value.version !== 1 ||
      value.scriptId !== ScriptApp.getScriptId() || value.docId !== cfg.docId ||
      !Number.isSafeInteger(value.reviewRevision) || value.reviewRevision < 0 ||
      !['corrections', 'assets', 'sessions'].every(function (key) {
        return value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]);
      }) || (value.confirmations && (typeof value.confirmations !== 'object' || Array.isArray(value.confirmations)))) {
    throw new Error('PORTFOLIO_STORE_INVALID');
  }
  if (!id || id !== file.getId()) props.setProperty('PORTFOLIO_STORE_FILE_ID', file.getId());
  if (!value.confirmations) value.confirmations = {};
  Object.defineProperty(value, '_fileId', { value: file.getId(), enumerable: false });
  return value;
}

/**
 * 以指令碼鎖序列化管理資料變更，避免校對與分享狀態互相覆蓋。
 */
function updatePortfolioStore_(cfg, change) {
  var lock = LockService.getScriptLock(); lock.waitLock(5000);
  try {
    var value = loadPortfolioStore_(cfg), result = change(value);
    savePortfolioStore_(value, cfg);
    return result;
  } finally { lock.releaseLock(); }
}

/** 呼叫者須已取得指令碼鎖；保存私有管理資料，不把訪客內容寫進 Doc。 */
function savePortfolioStore_(value, cfg) {
  var props = PropertiesService.getScriptProperties(), id = value._fileId;
  if (id) DriveApp.getFileById(id).setContent(JSON.stringify(value));
  else {
    var file = DriveApp.createFile(portfolioStoreName_(cfg), JSON.stringify(value), 'application/json');
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    props.setProperty('PORTFOLIO_STORE_FILE_ID', file.getId());
  }
}

/**
 * 將目前公開圖片依原始像素雜湊建立查找表，相同圖片只列一次。
 */
function sourceImagesByDigest_(source) {
  var result = {};
  source.chunks.forEach(function (chunk) {
    if (!chunk.imageKey) return;
    var image = source.images[chunk.imageKey];
    if (!result[image.digest]) result[image.digest] = { image: image, imageKey: chunk.imageKey,
      section: chunk.section, tabId: chunk.tabId };
  });
  return result;
}

/**
 * 只挑出目前公開圖片對應的校正，已移除圖片不會混回指紋。
 */
function selectedImageCorrections_(images, cfg) {
  if (!Object.keys(images).length) return {};
  var store = loadPortfolioStore_(cfg), selected = {};
  Object.keys(images).forEach(function (key) {
    var digest = images[key].digest, correction = store.corrections[digest];
    if (correction) {
      if (typeof correction.transcription !== 'string' || typeof correction.visualDescription !== 'string') {
        throw new Error('PORTFOLIO_STORE_INVALID');
      }
      selected[digest] = { transcription: correction.transcription, visualDescription: correction.visualDescription };
    }
  });
  return selected;
}

/**
 * 有主人校正時套用校正，否則沿用 AI 原始辨識。
 */
function effectiveImageText_(raw, correction) {
  if (!correction) return raw;
  return validateImageText_({ status: correction.transcription.trim() || correction.visualDescription.trim() ? 'readable' : 'no_text',
    text: correction.transcription, visualDescription: correction.visualDescription });
}
