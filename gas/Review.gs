/**
 * 【圖片校對管理頁的伺服器功能】
 * openImageReview 必須由主人在 GAS 執行，產生 20 分鐘有效的專用連結。
 * 管理頁雖能匿名開啟，每次讀圖與寫入都必須通過限時憑證驗證。
 * 憑證只在連結 # 後傳給頁面，Drive 僅存雜湊，不把 API Key 交給瀏覽器。
 */

/**
 * 【主人管理】在編輯器執行，取得 20 分鐘有效的圖片校對連結。
 * 版本與時間參數避免瀏覽器沿用舊頁面；真正管理憑證只放在 # 後。
 */
function openImageReview() {
  requireOwner_();
  var cfg = config_(), url = publicWebAppUrl_(), token = sha256_(Utilities.getUuid() + Utilities.getUuid());
  var expiresAt = Date.now() + 20 * 60 * 1000;
  updatePortfolioStore_(cfg, function (store) {
    Object.keys(store.sessions).forEach(function (key) {
      if (!store.sessions[key] || store.sessions[key].expiresAt <= Date.now()) delete store.sessions[key];
    });
    // 最多保留最近三個管理連結；不在原始碼或屬性放永久管理密鑰。
    var keys = Object.keys(store.sessions).sort(function (a, b) { return store.sessions[a].expiresAt - store.sessions[b].expiresAt; });
    while (keys.length >= 3) delete store.sessions[keys.shift()];
    store.sessions[sha256_(token)] = { expiresAt: expiresAt };
  });
  var result = { url: url + '?view=review&v=' + appVersion_() + '&t=' + Date.now() + '#' + token, expiresAt: expiresAt };
  console.log('圖片校對介面（20 分鐘有效，連結僅供本人使用）：' + result.url);
  return result;
}

/**
 * 每個校對 RPC 都核對隨機憑證的雜湊與到期時間，過期立即拒絕。
 */
function requireReviewSession_(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('REVIEW_SESSION_EXPIRED');
  var cfg = config_(), store = loadPortfolioStore_(cfg), grant = store.sessions[sha256_(token)];
  if (!grant || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new Error('REVIEW_SESSION_EXPIRED');
  return cfg;
}

/**
 * 共用管理驗證與錯誤整理，瀏覽器只收到安全錯誤碼。
 */
function reviewRpc_(token, action) {
  try { return action(requireReviewSession_(token)); }
  catch (error) { throw new Error(errorCode_(error)); }
}

/**
 * 取得可校對的公開圖片與辨識文字，不回傳 API Key、私人圖片或向量。
 */
function getImageReviewData(token) {
  return reviewRpc_(token, function (cfg) {
    var source = readPublicSource_(cfg), store = loadPortfolioStore_(cfg), index = null;
    try { index = loadIndex_(cfg); } catch (_) {}
    reconcilePortfolioAssets_(source, cfg);
    store = loadPortfolioStore_(cfg);
    var entries = sourceImagesByDigest_(source);
    return { version: appVersion_(), fingerprint: source.fingerprint, reviewRevision: store.reviewRevision,
      indexReady: Boolean(index && index.fingerprint === source.fingerprint),
      topics: index && index.fingerprint === source.fingerprint && index.quickTopics ? index.quickTopics.topics : [],
      topicStatus: index && index.fingerprint === source.fingerprint && index.quickTopics ? index.quickTopics.status : 'needs_sync',
      expiresAt: store.sessions[sha256_(token)].expiresAt,
      images: Object.keys(entries).map(function (digest) {
        var entry = entries[digest], raw = index && (index.imageTexts || {})[entry.imageKey];
        var correction = store.corrections[digest], effective = correction || raw || {};
        var asset = store.assets[digest];
        return { digest: digest, title: portfolioTitle_(entry.section), section: entry.section,
          reviewed: Boolean(correction || (store.confirmations[digest] && raw &&
            store.confirmations[digest].imageKey === entry.imageKey && store.confirmations[digest].textHash === sha256_(raw.text))), recognized: Boolean(raw),
          transcription: typeof effective.transcription === 'string' ? effective.transcription : raw && !correction ? raw.text : '',
          visualDescription: effective.visualDescription || '',
          originalTranscription: raw ? (typeof raw.transcription === 'string' ? raw.transcription : raw.text) : '',
          originalVisualDescription: raw && raw.visualDescription || '',
          sharing: asset && asset.enabled ? 'public' : asset && asset.state || 'private',
          publicCopyUrl: asset && asset.viewUrl || null };
      }) };
  });
}

/**
 * 經管理驗證後，以資料網址回傳指定公開原圖，不須公開原文件。
 */
function getImageReviewImage(token, digest) {
  return reviewRpc_(token, function (cfg) {
    if (!/^[a-f0-9]{64}$/.test(String(digest))) throw new Error('REVIEW_INVALID_INPUT');
    var entry = sourceImagesByDigest_(readPublicSource_(cfg))[String(digest)];
    if (!entry) throw new Error('REVIEW_IMAGE_NOT_PUBLIC');
    return { digest: digest, dataUrl: 'data:' + entry.image.mimeType + ';base64,' + Utilities.base64Encode(entry.image.blob.getBytes()) };
  });
}

/**
 * 用 reviewRevision 避免舊頁覆蓋新校正，再保存並同步知識庫。
 * 原始辨識保持可還原；完全沒改的確認不耗費重做向量的配額。
 * saved=true 而 synced=false 表示校對已存，但仍要處理同步錯誤。
 */
function saveImageReview(token, digest, patch, expectedRevision) {
  return reviewRpc_(token, function (cfg) {
    requireMatchingDeployment_();
    if (!/^[a-f0-9]{64}$/.test(String(digest)) || !patch || typeof patch.reset !== 'boolean') throw new Error('REVIEW_INVALID_INPUT');
    if (!patch.reset && (typeof patch.transcription !== 'string' || typeof patch.visualDescription !== 'string' ||
        patch.transcription.length > 12000 || patch.visualDescription.length > 12000)) throw new Error('REVIEW_INVALID_INPUT');
    updatePortfolioStore_(cfg, function (store) {
      if (store.reviewRevision !== expectedRevision) throw new Error('REVIEW_CONFLICT');
      if (Number(PropertiesService.getScriptProperties().getProperty('SYNC_LEASE') || 0) > Date.now()) throw new Error('REVIEW_SYNC_BUSY');
      var entry = sourceImagesByDigest_(readPublicSource_(cfg))[digest];
      if (!entry) throw new Error('REVIEW_IMAGE_NOT_PUBLIC');
      var index = loadIndex_(cfg), raw = index && (index.imageTexts || {})[entry.imageKey];
      if (patch.reset) { delete store.corrections[digest]; delete store.confirmations[digest]; }
      else if (!store.corrections[digest] && raw && typeof raw.transcription === 'string' &&
          patch.transcription.trim() === raw.transcription && patch.visualDescription.trim() === raw.visualDescription) {
        // 只是確認原辨識正確，不應因此重做向量或換掉可用索引。
        store.confirmations[digest] = { imageKey: entry.imageKey, textHash: sha256_(raw.text), reviewedAt: new Date().toISOString() };
      } else store.corrections[digest] = { transcription: patch.transcription.trim(), visualDescription: patch.visualDescription.trim(),
        reviewedAt: new Date().toISOString() };
      store.reviewRevision++;
    });
    try {
      var result = syncKnowledgeBase_();
      return { saved: true, synced: ['ok', 'unchanged'].indexOf(result.status) >= 0, sync: result,
        error: result.status === 'already_running' ? 'REVIEW_SYNC_BUSY' : null };
    }
    catch (error) { return { saved: true, synced: false, error: errorCode_(error) }; }
  });
}

/**
 * 逐張開放或撤回獨立作品副本，不改原文件權限。
 */
function setPortfolioImageSharing(token, digest, enabled) {
  return reviewRpc_(token, function (cfg) {
    if (!/^[a-f0-9]{64}$/.test(String(digest)) || typeof enabled !== 'boolean') throw new Error('REVIEW_INVALID_INPUT');
    if (!enabled) { withdrawPortfolioImage_(digest, cfg); return { status: 'private' }; }
    var source = readPublicSource_(cfg);
    return publishPortfolioImage_(digest, source, cfg);
  });
}

/**
 * 校對頁的同步入口，經限時管理驗證後共用同一套索引流程。
 */
function syncImageReview(token) {
  return reviewRpc_(token, function () { return syncKnowledgeBase_(); });
}

/**
 * 核對正式網址版本；只在設定缺少且目前確為 /exec 時補入，不改既有值。
 */
function checkImageReviewDeployment(token) {
  return reviewRpc_(token, function () {
    var props = PropertiesService.getScriptProperties();
    if (!String(props.getProperty('WEB_APP_URL') || '').trim()) {
      var current = ScriptApp.getService().getUrl();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(current || '')) {
        throw new Error('SET_PUBLIC_WEB_APP_URL');
      }
      props.setProperty('WEB_APP_URL', current);
    }
    return deploymentVersionStatus_();
  });
}

/**
 * 撤銷這一個管理憑證，其他仍有效的主人管理頁不受影響。
 */
function closeImageReview(token) {
  return reviewRpc_(token, function (cfg) {
    updatePortfolioStore_(cfg, function (store) { delete store.sessions[sha256_(token)]; });
    return { status: 'closed' };
  });
}

/**
 * 呼叫 LINE 的訊息格式驗證 API，不發送訊息、不需要訪客 replyToken。
 */
function validatePortfolioCards(token) {
  return reviewRpc_(token, function (cfg) {
    requireValue_(cfg.lineToken, 'LINE_CHANNEL_ACCESS_TOKEN');
    var source = readPublicSource_(cfg), index = loadIndex_(cfg);
    if (!index || index.fingerprint !== source.fingerprint) throw new Error('IMAGE_PREVIEW_NEEDS_SYNC');
    setMessageTopics_(index, source);
    var entries = portfolioEntries_(index, source, cfg), message = portfolioMessage_(entries);
    if (!message) throw new Error('PORTFOLIO_NO_PUBLIC_IMAGES');
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/validate/reply', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + cfg.lineToken },
      payload: JSON.stringify({ messages: [message] }), muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) throw new Error('LINE_CARD_VALIDATION_' + response.getResponseCode());
    return { status: 'valid', images: entries.length, message: 'LINE 已接受作品卡片格式；這項檢查沒有傳送訊息。' };
  });
}
