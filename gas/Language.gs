/**
 * 【中英雙語問答】v3 候選功能
 * 訪客用英文提問時，以英文回答；履歷原文維持中文，引用仍逐字核對中文原文。
 * 語言偏好只存在雜湊快取鍵下約 6 小時，不保存原始 userId 或訊息內容。
 */

var LANGUAGE_PREFERENCE_SECONDS_ = 21600;

/** 以專案 ID 與訪客 userId 的雜湊產生語言偏好鍵，與對話記憶分開。 */
function languageKey_(userId) { return 'language:' + sha256_(ScriptApp.getScriptId() + ':' + userId); }

/**
 * 「English」「英文模式」切換為英文；「中文」「中文模式」切回中文。
 * 回傳 null 表示這則訊息不是切換指令。
 */
function languageCommand_(text) {
  if (/^(?:english(?:\s+mode)?|英文(?:模式)?|switch to english)$/i.test(text)) return 'en';
  if (/^(?:中文(?:模式)?|chinese(?:\s+mode)?|繁體中文|switch to chinese)$/i.test(text)) return 'zh';
  return null;
}

/**
 * 只依可觀察的文字判斷：含中日韓文字為中文；沒有中文、且至少有三個英文字母的句子為英文。
 * 按鈕 postback、純數字或表情無法判斷時回傳 null，改用訪客先前的偏好。
 */
function detectLanguage_(text) {
  text = String(text || '');
  if (/^(?:topic|work|nav|contact|invite|evidence|hr):/i.test(text)) return null;
  if (/[㐀-鿿豈-﫿]/.test(text)) return 'zh';
  var letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters >= 3 ? 'en' : null;
}

/** 讀取偏好；快取失效或資料損壞時回到預設中文。 */
function readLanguagePreference_(userId) {
  try {
    var value = CacheService.getScriptCache().get(languageKey_(userId));
    return value === 'en' ? 'en' : 'zh';
  } catch (_) { return 'zh'; }
}

/** 保存偏好；快取失敗不影響回答，只是下一次改用文字判斷。 */
function saveLanguagePreference_(userId, language) {
  try {
    var cache = CacheService.getScriptCache();
    if (language === 'en') cache.put(languageKey_(userId), 'en', LANGUAGE_PREFERENCE_SECONDS_);
    else cache.remove(languageKey_(userId));
  } catch (_) { safeLog_('LANGUAGE_CACHE_UNAVAILABLE'); }
}

/**
 * 決定本輪回答語言：按鈕沿用偏好；手打的文字依內容判斷。
 * 手打英文會記住英文偏好，之後點中文主題按鈕仍用英文回答；
 * 手打中文只讓這一題用中文，不清除偏好，要切回中文請輸入「中文」。
 */
function visitorLanguage_(text, userId, isButton) {
  var detected = isButton ? null : detectLanguage_(text);
  if (!detected) return readLanguagePreference_(userId);
  if (detected === 'en' && readLanguagePreference_(userId) !== 'en') saveLanguagePreference_(userId, 'en');
  return detected;
}

/** 切換語言後的確認訊息，以切換後的語言說明。 */
function languageSwitchedText_(language) {
  return language === 'en' ?
    'English mode is on. Ask me anything about this resume in English, e.g. "What projects have you worked on?" Replies are generated from the Chinese resume, and sources keep the original section names. Type 「中文」 to switch back.' :
    '已切換為中文回答。輸入「English」可改用英文問答。';
}

/** 依語言回傳來源標籤；章節名稱維持履歷原文，方便對照。 */
function sourceLabel_(language) { return language === 'en' ? 'Sources: ' : '資料來源：'; }
