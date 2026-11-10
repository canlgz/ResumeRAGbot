/**
 * 【中英雙語問答與介面】v3 候選功能
 * 加好友時先選語言；首頁、主題按鈕、說明與回答都依語言顯示，隨時可從 Quick Reply 切換。
 * 履歷原文維持中文，英文回答的引用仍逐字核對中文原文。
 * 語言偏好只存在雜湊快取鍵下約 6 小時，不保存原始 userId 或訊息內容。
 */

var LANGUAGE_PREFERENCE_SECONDS_ = 21600;
// 本次事件使用的語言；每個事件開始時由入口設定，供 Quick Reply 與首頁使用。
var MESSAGE_LANGUAGE_ = 'zh';
var TOPIC_CATEGORY_EN_ = { '專案': 'Project', '技能': 'Skill', '作品': 'Work', '經歷': 'Experience', '證照': 'Certificate' };

/** 以專案 ID 與訪客 userId 的雜湊產生語言偏好鍵，與對話記憶分開。 */
function languageKey_(userId) { return 'language:' + sha256_(ScriptApp.getScriptId() + ':' + userId); }

/**
 * 「English」「英文模式」或按鈕 lang:en 切換為英文；「中文」「中文模式」或 lang:zh 切回中文。
 * 回傳 null 表示這則訊息不是切換指令。
 */
function languageCommand_(text) {
  if (/^(?:lang:en|english(?:\s+mode)?|英文(?:模式)?|switch to english)$/i.test(text)) return 'en';
  if (/^(?:lang:zh|中文(?:模式)?|chinese(?:\s+mode)?|繁體中文|switch to chinese)$/i.test(text)) return 'zh';
  return null;
}

/**
 * 只依可觀察的文字判斷：含中日韓文字為中文；沒有中文、且至少有三個英文字母的句子為英文。
 * 按鈕 postback、純數字或表情無法判斷時回傳 null，改用訪客先前的偏好。
 */
function detectLanguage_(text) {
  text = String(text || '');
  if (/^(?:topic|work|nav|contact|invite|evidence|hr|lang|fill):/i.test(text)) return null;
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
 * 手打英文會記住英文偏好，之後點主題按鈕仍用英文回答；
 * 手打中文只讓這一題用中文，不清除偏好，要切回中文請按「中文」或輸入「中文」。
 */
function visitorLanguage_(text, userId, isButton) {
  var detected = isButton ? null : detectLanguage_(text);
  if (!detected) return readLanguagePreference_(userId);
  if (detected === 'en' && readLanguagePreference_(userId) !== 'en') saveLanguagePreference_(userId, 'en');
  return detected;
}

/** 介面文字只在這裡集中管理，方便之後增加其他語言。 */
function ui_(key) {
  var en = MESSAGE_LANGUAGE_ === 'en';
  var strings = {
    switched: en ? 'English mode is on. Ask me anything about this resume in English. Replies are generated from the Chinese resume, and sources keep the original section names. Tap 「中文」 below to switch back anytime.' :
      '已切換為中文。點下方「English」可隨時改用英文。',
    roleFallback: en ? 'Welcome! Get to know my experience and work.' : '歡迎認識我的經歷與作品',
    noContact: en ? 'No public contact information yet' : '尚未提供公開聯繫方式',
    traitsTitle: en ? 'How I work' : '一起工作時的我',
    traitsFallback: en ? 'Start with my experience and work to get to know me.' : '可以先從經歷與作品認識我。',
    navTitle: en ? 'Start here' : '從這裡開始',
    navSubtitle: en ? 'Meet me first, then explore what interests you.' : '先認識我，再探索你感興趣的領域。',
    card1: en ? 'HELLO / ABOUT ME' : 'HELLO / 認識我', card2: en ? 'ABOUT / TRAITS' : 'ABOUT / 個人特質',
    card3: en ? 'EXPLORE / RESUME' : 'EXPLORE / 履歷導覽', altSuffix: en ? '｜About・Traits・Resume guide' : '｜認識我・個人特質・履歷導覽',
    contact: en ? 'Contact me' : '聯繫本人', home: en ? 'Home' : '回首頁', homeText: en ? 'Home' : '首頁',
    hello: en ? 'Hi! Start with "About me" or "Quick overview", or ask anything about my experience and work.' :
      '你好！可以從「我是誰」或「快速一覽」開始，也能直接問你感興趣的經歷與作品。',
    thanks: en ? 'Thanks for chatting! Feel free to keep asking anytime.' : '謝謝你的交流！有想深入了解的部分，隨時可以繼續問。',
    reset: en ? 'Short-term memory cleared. You can start a new question now.' : '短期對話記憶已清除，現在可以開始新的問題。',
    askText: en ? 'Please type a question, or tap a resume topic below.' : '請輸入文字問題，或點選下方的履歷主題。',
    tooLong: en ? 'Please keep your question under 800 characters, or ask about different experiences separately.' :
      '請將問題縮短至 800 字以內；你也可以分開詢問不同的經歷或專案。'
  };
  return strings[key];
}

/** 主題按鈕的顯示名稱：基本入口固定翻譯；適性主題使用同步時產生的英文名稱，沒有時維持中文。 */
function topicLabel_(topic) {
  if (MESSAGE_LANGUAGE_ !== 'en') return topic.label;
  if (topic.kind === 'intro') return 'About me';
  if (topic.kind === 'overview') return 'Quick overview';
  if (topic.labelEn && TOPIC_CATEGORY_EN_[topic.category]) return Array.from(TOPIC_CATEGORY_EN_[topic.category] + ': ' + topic.labelEn).slice(0, 20).join('');
  return topic.label;
}

/** 加好友時的第一則訊息：先選語言，再顯示對應語言的首頁。 */
function languagePickerMessage_(cfg) {
  function button(label, data) {
    return { type: 'button', style: data === 'lang:zh' ? 'primary' : 'secondary', color: data === 'lang:zh' ? '#23735B' : undefined, height: 'sm',
      action: { type: 'postback', label: label, data: data, displayText: label } };
  }
  var zh = button('中文', 'lang:zh'), en = button('English', 'lang:en');
  delete en.color;
  return { type: 'flex', altText: '請選擇語言 / Please choose a language', quickReply: { items: [
    { type: 'action', action: { type: 'postback', label: '中文', data: 'lang:zh', displayText: '中文' } },
    { type: 'action', action: { type: 'postback', label: 'English', data: 'lang:en', displayText: 'English' } }
  ] }, contents: { type: 'bubble', size: 'kilo', body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px', contents: [
    { type: 'text', text: Array.from(cfg.name).slice(0, 24).join(''), weight: 'bold', size: 'lg', color: '#143D35', wrap: true },
    { type: 'text', text: '請選擇語言\nPlease choose a language', size: 'sm', color: '#53635E', wrap: true },
    { type: 'text', text: '之後可隨時從下方按鈕切換。\nYou can switch anytime later.', size: 'xxs', color: '#8A9690', wrap: true }
  ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [zh, en] } } };
}

/** 依語言回傳來源標籤；章節名稱維持履歷原文，方便對照。 */
function sourceLabel_(language) { return language === 'en' ? 'Sources: ' : '資料來源：'; }
