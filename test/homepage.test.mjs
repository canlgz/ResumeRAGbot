import test from 'node:test';
import assert from 'node:assert/strict';
import {createGas,event,assertFlexSane} from './harness.mjs';
import {portfolioFixture,paragraph,picture} from './portfolio-fixture.mjs';

function withProfile(){
  const f=portfolioFixture();
  f.nodes.splice(9,0,paragraph('姓名：陳沐言。職務：AI 工程師。個性：隨和、好相處。工作時先做小範圍原型。Email：muyan.chen@example.invalid。'),
    paragraph('學校：青禾應用大學。具備四年三個月的經驗。工作偏好：台北或新北地區。主要使用 Python、SQL。'));
  f.gas.syncKnowledgeBase();
  const idx=f.gas.loadIndex_(f.gas.config_());
  idx.quickTopics.homeProfile={version:3,name:'陳沐言',role:'AI 工程師',traits:['隨和、好相處','先做小範圍原型'],contacts:['muyan.chen@example.invalid'],
    school:'青禾應用大學',years:'四年三個月',skills:['Python','SQL'],tags:{personality:'隨和',region:'台北或新北',specialty:'Python'}};
  f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).content=JSON.stringify(idx);
  return f;
}

test('the home page is one business card built only from current public facts, with the explore entry and quick replies, without AI calls',()=>{
  const f=withProfile(),before=f.state.calls.length;
  const idx=f.gas.loadIndex_(f.gas.config_());idx.quickTopics.homeProfile.contacts=['Email：muyan.chen@example.invalid。'];
  f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).content=JSON.stringify(idx);
  f.gas.handleEvent_(event('首頁','home'),f.gas.config_());
  const calls=f.state.calls.slice(before),messages=calls.find(c=>c.url.endsWith('/message/reply')).body.messages;
  assert.equal(messages.length,1,'homepage should not add an oversized greeting sticker');
  const home=messages[0],json=JSON.stringify(home);assertFlexSane(messages);assert.equal(home.contents.type,'bubble');assert.equal(home.contents.size,'mega');
  for(const text of ['陳沐言','AI 工程師','青禾應用大學','"text":"muyan.chen@example.invalid"','四年三個月','隨和','台北或新北','Python'])assert(json.includes(text),text);
  assert.equal(home.contents.footer.contents[0].action.data,'nav:explore');assert.equal(home.contents.footer.contents[0].contents[0].text,'想了解這個人');
  assert.deepEqual([...home.quickReply.items.map(i=>i.action.label)],['名片','個人特質','專業技能','工作經歷','專案','其他','貼職缺比對']);
  assert(!calls.some(c=>c.url.includes('generativelanguage')));
});

test('the explore menu lists five entries with icon images and hints from the resume, and each entry routes to resume Q&A',()=>{
  const f=withProfile(),cfg=f.gas.config_(),before=f.state.calls.length;
  f.gas.handleEvent_({...event('','explore'),type:'postback',postback:{data:'nav:explore'}},cfg);
  const calls=f.state.calls.slice(before),menu=calls.find(c=>c.url.endsWith('/message/reply')).body.messages[0];assertFlexSane(menu);
  const rows=menu.contents.body.contents.filter(r=>r.type==='box');
  assert.deepEqual(rows.map(r=>r.action.data),['個人特質','專業技能','工作經歷','專案作品','其他']);
  assert.deepEqual(rows.map(r=>r.contents[0].contents[0].url),['traits','skills','experience','projects','more'].map(n=>cfg.iconBaseUrl+n+'.png'));
  assert.match(JSON.stringify(rows[0]),/隨和、好相處/);assert(!JSON.stringify(rows[3]).includes('：'),'project hints must not carry the category prefix');assert.match(JSON.stringify(rows[1]),/Python、SQL/);assert.match(JSON.stringify(rows[2]),/四年三個月/);
  assert.equal(menu.contents.footer.contents[0].action.data,'nav:home');
  assert(!calls.some(c=>c.url.includes('generativelanguage')));
  const start=f.state.calls.length;f.gas.handleEvent_({...event('','explore-2'),type:'postback',postback:{data:'個人特質'}},cfg);
  assert(f.state.calls.slice(start).some(c=>c.url.endsWith(':generateContent')),'entries should run the resume Q&A');
});

test('business card fields are only accepted when they are literal public text and the personality tag is never inferred',()=>{
  const {gas}=createGas();
  const p=gas.validateHomeProfile_({school:'假的大學',years:'四年三個月',skills:['Python','不存在的工具'],tags:{personality:'積極熱情',region:'台北或新北',specialty:'自動化'}},
    [{text:'學校：青禾應用大學。\n具備四年三個月的經驗。\n工作偏好：台北或新北地區。\n擅長 Python 與自動化。'},{imageKey:'ocr',text:'積極熱情 假的大學'}]);
  assert.equal(p.version,3);assert.equal(p.school,'青禾應用大學');assert.equal(p.years,'四年三個月');assert.deepEqual([...p.skills],['Python']);
  assert.deepEqual({...p.tags},{personality:'',region:'台北或新北',specialty:'自動化'});
  const q=gas.validateHomeProfile_({skills:['Python']},[{text:'個性：隨和、好相處。\n學歷：國立測試大學 資訊系，學士。\n工作偏好：台北或新北地區，可接受混合辦公。\n主要使用 Python。'}]);
  assert.equal(q.tags.personality,'隨和、好相處');assert.equal(q.school,'國立測試大學 資訊系，學士');
  assert.equal(q.tags.region,'台北或新北');assert.equal(q.tags.specialty,'Python');
});

test('homepage does not repeat deleted data or extract traits from OCR',()=>{
  const f=withProfile(),idx=f.gas.loadIndex_(f.gas.config_());
  const home=f.gas.welcomeMessage_(f.gas.config_(),{index:idx,source:{fingerprint:'changed'}});
  assert(!JSON.stringify(home).includes('陳沐言'));assert(!JSON.stringify(home).includes('muyan.chen'));assert(!JSON.stringify(home).includes('青禾'));
  const profile=f.gas.validateHomeProfile_({name:'假的姓名',traits:['看起來很有耐心'],contacts:['private@example.com']},[{text:'姓名：公開名稱。'},{imageKey:'ocr',text:'看起來很有耐心 private@example.com'}]);
  assert.equal(profile.name,'');assert.equal(profile.traits.length,0);assert.equal(profile.contacts.length,0);
});

test('portrait and portfolio stay separate and withdrawing the public portrait removes it from new homepages',()=>{
  const f=withProfile();f.nodes.splice(9,0,paragraph('個人肖像','HEADING_1'),paragraph(picture('portrait')));
  f.gas.syncKnowledgeBase();const cfg=f.gas.config_(),source=f.gas.readPublicSource_(cfg),idx=f.gas.loadIndex_(cfg);
  const portrait=idx.imageSources.find(i=>i.section.includes('個人肖像')),digest=source.images[portrait.imageKey].digest;
  assert.equal(f.gas.portfolioEntries_(idx,source,cfg,null,'portrait').length,1);
  assert.equal(f.gas.portfolioEntries_(idx,source,cfg,null,'portrait').length,1);
  assert(!f.gas.portfolioEntries_(idx,source,cfg).some(i=>i.imageKey===portrait.imageKey));
  const home=f.gas.welcomeMessage_(cfg,{index:idx,source});assert.match(JSON.stringify(home),/drive.google.com\/thumbnail/);
  f.gas.setPortfolioImageSharing(f.token,digest,false);
  assert(!JSON.stringify(f.gas.welcomeMessage_(cfg,{index:idx,source})).includes('drive.google.com/thumbnail'));
});

test('upgrading only home metadata reuses vectors and OCR, then unchanged sync makes no AI calls',()=>{
  const f=withProfile(),id=f.state.properties.get('INDEX_FILE_ID'),idx=f.gas.loadIndex_(f.gas.config_());
  delete idx.quickTopics.homeProfile;f.state.files.get(id).content=JSON.stringify(idx);
  let before=f.state.calls.length;f.gas.syncKnowledgeBase();
  let calls=f.state.calls.slice(before);assert.equal(calls.filter(c=>c.url.endsWith(':generateContent')).length,1);
  assert(!calls.some(c=>c.url.endsWith(':batchEmbedContents')||c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)));
  assert.equal(f.state.properties.get('INDEX_FILE_ID'),id);
  before=f.state.calls.length;f.gas.syncKnowledgeBase();assert(!f.state.calls.slice(before).some(c=>c.url.includes('generativelanguage')));
});

test('a malformed portrait recognition retries once while a valid no-letter description remains searchable',()=>{
  const {gas,state}=createGas();let calls=0;
  state.response=()=>({body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(++calls===1?{status:'no_text',text:'',visualDescription:'可見墨綠色外套。'}:{status:'readable',text:'',visualDescription:'可見墨綠色外套。'})}]}}]}});
  const result=gas.recognizeImageText_({mimeType:'image/png',blob:{getBytes:()=>[1,2,3]}},gas.config_());
  assert.equal(calls,2);assert.equal(result.transcription,'');assert.match(result.text,/墨綠色外套/);
  calls=0;state.response=()=>{calls++;return {body:{candidates:[{finishReason:'STOP',content:{parts:[{text:'invalid'}]}}]}}};
  assert.throws(()=>gas.recognizeImageText_({mimeType:'image/png',blob:{getBytes:()=>[1]}},gas.config_()),/IMAGE_TEXT_INVALID/);assert.equal(calls,2);
});

test('short literal working-style phrases fill missing traits without duplicating personality or inventing facts',()=>{
 const {gas}=createGas();const p=gas.validateHomeProfile_({traits:['隨和、好相處。','不存在的積極熱情']},[{text:'個性：隨和、好相處。\n擅長的工作：把模糊需求整理成可測試的流程，將重複作業自動化，並用明確的前後數據說明工具成效。\n專案習慣：先做小範圍原型，再與使用者確認流程；保留異常處理。'}]);
 assert.deepEqual([...p.traits],['隨和、好相處。','把模糊需求整理成可測試的流程','先做小範圍原型，再與使用者確認流程']);
});

test('missing portrait uses a self-contained geometric person and never changes the document or uploads an image',()=>{
 const f=withProfile(),writes=f.state.documentWrites,before=f.state.calls.length;
 f.gas.handleEvent_(event('首頁','no-portrait'),f.gas.config_());
 const calls=f.state.calls.slice(before),home=calls.find(c=>c.url.endsWith('/message/reply')).body.messages[0];
 const avatar=home.contents.body.contents[0].contents[0];
 assert.deepEqual(JSON.parse(JSON.stringify(avatar)),JSON.parse(JSON.stringify(f.gas.friendlyAvatar_())));
 assert(!JSON.stringify(avatar).includes('url'));assert(!JSON.stringify(avatar).includes('text'));
 assert.equal(f.state.documentWrites,writes);assert(!calls.some(c=>c.url.includes('generativelanguage')||c.url.includes('/content')));
});

test('home aliases and the menu back link can reopen the business card repeatedly after an existing conversation',()=>{
 const f=withProfile(),idx=f.gas.loadIndex_(f.gas.config_());
 f.gas.saveConversation_('user-1',idx.fingerprint,{question:'先前詢問的作品',focus:idx.imageSources[0].imageKey},[idx.imageSources[0].imageKey],Date.now());
 const cases=['首頁','選單','回首頁','履歷首頁','名片','home','menu','nav:home'];
 for(const [i,label] of cases.entries()){
  const before=f.state.calls.length;
  const e=label==='nav:home'?{...event('',String(i)),type:'postback',postback:{data:label}}:event(label,String(i));
  f.gas.handleEvent_(e,f.gas.config_());
  const calls=f.state.calls.slice(before),home=calls.find(c=>c.url.endsWith('/message/reply')).body.messages[0];
  assert.equal(home.contents.type,'bubble');assert.equal(home.contents.footer.contents[0].action.data,'nav:explore');
  assert(!calls.some(c=>c.url.includes('generativelanguage')));
 }
 assert.equal(f.state.documentWrites,0);
});

test('a portrait in 個人介紹 is recognized and published during sync without changing the Doc',()=>{
 const f=withProfile(),prior=f.state.response;
 f.state.response=call=>call.body?.contents?.[0]?.parts?.some(p=>p.inlineData)?{body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({status:'readable',text:'',visualDescription:'畫面顯示人物的臉部，背景為純色。'})}]}}]}}:prior(call);
 f.nodes.splice(9,0,paragraph('個人介紹','HEADING_1'),paragraph(picture('new-profile')));
 const writes=f.state.documentWrites,result=f.gas.syncKnowledgeBase(),cfg=f.gas.config_(),index=f.gas.loadIndex_(cfg),source=f.gas.readPublicSource_(cfg);
 assert.equal(result.portraitPreview.status,'ready');assert.equal(f.state.documentWrites,writes);
 const portraits=f.gas.portfolioEntries_(index,source,cfg,null,'portrait');assert.equal(portraits.length,1);assert.match(portraits[0].section,/個人介紹/);
 assert(!f.gas.portfolioEntries_(index,source,cfg).some(i=>i.imageKey===portraits[0].imageKey));
 const assets=[...f.state.files.values()].filter(file=>file.description?.startsWith('ResumeRAGbot:')).length;
 f.gas.syncKnowledgeBase();assert.equal([...f.state.files.values()].filter(file=>file.description?.startsWith('ResumeRAGbot:')).length,assets);
 f.gas.setPortfolioImageSharing(f.token,portraits[0].digest,false);assert.equal(f.gas.syncKnowledgeBase().portraitPreview.status,'private');
 assert.equal(f.gas.portfolioEntries_(index,source,cfg,null,'portrait').length,0);
});

test('a chart in the introduction and a portrait artwork are not used as the owner portrait',()=>{
 const {gas}=createGas();const index={imageTexts:{chart:{visualDescription:'畫面顯示折線圖與數字。'},art:{visualDescription:'一張人物肖像畫。'}}};
 assert.equal(gas.isPortraitSource_({section:'個人介紹',imageKey:'chart'},index),false);
 assert.equal(gas.isPortraitSource_({section:'作品：肖像畫',imageKey:'art'},index),false);
 assert.equal(gas.isPortraitSource_({section:'個人肖像｜圖片 1（圖片辨識）',imageKey:'art'},index),true);
});
