/** 情境式介紹只使用已同步的公開索引；情境是回答角度，不是自由提問的檢索限制。 */
var CONTEXT_INTROS_ = {
  hr: { label: '人資面試', question: '請根據公開履歷，簡短介紹我明確記載的工作、實習、職務與本人職責及成果。',
    questions: ['你有哪些工作或實習經驗？', '你曾經負責哪些重要任務？', '這些經驗讓你培養了哪些能力？'] },
  project: { label: '專案合作', question: '請根據公開履歷，簡短介紹我參與的具體專案、本人負責的工作、方法與成果。',
    questions: ['你做過哪些專案？', '你曾經使用哪些技術？', '哪個專案最能代表你的能力？'] },
  personal: { label: '一般認識', question: '請根據公開履歷，簡短介紹我明確記載的私人興趣、喜好、活動或正在探索的領域。',
    questions: ['你平常有哪些興趣？', '你最近對什麼領域感興趣？', '你喜歡從事哪些活動？'] }
};

function contextIntroChunks_(kind, chunks) {
  var patterns = {
    hr: /工作經歷|實習|任職|職務|職責|工作內容|工作經驗|職涯經驗/,
    project: /專案|專題|作品|研究計畫|開發經驗|合作經驗/,
    // 興趣必須明載，不能由科系、工作或專案推斷私人生活。
    personal: /興趣|喜好|休閒|日常活動|平常喜歡|最近在探索|關注領域/
  };
  var pattern = patterns[kind];
  return pattern ? chunks.filter(function (chunk) { return pattern.test(chunk.section + '\n' + chunk.text); }) : [];
}

function contextIntroMenu_() {
  return { type: 'flex', altText: '情境式個人介紹：選擇情境', quickReply: quickReply_(), contents: {
    type: 'bubble', size: 'kilo', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      { type: 'text', text: '情境式個人介紹', weight: 'bold', size: 'lg' },
      { type: 'text', text: '選擇想了解的面向；之後也可自由提問。', wrap: true, size: 'sm' }
    ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: Object.keys(CONTEXT_INTROS_).map(function (kind) {
      return { type: 'button', style: 'link', action: { type: 'postback', label: CONTEXT_INTROS_[kind].label,
        data: 'ctx:select:' + kind, displayText: CONTEXT_INTROS_[kind].label } };
    }).concat([{ type: 'button', style: 'link', action: { type: 'postback', label: '回首頁', data: 'nav:home', displayText: '首頁' } }]) } }
  };
}

function contextIntroQuestions_(kind) {
  return { items: CONTEXT_INTROS_[kind].questions.map(function (question, i) {
    return { type: 'action', action: { type: 'postback', label: Array.from(question).slice(0, 20).join(''),
      data: 'ctx:ask:' + kind + ':' + i, displayText: question } };
  }).concat([
    { type: 'action', action: { type: 'postback', label: '切換情境', data: 'ctx:menu', displayText: '切換情境' } },
    { type: 'action', action: { type: 'postback', label: '取消介紹', data: 'ctx:cancel', displayText: '取消介紹' } },
    { type: 'action', action: { type: 'postback', label: '回首頁', data: 'nav:home', displayText: '首頁' } }
  ]) };
}

function answerContextIntro_(kind, cfg, userId, prepared) {
  var spec = CONTEXT_INTROS_[kind];
  if (!spec) return { messages: [textMessage_('介紹情境已更新，請重新選擇。')] };
  var index = prepared ? prepared.index : loadIndex_(cfg);
  if (!index) return { messages: [textMessage_('履歷資料正在準備中，請稍後再試。')] };
  var source = prepared ? prepared.source : readPublicSource_(cfg);
  if (source.fingerprint !== index.fingerprint) {
    clearConversation_(userId);
    return { messages: [textMessage_('履歷資料正在等待同步，請稍後再試。')] };
  }
  var request = { question: spec.question, contextId: kind, contextIntro: true };
  var result = answerResult_(spec.question, cfg, spec.question, request, { index: index, source: source });
  if (result.status === 'stale' || result.status === 'unavailable') return { messages: [textMessage_(result.message)] };
  var messages = result.status === 'answered' ? [textMessage_(result.answerText), textMessage_(result.source)] :
    [textMessage_('目前公開履歷沒有足夠的「' + spec.label + '」資料可供介紹。你仍可直接詢問其他公開履歷內容。')];
  messages.push(textMessage_('你可以繼續提問，也可以選擇下方的延伸問題。'));
  messages[messages.length - 1].quickReply = contextIntroQuestions_(kind);
  return { messages: messages, answerStatus: result.status, fingerprint: index.fingerprint,
    request: request, works: [], dialogueIntent: 'neutral' };
}
