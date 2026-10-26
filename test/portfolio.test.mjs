import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioFixture, png, paragraph } from './portfolio-fixture.mjs';
import { event } from './harness.mjs';

const review=f=>f.gas.getImageReviewData(f.token);
const store=f=>f.gas.loadPortfolioStore_(f.gas.config_());
const index=f=>f.gas.loadIndex_(f.gas.config_());
const count=(f,suffix)=>f.state.calls.filter(call=>call.url.endsWith(suffix)).length;
const publish=f=>review(f).images.forEach(image=>f.gas.setPortfolioImageSharing(f.token,image.digest,true));
const json=value=>JSON.parse(JSON.stringify(value));

test('review shell is public but every data and mutation RPC requires an unexpired owner-issued session',()=>{
  const f=portfolioFixture();
  const managementUrl=new URL(f.gas.openImageReview().url);
  assert.equal(managementUrl.searchParams.get('v'),f.gas.appVersion_());
  assert.match(managementUrl.hash,/^#[a-f0-9]{64}$/);
  const shell=f.gas.doGet({parameter:{view:'review'}}).text;
  for(const secret of [f.token,'test-gemini','test-line','拾光閱讀'])assert(!shell.includes(secret));
  const digest=review(f).images[0].digest;
  const operations=token=>[
    ()=>f.gas.getImageReviewData(token),()=>f.gas.getImageReviewImage(token,digest),
    ()=>f.gas.saveImageReview(token,digest,{reset:true},0),()=>f.gas.setPortfolioImageSharing(token,digest,true),
    ()=>f.gas.testImageReviewTopic(token,'a'.repeat(16)),()=>f.gas.syncImageReview(token),()=>f.gas.validatePortfolioCards(token),()=>f.gas.checkImageReviewDeployment(token),()=>f.gas.closeImageReview(token)
  ];
  for(const token of [undefined,'','b'.repeat(64)])for(const operation of operations(token))assert.throws(operation,/REVIEW_SESSION_EXPIRED/);
  const data=review(f);assert.equal(data.images.length,2);assert.equal(f.privatePicture.reads,0);
  assert.match(f.gas.getImageReviewImage(f.token,digest).dataUrl,/^data:image\/png;base64,/);
  assert.throws(()=>f.gas.getImageReviewImage(f.token,'__proto__'),/REVIEW_INVALID_INPUT/);
  f.state.activeEmail='';assert.throws(()=>f.gas.openImageReview(),/OWNER_ONLY/);
  f.gas.updatePortfolioStore_(f.gas.config_(),s=>{s.sessions[f.gas.sha256_(f.token)].expiresAt=Date.now()-1;});
  for(const operation of operations(f.token))assert.throws(operation,/REVIEW_SESSION_EXPIRED/);
});

test('owner review deployment check preserves an existing URL and fills only a missing formal exec URL without rewriting dev',()=>{
  const f=portfolioFixture();const original=f.state.properties.get('WEB_APP_URL');
  assert.equal(f.gas.checkImageReviewDeployment(f.token).status,'ready');assert.equal(f.state.properties.get('WEB_APP_URL'),original);
  f.state.properties.delete('WEB_APP_URL');
  assert.throws(()=>f.gas.checkImageReviewDeployment(f.token),/SET_PUBLIC_WEB_APP_URL/);
  assert.equal(f.state.properties.has('WEB_APP_URL'),false);
  const formal=portfolioFixture({serviceUrl:'https://script.google.com/macros/s/own-formal/exec'});
  formal.state.properties.delete('WEB_APP_URL');formal.gas.checkImageReviewDeployment(formal.token);
  assert.equal(formal.state.properties.get('WEB_APP_URL'),'https://script.google.com/macros/s/own-formal/exec');
  const dev=portfolioFixture({serviceUrl:'https://script.google.com/macros/s/own-test/dev'});
  dev.state.properties.delete('WEB_APP_URL');assert.throws(()=>dev.gas.checkImageReviewDeployment(dev.token),/SET_PUBLIC_WEB_APP_URL/);
});

test('owner sessions are hashed, bounded and revocable; private store is project/document bound',()=>{
  const f=portfolioFixture(),cfg=f.gas.config_();
  assert(!JSON.stringify(store(f)).includes(f.token));
  for(let i=0;i<4;i++)f.gas.openImageReview();
  assert.equal(Object.keys(store(f).sessions).length,3);
  assert.throws(()=>review(f),/REVIEW_SESSION_EXPIRED/);
  const fresh=f.gas.openImageReview().url.split('#')[1];f.gas.closeImageReview(fresh);
  assert.throws(()=>f.gas.getImageReviewData(fresh),/REVIEW_SESSION_EXPIRED/);
  const originalId=f.state.properties.get('PORTFOLIO_STORE_FILE_ID');
  f.state.properties.set('RESUME_DOC_ID','different-doc');
  f.gas.updatePortfolioStore_(f.gas.config_(),s=>{s.reviewRevision=42;});
  assert.notEqual(f.state.properties.get('PORTFOLIO_STORE_FILE_ID'),originalId);
  f.state.properties.set('RESUME_DOC_ID',cfg.docId);
  assert.equal(store(f).reviewRevision,0);assert.equal(f.state.properties.get('PORTFOLIO_STORE_FILE_ID'),originalId);
  const file=f.state.files.get(originalId);file.access='ANYONE_WITH_LINK';
  assert.throws(()=>store(f),/PORTFOLIO_STORE_NOT_PRIVATE/);
  file.access='PRIVATE';file.ownerEmail='attacker@example.test';
  assert.throws(()=>store(f),/PORTFOLIO_STORE_OWNER/);file.ownerEmail='owner@example.test';
  const value=JSON.parse(file.content);value.corrections=[];file.content=JSON.stringify(value);
  assert.throws(()=>store(f),/PORTFOLIO_STORE_INVALID/);
});

test('corrections change searchable evidence without modifying the document and reset reuses raw OCR',()=>{
  const f=portfolioFixture(),before=index(f),data=review(f),image=data.images[0];
  const ocrBefore=f.state.calls.filter(c=>c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)).length;
  const result=f.gas.saveImageReview(f.token,image.digest,{reset:false,transcription:'校正作品名稱',visualDescription:'畫面呈現靛紫色導覽與四個區塊。'},data.reviewRevision);
  assert.equal(result.synced,true);assert.notEqual(index(f).fingerprint,before.fingerprint);
  assert(index(f).chunks.some(c=>c.text.includes('靛紫色')));
  assert.equal(index(f).imageTexts[Object.keys(index(f).imageTexts)[0]].transcription,'拾光閱讀');
  assert.equal(review(f).images[0].reviewed,true);
  assert.equal(f.nodes.map(n=>n.getText()).join('\n'),f.originalNodes);
  assert.equal(f.state.documentWrites,0);
  assert.equal(f.state.calls.filter(c=>c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)).length,ocrBefore);
  const reset=f.gas.saveImageReview(f.token,image.digest,{reset:true},review(f).reviewRevision);
  assert.equal(reset.synced,true);assert.equal(index(f).fingerprint,before.fingerprint);
  assert(!index(f).chunks.some(c=>c.text.includes('靛紫色')));
  assert.equal(f.state.calls.filter(c=>c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)).length,ocrBefore);
});

test('confirming unchanged recognition uses no embeddings and conflict or busy save cannot mutate a correction',()=>{
  const f=portfolioFixture(),data=review(f),image=data.images[0],fileId=f.state.properties.get('INDEX_FILE_ID');
  const before=count(f,':batchEmbedContents');
  const patch={reset:false,transcription:image.transcription,visualDescription:image.visualDescription};
  assert.equal(f.gas.saveImageReview(f.token,image.digest,patch,data.reviewRevision).synced,true);
  assert.equal(review(f).images[0].reviewed,true);assert.equal(count(f,':batchEmbedContents'),before);
  assert.equal(f.state.properties.get('INDEX_FILE_ID'),fileId);
  assert.throws(()=>f.gas.saveImageReview(f.token,image.digest,{...patch,transcription:'舊版覆蓋'},0),/REVIEW_CONFLICT/);
  f.state.properties.set('SYNC_LEASE',String(Date.now()+60000));
  assert.throws(()=>f.gas.saveImageReview(f.token,image.digest,patch,1),/REVIEW_SYNC_BUSY/);
  assert.equal(store(f).reviewRevision,1);assert.equal(Object.keys(store(f).corrections).length,0);
});

test('failed correction rebuild explicitly reports saved but not synced and never answers from stale content',()=>{
  const f=portfolioFixture(),data=review(f),response=f.state.response;
  f.state.response=call=>call.url.endsWith(':batchEmbedContents')?{status:429,body:{error:{message:'private-quota-payload'}}}:response(call);
  const result=f.gas.saveImageReview(f.token,data.images[0].digest,{reset:false,transcription:'更新',visualDescription:'校正配色'},0);
  assert.equal(result.saved,true);assert.equal(result.synced,false);assert.equal(result.error,'GEMINI_HTTP_429');
  assert.equal(f.state.properties.has('INDEX_FILE_ID'),false);assert.equal(review(f).images[0].transcription,'更新');
  assert(!f.state.logs.join('\n').includes('private-quota-payload'));
});

test('publishing makes only an independent image copy public, validates its bytes, and creates valid selectable cards',()=>{
  const f=portfolioFixture();publish(f);
  const entries=f.gas.portfolioEntries_(index(f),f.gas.readPublicSource_(f.gas.config_()),f.gas.config_());
  assert.equal(entries.length,2);
  const card=f.gas.portfolioMessage_(entries);assert.equal(card.contents.contents.length,2);
  assert.match(card.contents.contents[0].footer.contents[0].action.data,/^work:[a-f0-9]{64}$/);
  for(const asset of Object.values(store(f).assets))assert.equal(f.state.files.get(asset.fileId).access,'ANYONE_WITH_LINK');
  assert.equal(f.state.files.get(f.state.properties.get('INDEX_FILE_ID')).access,'PRIVATE');
  assert.equal(f.state.files.get(f.state.properties.get('PORTFOLIO_STORE_FILE_ID')).access,'PRIVATE');
  assert.equal(f.state.documentWrites,0);
  assert.equal(f.gas.validatePortfolioCards(f.token).status,'valid');
  assert.equal(count(f,'/message/validate/reply'),1);assert.equal(count(f,'/message/reply'),0);
  const digest=review(f).images[0].digest,copyId=store(f).assets[digest].fileId;
  f.gas.setPortfolioImageSharing(f.token,digest,false);
  assert.equal(f.state.files.get(copyId).access,'PRIVATE');assert.equal(review(f).images[0].sharing,'private');
  assert.equal(f.gas.portfolioEntries_(index(f),f.gas.readPublicSource_(f.gas.config_()),f.gas.config_()).length,1);
});

test('failed thumbnail validation restores copy privacy; failed revocation is visible and stops card delivery',()=>{
  for(const invalid of [{mime:'text/html',bytes:[]},{mime:'image/png',bytes:png(1400,1000)},{mime:'image/png',bytes:[1,2,3]}]){
    const f=portfolioFixture(),response=f.state.response,digest=review(f).images[0].digest;
    f.state.response=call=>call.url.startsWith('https://drive.google.com/thumbnail')?invalid:response(call);
    assert.throws(()=>f.gas.setPortfolioImageSharing(f.token,digest,true),/PORTFOLIO_IMAGE_/);
    assert.equal(store(f).assets[digest].enabled,false);assert.equal(f.state.files.get(store(f).assets[digest].fileId).access,'PRIVATE');
  }
  const f=portfolioFixture();publish(f);const digest=review(f).images[0].digest;f.state.revokeError=true;
  assert.throws(()=>f.gas.setPortfolioImageSharing(f.token,digest,false),/PORTFOLIO_REVOKE_FAILED/);
  assert.equal(store(f).assets[digest].state,'revoke_failed');assert.equal(store(f).assets[digest].enabled,false);
});

test('source removal withdraws old public copies and an unrelated registry ID can never publish the source or another file',()=>{
  const f=portfolioFixture();publish(f);const digest=review(f).images[0].digest,copyId=store(f).assets[digest].fileId;
  f.nodes.splice(2,1);f.gas.reconcilePortfolioAssets_(f.gas.readPublicSource_(f.gas.config_()),f.gas.config_());
  assert.equal(f.state.files.get(copyId).access,'PRIVATE');
  const second=review(f).images[0].digest;
  const unrelated=f.gas.DriveApp.createFile('unrelated','{}');
  f.gas.updatePortfolioStore_(f.gas.config_(),s=>{s.assets[second]={fileId:unrelated.getId(),enabled:false};});
  assert.throws(()=>f.gas.setPortfolioImageSharing(f.token,second,true),/PORTFOLIO_ASSET_OWNERSHIP/);
  assert.equal(unrelated.access,'PRIVATE');
});

test('gallery selection and follow-up focus use only the selected work evidence and keep the same Quick Reply',()=>{
  const f=portfolioFixture();publish(f);const cfg=f.gas.config_();
  f.gas.handleEvent_(event('作品圖庫','gallery'),cfg);
  const memory=f.gas.readConversation_('user-1',index(f).fingerprint);assert.equal(memory.works.length,2);assert.equal(memory.focus,null);
  f.gas.handleEvent_(event('這張配色呢','ambiguous'),cfg);
  const ambiguous=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.match(ambiguous[0].text,/哪一件作品/);
  assert.equal(ambiguous[1].contents.footer.contents.length,2);
  f.gas.handleEvent_(event('第二件配色呢','second'),cfg);
  const request=f.state.calls.filter(c=>c.body?.contents&&c.url.endsWith(':generateContent')&&!c.body.generationConfig.responseSchema.properties.topics).at(-1);
  const payload=JSON.parse(request.body.contents[0].parts[0].text);
  assert(payload.evidence.some(e=>e.text.includes('橘色')));assert(!payload.evidence.some(e=>e.text.includes('青綠色')));
  f.gas.handleEvent_(event('構圖呢','follow'),cfg);
  assert.equal(f.gas.readConversation_('user-1',index(f).fingerprint).focus,memory.works[1]);
  const reply=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages;
  const labels=m=>m.quickReply.items.map(i=>i.action.label);
  assert.deepEqual(labels(reply[0]),labels(ambiguous[0]));
});

test('memory is isolated, expires, clears on source change and reset, and is never saved after failed LINE delivery',()=>{
  const f=portfolioFixture(),fp=index(f).fingerprint,cfg=f.gas.config_();
  f.gas.handleEvent_(event('網站介面','first'),cfg);
  assert(f.gas.readConversation_('user-1',fp));assert.equal(f.gas.readConversation_('other-user',fp),null);
  const key=f.gas.conversationKey_('user-1'),cached=JSON.parse(f.state.cache.get(key));
  assert(!key.includes('user-1'));assert(!('answer' in cached));
  f.state.cache.set(key,JSON.stringify({...cached,expiresAt:Date.now()-1}));assert.equal(f.gas.readConversation_('user-1',fp),null);
  f.gas.handleEvent_(event('網站介面','again'),cfg);
  assert.equal(f.gas.readConversation_('user-1','new-fingerprint'),null);
  f.gas.handleEvent_(event('網站介面','again2'),cfg);
  f.gas.handleEvent_(event('清除對話','reset'),cfg);assert.equal(f.gas.readConversation_('user-1',fp),null);
  const response=f.state.response;f.state.response=call=>call.url.endsWith('/message/reply')?{status:400,body:{}}:response(call);
  f.gas.handleEvent_(event('海報作品','failed'),cfg);assert.equal(f.gas.readConversation_('user-1',fp),null);
});

test('older slow replies cannot overwrite newer memory and new pixels do not inherit old corrections',()=>{
  const f=portfolioFixture(),fp=index(f).fingerprint;
  f.gas.saveConversation_('user-1',fp,{question:'新問題'},[],Date.now());
  f.gas.saveConversation_('user-1',fp,{question:'舊問題'},[],Date.now()-1000);
  assert.equal(f.gas.readConversation_('user-1',fp).lastQuestion,'新問題');
  const data=review(f);f.gas.saveImageReview(f.token,data.images[0].digest,{reset:false,transcription:'校正值',visualDescription:'校正畫面'},0);
  f.website.bytes.push(123);f.gas.syncKnowledgeBase();
  assert(!index(f).chunks.some(c=>c.text.includes('校正值')));
  assert.equal(review(f).images[0].reviewed,false);
});
