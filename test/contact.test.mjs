import test from 'node:test';
import assert from 'node:assert/strict';
import {createGas,event} from './harness.mjs';
const publicDoc='[[PUBLIC]]\n## 個人介紹\n姓名：測試履歷。\n## 公開聯絡方式\nEmail：resume@company.tw\n[[/PUBLIC]]\n[[PRIVATE]]\nEmail：secret@private.tw\n[[/PRIVATE]]';
function setup(){const f=createGas({text:publicDoc});let n=0;const send=(text,user='user-1',post=false,id)=>{const e=event(text,id||'contact-'+(++n));e.source.userId=user;if(post){e.type='postback';e.postback={data:text};}f.gas.handleEvent_(e,f.gas.config_());return f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages;};return {...f,send};}
const draft=(f,user='user-1')=>f.gas.invitationDraft_(f.gas.invitationKey_(user,f.gas.config_()));
function fill(f,user='user-1'){f.send('invite:start',user,true);f.send('青禾公司／王小姐',user);f.send('邀請面試 AI 工程師',user);f.send('hr@company.tw',user);f.send('invite:skip:'+draft(f,user).id,user,true);return draft(f,user).id;}
const records=f=>f.gas.loadPortfolioStore_(f.gas.config_()).invitations||{};

test('contact button reads current PUBLIC Doc email without an index or AI; removed/private emails never persist',()=>{
 const f=setup();let msgs=f.send('nav:contact','user-1',true);let card=msgs[0];assert.equal(card.type,'flex');assert.equal(card.contents.footer.contents[0].action.type,'postback');assert.equal(f.send('contact:email','user-1',true)[0].text,'resume@company.tw');assert(!JSON.stringify(card).includes('secret@private.tw'));
 f.state.text=publicDoc.replace('resume@company.tw','new@company.tw');f.send('想約面試');assert.equal(f.send('contact:email','user-1',true)[0].text,'new@company.tw');
 f.state.text=publicDoc.replace('Email：resume@company.tw','未提供信箱');assert(!JSON.stringify(f.send('想合作')).includes('mailto:'));
 assert(!f.state.calls.some(c=>c.url.includes('generativelanguage')));assert.equal(f.state.documentWrites,0);
});

test('intent distinguishes invitations from questions about previous collaboration',()=>{
 const {gas}=setup();for(const text of ['想約面試','我們想邀請你面試','可以跟你合作嗎？','想合作','聯繫本人','如何聯絡？'])assert(gas.contactIntent_(text),text);
 for(const text of ['有哪些合作經驗？','我想了解你過去的合作經驗','不想合作','合作過哪些專案'])assert(!gas.contactIntent_(text),text);
 assert(!gas.usableEmail_('test@example.invalid'));assert(!gas.usableEmail_('a@example.com'));assert(gas.usableEmail_('resume@company.tw'));
});

test('drafts stay private until confirmation, skip works, and repeated confirmation creates exactly one record',()=>{
 const f=setup(),id=fill(f);assert.equal(Object.keys(records(f)).length,0);assert.equal(draft(f).step,4);
 let reply=f.send('invite:submit:'+id,'user-1',true);assert.match(reply[0].text,/已存入/);assert.equal(Object.keys(records(f)).length,1);
 assert.equal(records(f)[id].fields.availability,'');assert.equal(records(f)[id].fields.replyTo,'hr@company.tw');
 f.send('invite:submit:'+id,'user-1',true);assert.equal(Object.keys(records(f)).length,1);
 assert.equal(f.state.documentWrites,0);assert(!JSON.stringify([...f.state.files.values()].map(v=>v.content)).includes('user-1'));
 assert(!f.state.calls.some(c=>/generativelanguage|message\/push/.test(c.url)));
});

test('other visitors and old confirmation buttons cannot submit a newer draft',()=>{
 const f=setup(),id=fill(f);f.send('invite:submit:'+id,'user-2',true);assert.equal(Object.keys(records(f)).length,0);
 f.send('invite:restart:'+id,'user-1',true);assert.notEqual(draft(f).id,id);
 f.send('invite:submit:'+id,'user-1',true);assert.equal(Object.keys(records(f)).length,0);assert.equal(draft(f).step,0);
});

test('cancel/home/topic navigation leaves no submitted invitation and an evicted draft does not send private input to AI',()=>{
 for(const exit of ['取消','首頁','nav:contact']){const f=setup();f.send('invite:start','user-1',true);f.send(exit,'user-1',exit==='nav:contact');assert.equal(draft(f),null);assert.equal(Object.keys(records(f)).length,0);}
 const f=setup();f.send('invite:start','user-1',true);f.state.cache.clear();const messages=f.send('我的私密聯絡資料');assert.match(messages[0].text,/已過期/);assert(!f.state.calls.some(c=>c.url.includes('generativelanguage')));assert.equal(Object.keys(records(f)).length,0);
});

test('a failed LINE reply replay does not consume the input as the next field',()=>{
 const f=setup();f.send('invite:start','user-1',true);let fail=true;
 f.state.response=call=>call.url.endsWith('/message/reply')&&fail?{status:500,body:{}}:{body:{}};
 assert.throws(()=>f.send('公司甲','user-1',false,'retry-input'),/LINE_HTTP_500/);assert.equal(draft(f).step,1);
 fail=false;f.send('公司甲','user-1',false,'retry-input');assert.equal(draft(f).step,1);assert.equal(draft(f).fields.company,'公司甲');
});

test('save failure keeps the confirmation draft and does not claim success; retry can persist',()=>{
 const f=setup();f.gas.updatePortfolioStore_(f.gas.config_(),()=>{});const id=fill(f),file=f.state.files.get(f.state.properties.get('PORTFOLIO_STORE_FILE_ID')),save=file.setContent;
 file.setContent=()=>{throw new Error('disk unavailable');};const reply=f.send('invite:submit:'+id,'user-1',true);assert.match(reply[0].text,/尚未保存成功/);assert.equal(draft(f).step,4);assert.equal(Object.keys(records(f)).length,0);
 file.setContent=save;f.send('invite:submit:'+id,'user-1',true);assert.equal(Object.keys(records(f)).length,1);
});

test('owner inbox is capability protected, omits visitor hashes and supports handling/deletion',()=>{
 const f=setup(),id=fill(f);f.send('invite:submit:'+id,'user-1',true);
 f.state.properties.set('WEB_APP_URL','https://script.google.com/macros/s/test-public/exec');const link=f.gas.openInvitations();assert.match(link.url,/view=invitations/);const token=link.url.split('#')[1];
 assert.throws(()=>f.gas.getInvitations('bad'),/REVIEW_SESSION_EXPIRED/);
 const inbox=f.gas.getInvitations(token);assert.equal(inbox.invitations.length,1);assert(!JSON.stringify(inbox).includes('visitor'));
 f.gas.updateInvitation(token,id,'handled');assert.equal(f.gas.getInvitations(token).invitations[0].status,'handled');
 f.gas.updateInvitation(token,id,'delete');assert.equal(f.gas.getInvitations(token).invitations.length,0);
 f.state.activeEmail='';assert.throws(()=>f.gas.openInvitations(),/OWNER_ONLY/);
});

test('owner live diagnostics persist and clean only their own test invitation and validate without sending messages',()=>{
 const f=setup(),id=fill(f);f.send('invite:submit:'+id,'user-1',true);
 f.state.properties.set('WEB_APP_URL','https://script.google.com/macros/s/test-public/exec');const token=f.gas.openInvitations().url.split('#')[1];
 const before=f.state.calls.length,emailsBefore=f.state.emails.length,result=f.gas.testContactFlow(token);assert.equal(f.state.emails.length,emailsBefore);assert.equal(result.status,'passed');assert.equal(result.lineValidation,'valid');
 assert.deepEqual(Object.keys(records(f)),[id]);assert(!f.state.calls.slice(before).some(c=>/\/message\/(reply|push)$/.test(c.url)));assert.equal(f.state.documentWrites,0);
});

test('submitting an invitation never changes RAG source fingerprint or public document',()=>{
 const f=setup(),before=f.gas.readPublicSource_(f.gas.config_()).fingerprint,id=fill(f);f.send('invite:submit:'+id,'user-1',true);
 assert.equal(f.gas.readPublicSource_(f.gas.config_()).fingerprint,before);assert.equal(f.state.text,publicDoc);
});

test('Email retrieval returns exact plain text and never launches a mailto URI or treats punctuation as headers',()=>{
 const f=setup();f.state.text=publicDoc.replace('resume@company.tw','resume+hr?cc=other@company.tw');
 const card=f.send('聯繫本人')[0],action=card.contents.footer.contents[0].action;
 assert.equal(action.type,'postback');assert.equal(f.send('contact:email','user-1',true)[0].text,'resume+hr?cc=other@company.tw');assert.equal(action.uri,undefined);assert(!JSON.stringify(card).includes('mailto:'));
});

test('confirmed invitation emails only the current Doc owner address with all fields and safe Reply-To',()=>{
 const f=setup(),id=fill(f);assert.equal(f.state.emails.length,0);
 f.state.text=publicDoc.replace('resume@company.tw','updated@company.tw');
 const reply=f.send('invite:submit:'+id,'user-1',true);
 assert.equal(f.state.emails.length,1);const mail=f.state.emails[0];
 assert.equal(mail.to,'updated@company.tw');assert.equal(mail.replyTo,'hr@company.tw');
 for(const value of ['青禾公司／王小姐','邀請面試 AI 工程師','hr@company.tw','不限定',id])assert(mail.body.includes(value));
 assert(!mail.htmlBody);assert(!JSON.stringify(mail).includes('user-1'));assert.match(reply[0].text,/送交 Google/);
 assert.equal(records(f)[id].notification.status,'sent');
 f.state.cache.clear();f.send('invite:submit:'+id,'user-1',true);assert.equal(f.state.emails.length,1);
 assert.equal(f.state.documentWrites,0);
});

test('cancellation, storage failure and invalid confirmation never send notification mail',()=>{
 const f=setup(),id=fill(f);f.send('invite:submit:'+id,'user-2',true);f.send('取消');assert.equal(f.state.emails.length,0);
 f.gas.updatePortfolioStore_(f.gas.config_(),()=>{});const next=fill(f),file=f.state.files.get(f.state.properties.get('PORTFOLIO_STORE_FILE_ID'));
 file.setContent=()=>{throw new Error('save failed');};f.send('invite:submit:'+next,'user-1',true);assert.equal(f.state.emails.length,0);
});

test('missing recipient, Google quota and authorization failures retain invitation without claiming email sent',()=>{
 for(const reason of ['no_email','quota_exhausted','permission_or_service_unavailable','delivery_unknown']){
  const f=setup(),id=fill(f);
  if(reason==='no_email')f.state.text=publicDoc.replace('resume@company.tw','example@example.invalid');
  if(reason==='quota_exhausted')f.state.mailQuota=0;
  if(reason==='permission_or_service_unavailable')f.state.mailPermissionError=true;
  if(reason==='delivery_unknown')f.state.mailSendError=true;
  const reply=f.send('invite:submit:'+id,'user-1',true);
  assert.equal(records(f)[id].notification.status,reason);assert.match(reply[0].text,/已存入/);assert.match(reply[0].text,/尚未確認寄出/);
  assert.equal(f.state.emails.length,0);
  f.state.cache.clear();f.send('invite:submit:'+id,'user-1',true);assert.equal(f.state.mailAttemptCount||0,reason==='delivery_unknown'?1:0);
 }
});

test('failure to persist sending marker prevents email; failure after send never triggers duplicate delivery',()=>{
 for(const failAt of [2,3]){
  const f=setup();f.gas.updatePortfolioStore_(f.gas.config_(),()=>{});const id=fill(f),file=f.state.files.get(f.state.properties.get('PORTFOLIO_STORE_FILE_ID')),save=file.setContent;let saves=0;
  file.setContent=function(value){if(++saves===failAt)throw new Error('uncertain write');return save.call(this,value);};
  f.send('invite:submit:'+id,'user-1',true);assert.equal(f.state.emails.length,failAt===2?0:1);
  assert.equal(records(f)[id].notification?.status,failAt===2?undefined:'attempting');
  file.setContent=save;f.state.cache.clear();f.send('invite:submit:'+id,'user-1',true);assert.equal(f.state.emails.length,failAt===2?0:1);
 }
});

test('reply-to accepts one email only and plain-text mail never interprets invitation HTML',()=>{
 const f=setup();for(const replyTo of ['09123456789','LINE ID: abc','hr@company.tw\nBcc: leak@evil.tw','hr@company.tw,other@evil.tw']){
  const mail=f.gas.invitationEmail_({id:'a',createdAt:new Date().toISOString(),fields:{company:'<script>alert(1)</script>',message:'<b>職缺</b>',replyTo}},'resume@company.tw');
  assert.equal(mail.replyTo,undefined);assert.equal(mail.to,'resume@company.tw');assert(!mail.htmlBody);assert(mail.body.includes('<script>'));
 }
});

test('owner authorization helper sends a clearly labelled setup email only to Doc contact',()=>{
 const f=setup();f.state.activeEmail='';assert.throws(()=>f.gas.enableInvitationEmailNotifications(),/OWNER_ONLY/);assert.equal(f.state.emails.length,0);
 f.state.activeEmail='owner@example.test';assert.equal(f.gas.enableInvitationEmailNotifications().status,'ready');
 assert.equal(f.state.emails.length,1);assert.equal(f.state.emails[0].to,'resume@company.tw');assert.match(f.state.emails[0].subject,/啟用測試/);
 assert.equal(Object.keys(records(f)).length,0);assert.equal(f.state.documentWrites,0);
});

test('confirmed invitation pushes only to configured owner with full text and persistent deduplication',()=>{
 const f=setup(),owner='U'+'a'.repeat(32);f.state.properties.set('OWNER_LINE_USER_ID',owner);const id=fill(f);
 assert(!f.state.calls.some(c=>c.url.endsWith('/message/push')));f.send('invite:submit:'+id,'user-1',true);
 const pushes=f.state.calls.filter(c=>c.url.endsWith('/message/push'));assert.equal(pushes.length,1);assert.equal(pushes[0].body.to,owner);
 assert.match(pushes[0].headers['X-Line-Retry-Key'],/^[a-f0-9-]{36}$/);assert.match(pushes[0].body.messages[0].text,/青禾公司/);
 assert.equal(records(f)[id].lineNotification.status,'sent');assert.equal(f.state.emails.length,1);
 f.state.cache.clear();f.send('invite:submit:'+id,'user-1',true);assert.equal(f.state.calls.filter(c=>c.url.endsWith('/message/push')).length,1);
 assert.equal(f.state.documentWrites,0);
});

test('LINE and Email failures are independent and never lose the saved invitation',()=>{
 for(const code of [200,409,429,500,400]){
  const f=setup();f.state.properties.set('OWNER_LINE_USER_ID','U'+'a'.repeat(32));f.state.mailQuota=0;
  f.state.response=call=>({status:call.url.endsWith('/message/push')?code:200,body:{}});
  const id=fill(f);f.send('invite:submit:'+id,'user-1',true);
  assert.equal(records(f)[id].notification.status,'quota_exhausted');
  assert.equal(records(f)[id].lineNotification.status,code===200||code===409?'sent':code===429?'quota_or_rate_limit':code===500?'delivery_unknown':'rejected');
 }
 const f=setup();f.state.properties.set('OWNER_LINE_USER_ID','invalid');const id=fill(f);f.send('invite:submit:'+id,'user-1',true);
 assert.equal(f.state.emails.length,1);assert(!f.state.calls.some(c=>c.url.endsWith('/message/push')));
});

test('owner notification configuration and test push require owner capability and never expose owner ID to visitors',()=>{
 const f=setup();f.state.properties.set('WEB_APP_URL','https://script.google.com/macros/s/test-public/exec');const token=f.gas.openInvitations().url.split('#')[1];
 assert.throws(()=>f.gas.setOwnerLineNotification('bad','U'+'a'.repeat(32)),/REVIEW_SESSION_EXPIRED/);
 assert.throws(()=>f.gas.testOwnerLineNotification('bad'),/REVIEW_SESSION_EXPIRED/);
 assert.throws(()=>f.gas.setOwnerLineNotification(token,'bad'));
 assert(f.gas.setOwnerLineNotification(token,'U'+'a'.repeat(32)).configured);assert(f.gas.getInvitations(token).ownerLineConfigured);
 assert.equal(f.gas.testOwnerLineNotification(token).status,'sent');assert.equal(f.state.calls.filter(c=>c.url.endsWith('/message/push')).length,1);
 assert(!JSON.stringify(f.send('聯繫本人')).includes('U'+'a'.repeat(32)));
 const before=f.state.calls.length;f.gas.testContactFlow(token);assert(!f.state.calls.slice(before).some(c=>c.url.endsWith('/message/push')));
 assert.equal(f.gas.setOwnerLineNotification(token,'').configured,false);
});

test('contact email uses a compact adjacent copy icon and preserves plain-text fallback, with only invite and home footer buttons',()=>{
 const f=setup(),card=f.send('聯繫本人')[0],row=card.contents.body.contents.find(c=>c.layout==='horizontal');
 assert.equal(row.contents[0].text,'resume@company.tw');assert.equal(row.contents[0].action.data,'contact:email');
 const icon=row.contents[1];assert.equal(icon.width,'32px');assert.equal(icon.height,'32px');assert.equal(icon.action.type,'clipboard');assert.equal(icon.action.clipboardText,'resume@company.tw');
 assert.deepEqual(card.contents.footer.contents.map(b=>b.action.label),['在 LINE 留邀約','回首頁']);assert.equal(card.contents.footer.contents[0].style,'primary');
 assert.equal(f.send('contact:email','user-1',true)[0].text,'resume@company.tw');
 f.state.text=publicDoc.replace('resume@company.tw','sample@example.invalid');const unavailable=f.send('聯繫本人')[0];
 assert(!JSON.stringify(unavailable).includes('"clipboard"'));assert(!JSON.stringify(unavailable).includes('"contact:email"'));
});
