import test from 'node:test';
import assert from 'node:assert/strict';
import {createGas,event} from './harness.mjs';
import {portfolioFixture,paragraph,picture} from './portfolio-fixture.mjs';

function withProfile(){
  const f=portfolioFixture();
  f.nodes.splice(9,0,paragraph('姓名：陳沐言。職務：AI 工程師。個性：隨和、好相處。工作時先做小範圍原型。Email：muyan.chen@example.invalid。'));
  f.gas.syncKnowledgeBase();
  const idx=f.gas.loadIndex_(f.gas.config_());
  idx.quickTopics.homeProfile={version:1,name:'陳沐言',role:'AI 工程師',traits:['隨和、好相處','先做小範圍原型'],contacts:['muyan.chen@example.invalid']};
  f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).content=JSON.stringify(idx);
  return f;
}

test('three compact home pages use only current public facts and match every quick reply without AI calls',()=>{
  const f=withProfile(),before=f.state.calls.length;
  f.gas.handleEvent_(event('首頁','home'),f.gas.config_());
  const calls=f.state.calls.slice(before),messages=calls.find(c=>c.url.endsWith('/message/reply')).body.messages;
  assert.equal(messages.length,1,'homepage should not add an oversized greeting sticker');
  const home=messages[0];assert.equal(home.contents.type,'carousel');assert.equal(home.contents.contents.length,3);
  assert(home.contents.contents.every(c=>c.size==='kilo'));
  assert.match(JSON.stringify(home.contents.contents[0]),/陳沐言/);assert.match(JSON.stringify(home.contents.contents[0]),/muyan.chen@example.invalid/);
  assert.match(JSON.stringify(home.contents.contents[1]),/先做小範圍原型/);
  assert.deepEqual(home.contents.contents[2].body.contents.slice(2).flatMap(r=>r.contents.map(c=>c.action)),home.quickReply.items.map(i=>i.action));
  assert(!calls.some(c=>c.url.includes('generativelanguage')));
});

test('homepage does not repeat deleted data or extract traits from OCR',()=>{
  const f=withProfile(),idx=f.gas.loadIndex_(f.gas.config_());
  const home=f.gas.welcomeMessage_(f.gas.config_(),{index:idx,source:{fingerprint:'changed'}});
  assert(!JSON.stringify(home).includes('陳沐言'));assert(!JSON.stringify(home).includes('muyan.chen'));
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
 const avatar=home.contents.contents[0].body.contents[0];
 assert.deepEqual(JSON.parse(JSON.stringify(avatar)),JSON.parse(JSON.stringify(f.gas.friendlyAvatar_())));
 assert(!JSON.stringify(avatar).includes('url'));assert(!JSON.stringify(avatar).includes('text'));
 assert.equal(f.state.documentWrites,writes);assert(!calls.some(c=>c.url.includes('generativelanguage')||c.url.includes('/content')));
});

test('home aliases and the persistent card button can reopen all three cards repeatedly after an existing conversation',()=>{
 const f=withProfile(),idx=f.gas.loadIndex_(f.gas.config_());
 f.gas.saveConversation_('user-1',idx.fingerprint,{question:'先前詢問的作品',focus:idx.imageSources[0].imageKey},[idx.imageSources[0].imageKey],Date.now());
 const cases=['首頁','選單','回首頁','履歷首頁','home','menu','nav:home'];
 for(const [i,label] of cases.entries()){
  const before=f.state.calls.length;
  const e=label==='nav:home'?{...event('',String(i)),type:'postback',postback:{data:label}}:event(label,String(i));
  f.gas.handleEvent_(e,f.gas.config_());
  const calls=f.state.calls.slice(before),home=calls.find(c=>c.url.endsWith('/message/reply')).body.messages[0];
  assert.equal(home.contents.contents.length,3);assert.equal(home.contents.contents[2].footer.contents[0].action.data,'nav:home');
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
