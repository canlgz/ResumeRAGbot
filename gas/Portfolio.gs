/**
 * 【作品圖片副本與 LINE 圖文卡片】
 * 主人逐張同意後才建立公開副本，原 Doc、索引及管理 JSON 均不因此公開。
 * 撤回預覽會停用新卡片並將副本改回私人；已送出或快取的圖片無法收回。
 */

/**
 * 從 PNG／JPEG 檔頭取得尺寸，避免把 HTML 錯誤頁當成可顯示的圖片。
 */
function imageDimensions_(bytes, mime) {
  var b = bytes.map(function (n) { return n & 255; });
  if (mime === 'image/png' && b.length >= 24 && b.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') {
    function n(i) { return b[i] * 16777216 + b[i + 1] * 65536 + b[i + 2] * 256 + b[i + 3]; }
    return { width: n(16), height: n(20) };
  }
  if (mime === 'image/jpeg' && b[0] === 255 && b[1] === 216) {
    var i = 2, sof = [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207];
    while (i + 8 < b.length) {
      if (b[i++] !== 255) continue;
      var marker = b[i++];
      if (marker === 255 || marker === 216) continue;
      if (marker === 217 || marker === 218) break;
      var length = b[i] * 256 + b[i + 1];
      if (sof.indexOf(marker) >= 0) return { width: b[i + 5] * 256 + b[i + 6], height: b[i + 3] * 256 + b[i + 4] };
      if (length < 2) break;
      i += length;
    }
  }
  throw new Error('PORTFOLIO_IMAGE_INVALID');
}

/**
 * 建立穩定的 Drive 縮圖路徑，不保存容易過期的 thumbnailLink。
 */
function portfolioPreviewUrl_(file) {
  // 使用固定縮圖路徑；不把 Google 短期有效的 thumbnailLink 存進索引。
  var url = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(file.getId()) + '&sz=w1000-h1000';
  var resourceKey = typeof file.getResourceKey === 'function' ? file.getResourceKey() : null;
  return url + (resourceKey ? '&resourcekey=' + encodeURIComponent(resourceKey) : '');
}

/**
 * 標記這是本專案替這張圖建立的副本，後續變更權限前再次核對。
 */
function portfolioCopyMarker_(cfg, digest) {
  return 'ResumeRAGbot:' + ScriptApp.getScriptId() + ':' + sha256_(cfg.docId) + ':' + digest;
}

/**
 * 避免錯誤的檔案 ID 導致原文件或其他檔案被公開。
 */
function requirePortfolioCopy_(file, cfg, digest) {
  if (file.getId() === cfg.docId || file.getDescription() !== portfolioCopyMarker_(cfg, digest) ||
      String(file.getMimeType()).indexOf('image/') !== 0) throw new Error('PORTFOLIO_ASSET_OWNERSHIP');
}

/**
 * 實際匿名下載預覽，檢查 HTTP 狀態、格式、檔頭與 LINE 允許的尺寸。
 */
function verifyPortfolioImage_(url) {
  var response = UrlFetchApp.fetch(url, { method: 'get', followRedirects: true, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error('PORTFOLIO_IMAGE_NOT_READY');
  var blob = response.getBlob(), mime = String(blob.getContentType()).toLowerCase().split(';')[0], bytes = blob.getBytes();
  if (['image/png', 'image/jpeg'].indexOf(mime) < 0 || bytes.length > 10000000) throw new Error('PORTFOLIO_IMAGE_INVALID');
  var dimensions = imageDimensions_(bytes, mime);
  if (!dimensions.width || !dimensions.height || dimensions.width > 1024 || dimensions.height > 1024) {
    throw new Error('PORTFOLIO_IMAGE_DIMENSIONS');
  }
  return dimensions;
}

/**
 * 先停用新卡片，再將副本改回私人；撤回失敗保留可重試狀態。
 */
function withdrawPortfolioImage_(digest, cfg, reason) {
  var asset = null;
  updatePortfolioStore_(cfg, function (store) {
    asset = store.assets[digest];
    if (asset) { asset.enabled = false; asset.state = 'revoking'; asset.withdrawReason = reason || 'owner'; }
  });
  if (!asset) return;
  try {
    var file = DriveApp.getFileById(asset.fileId);
    requirePortfolioCopy_(file, cfg, digest);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  }
  catch (_) {
    updatePortfolioStore_(cfg, function (store) { store.assets[digest].state = 'revoke_failed'; });
    throw new Error('PORTFOLIO_REVOKE_FAILED');
  }
  updatePortfolioStore_(cfg, function (store) { store.assets[digest].state = 'private'; });
}

/**
 * 原圖刪除、換圖或移出公開區時，撤回對應的舊公開副本。
 */
function reconcilePortfolioAssets_(source, cfg) {
  var active = sourceImagesByDigest_(source), store = loadPortfolioStore_(cfg);
  Object.keys(store.assets).forEach(function (digest) {
    var asset = store.assets[digest];
    if (!active[digest] && (asset.enabled || asset.state === 'revoke_failed')) withdrawPortfolioImage_(digest, cfg, 'source_removed');
  });
}

/**
 * 主人同意後建立獨立副本並檢查可公開讀取，成功才啟用卡片。
 * 如果圖片準備失敗，嘗試改回私人；撤回失敗必須明確告知。
 */
function publishPortfolioImage_(digest, source, cfg) {
  var entry = sourceImagesByDigest_(source)[digest];
  if (!entry) throw new Error('REVIEW_IMAGE_NOT_PUBLIC');
  var asset = loadPortfolioStore_(cfg).assets[digest], file = null;
  if (asset && asset.fileId) {
    try { file = DriveApp.getFileById(asset.fileId); if (file.isTrashed()) file = null; } catch (_) {}
    if (file) requirePortfolioCopy_(file, cfg, digest);
  }
  if (!file) {
    var extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' }[entry.image.mimeType];
    file = DriveApp.createFile(entry.image.blob.copyBlob().setName('ResumeRAGbot-作品-' + digest.slice(0, 16) + extension));
    file.setDescription(portfolioCopyMarker_(cfg, digest));
    updatePortfolioStore_(cfg, function (store) {
      store.assets[digest] = { fileId: file.getId(), enabled: false, state: 'preparing', createdAt: new Date().toISOString() };
    });
  }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = portfolioPreviewUrl_(file), dimensions = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      try { dimensions = verifyPortfolioImage_(url); break; }
      catch (error) {
        if (attempt === 2) throw error;
        Utilities.sleep(400 * (attempt + 1));
      }
    }
    if (!sourceImagesByDigest_(readPublicSource_(cfg))[digest]) throw new Error('REVIEW_IMAGE_NOT_PUBLIC');
    updatePortfolioStore_(cfg, function (store) {
      store.assets[digest] = { fileId: file.getId(), enabled: true, state: 'public', imageUrl: url,
        viewUrl: file.getUrl(), width: dimensions.width, height: dimensions.height, publishedAt: new Date().toISOString() };
    });
    return { status: 'public' };
  } catch (error) {
    var revokeFailed = false;
    try { file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); }
    catch (_) { revokeFailed = true; safeLog_('PORTFOLIO_REVOKE_FAILED'); }
    updatePortfolioStore_(cfg, function (store) {
      var item = store.assets[digest];
      item.enabled = false; item.state = revokeFailed ? 'revoke_failed' : 'preparing'; item.error = errorCode_(error);
    });
    if (revokeFailed) throw new Error('PORTFOLIO_REVOKE_FAILED');
    throw new Error(errorCode_(error) === 'UNEXPECTED_ERROR' ? 'PORTFOLIO_PUBLISH_FAILED' : errorCode_(error));
  }
}

/**
 * 去掉系統附加的圖片編號，保留主人原本的作品／章節名稱。
 */
function portfolioTitle_(section) { return section.replace(/｜圖片 \d+（[^）]+）$/, ''); }

/**
 * 肖像可放在自然的個人介紹章節，不要求主人另外建立特定格式。
 * 明確的肖像標題直接採用；介紹章節則須有圖片辨識的人物描述，避免拿圖表當頭像。
 * 這只判斷用途，不從照片推測人物姓名或資歷。
 */
function isPortraitSource_(image, index) {
  var title = portfolioTitle_(image.section).trim();
  if (/^(?:個人肖像|個人照片|本人照片|大頭照|大頭貼|個人頭像|profile photo|portrait)(?:\s|$|[｜：:])/i.test(title)) return true;
  if (!/^(?:個人介紹|自我介紹|個人簡介|個人資料|基本資料|關於我|about me|profile)$/i.test(title)) return false;
  var description = (index.imageReviewedTexts || {})[image.imageKey] || (index.imageTexts || {})[image.imageKey] || {};
  return /人像|人物|人臉|肖像|頭像|臉部|面部|頭肩|男子|女子|男性|女性|portrait|person|face|headshot/i.test(description.visualDescription || '');
}

/**
 * 同步時替公開履歷中的肖像準備 LINE 預覽，只建立獨立圖片副本，不改 Doc。
 * 主人手動撤回的分享不能被同步自動打開；因刪圖而撤回的圖片重新插入時可恢復。
 * 預覽失敗要明確回傳狀態，但不能因此刪掉已成功建立的 RAG 索引。
 */
function prepareHomePortrait_(index, source, cfg) {
  var image = (index.imageSources || []).find(function (entry) { return isPortraitSource_(entry, index); });
  if (!image || !source.images[image.imageKey]) return { status: 'none' };
  var digest = source.images[image.imageKey].digest, asset = loadPortfolioStore_(cfg).assets[digest];
  if (asset && asset.enabled) return { status: 'ready' };
  if (asset && !asset.enabled && asset.state === 'private' && asset.withdrawReason !== 'source_removed') return { status: 'private' };
  try { publishPortfolioImage_(digest, source, cfg); return { status: 'ready' }; }
  catch (error) { safeLog_(errorCode_(error)); return { status: 'error', error: errorCode_(error) }; }
}

/**
 * 只取目前仍公開、由本專案建立且獲主人開放的作品，最多五件。
 */
function portfolioEntries_(index, source, cfg, selectedKeys, purpose) {
  var assets = loadPortfolioStore_(cfg).assets, seen = {}, entries = [];
  (index.imageSources || []).forEach(function (image) {
    // 肖像只出現在首頁，不混入作品圖庫；標題由文件主人指定，不憑圖片猜測。
    var portrait = isPortraitSource_(image, index);
    if (purpose === 'portrait' ? !portrait : portrait) return;
    if (selectedKeys && selectedKeys.indexOf(image.imageKey) < 0) return;
    var info = source.images[image.imageKey];
    if (!info || seen[info.digest]) return;
    var asset = assets[info.digest];
    if (!asset || !asset.enabled || !/^https:\/\/drive\.google\.com\/thumbnail\?/.test(asset.imageUrl || '') ||
        !/^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]+\/view(?:\?[^\s]*)?$/.test(asset.viewUrl || '')) return;
    try {
      var file = DriveApp.getFileById(asset.fileId), access = String(file.getSharingAccess());
      requirePortfolioCopy_(file, cfg, info.digest);
      if (file.isTrashed() || [String(DriveApp.Access.ANYONE_WITH_LINK), String(DriveApp.Access.ANYONE)].indexOf(access) < 0) return;
    } catch (_) { return; }
    seen[info.digest] = true;
    var effective = (index.imageReviewedTexts || {})[image.imageKey] || (index.imageTexts || {})[image.imageKey];
    entries.push({ imageKey: image.imageKey, digest: info.digest, section: image.section,
      title: portfolioTitle_(image.section), text: effective && effective.visualDescription || effective && effective.transcription || '',
      imageUrl: asset.imageUrl, viewUrl: asset.viewUrl, width: asset.width, height: asset.height });
  });
  return entries.slice(0, 5);
}

/**
 * 把作品組成 Flex 輪播卡片，附上選作品追問與查看原圖按鈕。
 */
function portfolioMessage_(entries) {
  if (!entries.length) return null;
  return { type: 'flex', altText: '作品圖庫｜' + Array.from(entries.map(function (e) { return e.title; }).join('、')).slice(0, 350).join(''),
    quickReply: quickReply_(), contents: { type: 'carousel', contents: entries.map(function (entry) {
      return { type: 'bubble', size: 'mega', hero: { type: 'image', url: entry.imageUrl, size: 'full',
        aspectMode: 'fit', aspectRatio: Math.round(Math.max(1 / 3, Math.min(3, entry.width / entry.height)) * 1000) + ':1000',
        action: { type: 'uri', label: '查看作品', uri: entry.viewUrl } },
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: Array.from(entry.title).slice(0, 70).join(''), weight: 'bold', size: 'lg', wrap: true },
          { type: 'text', text: Array.from(entry.text || '點選下方按鈕，繼續了解這件作品。').slice(0, 180).join(''), size: 'sm', wrap: true }
        ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'primary', color: '#236a50', action: { type: 'postback', label: '問這件作品',
            data: 'work:' + entry.imageKey, displayText: '請介紹「' + Array.from(entry.title).slice(0, 40).join('') + '」' } },
          { type: 'button', style: 'secondary', action: { type: 'uri', label: '查看原圖', uri: entry.viewUrl } }
        ] } };
    }) } };
}
