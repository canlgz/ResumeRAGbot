import test from 'node:test';
import assert from 'node:assert/strict';
import {createGas,event} from './harness.mjs';
import {portfolioFixture,candidate,isOcr} from './portfolio-fixture.mjs';
let sequence=0;
function send(f,text,user='visitor-a'){
 const e=event(text,'dialogue-'+(++sequence));e.source.userId=user;f.gas.handleEvent_(e,f.gas.config_());
 return f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages;
}
const stickers=messages=>messages.filter(m=>m.type==='sticker').map(m=>m.stickerId);
function answerIntent(f,intent){const original=f.state.response;f.state.response=call=>{
 if(call.url.endsWith(':generateContent')&&!isOcr(call)){
  const {evidence}=JSON.parse(call.body.contents[0].parts[0].text),hit=evidence[0];
  return candidate({grounded:true,answer:hit.text.slice(0,120),evidence:[{id:hit.id,quote:hit.text.slice(0,40)}],dialogueIntent:intent});
 }
 return original(call);
};}

test('greeting and appreciation use matching visual intent, no RAG, with per-visitor repeat suppression and reset',()=>{
 const f=createGas();assert.deepEqual(stickers(send(f,'你好')),['52002738']);assert.deepEqual(stickers(send(f,'hello')),[]);
 assert.deepEqual(stickers(send(f,'謝謝')),['52002739']);assert.deepEqual(stickers(send(f,'謝謝您')),[]);
 assert.deepEqual(stickers(send(f,'您好','visitor-b')),['52002738']);send(f,'清除對話');assert.deepEqual(stickers(send(f,'嗨')),['52002738']);
 assert(!f.state.calls.some(c=>c.url.includes('generativelanguage')));assert.equal(f.state.documentWrites,0);
 const raw=JSON.stringify([...f.state.cache.entries()]);assert(!raw.includes('visitor-a'));assert(!raw.includes('謝謝您'));
});

test('explicit soft interest offers contact without creating an invitation, sending notifications or guessing a commitment',()=>{
 const f=createGas({text:'[[PUBLIC]]\n## 聯絡方式\nEmail：resume@company.tw\n[[/PUBLIC]]'});
 const messages=send(f,'很有興趣');assert.deepEqual(stickers(messages),['52002752']);assert(messages.some(m=>m.type==='flex'&&m.altText.includes('聯繫本人')));
 assert(!JSON.stringify(messages).includes('已安排'));assert.equal(f.state.emails.length,0);assert.equal(f.state.documentWrites,0);
 assert(!f.state.calls.some(c=>/generativelanguage|message\/push/.test(c.url)));
 assert.equal(Object.keys(f.gas.loadPortfolioStore_(f.gas.config_()).invitations||{}).length,0);
 assert.equal(f.gas.socialDialogue_('我不想合作',f.gas.config_()),null);
 assert.equal(f.gas.socialDialogue_('謝謝，但我想問海報的配色',f.gas.config_()),null);
});

test('pure technical follow-ups suppress decorative stickers even when the model asks to celebrate',()=>{
 const f=portfolioFixture();answerIntent(f,'achievement');
 const messages=send(f,'請說明作品配色');assert.deepEqual(stickers(messages),[]);assert(messages.some(m=>m.text?.startsWith('資料來源：')));
});

test('clarifying a concern uses an attentive visual instead of celebration; unsupported model intent is neutral',()=>{
 const f=portfolioFixture();answerIntent(f,'achievement');assert.deepEqual(stickers(send(f,'我不太懂這件作品，請說明一下')),['52002768']);
 const other=portfolioFixture();answerIntent(other,'made-up-sticker');assert.deepEqual(stickers(send(other,'介紹網站作品')),[]);
});

test('valid achievement intent is expressed once and a failed LINE reply does not consume the sticker',()=>{
 const f=portfolioFixture();answerIntent(f,'achievement');assert.deepEqual(stickers(send(f,'介紹網站作品')),['52002734']);
 assert.deepEqual(stickers(send(f,'再介紹海報作品')),[]);
 const g=createGas();g.state.response=call=>({status:call.url.endsWith('/message/reply')?500:200,body:{}});
 assert.throws(()=>send(g,'你好'),/LINE_HTTP_500/);g.state.response=null;
 assert.deepEqual(stickers(send(g,'你好')),['52002738']);
});

test('missing facts and API errors stay plain and never carry question-mark or celebratory stickers',()=>{
 const f=portfolioFixture(),original=f.state.response;
 f.state.response=call=>call.url.endsWith(':generateContent')&&!isOcr(call)?candidate({grounded:false,answer:'未提供',evidence:[],dialogueIntent:'achievement'}):original(call);
 assert.deepEqual(stickers(send(f,'海報的印刷費是多少')),[]);
 const g=portfolioFixture(),response=g.state.response;g.state.response=call=>call.url.endsWith(':embedContent')?{status:429,body:{}}:response(call);
 const messages=send(g,'介紹網站');assert.deepEqual(stickers(messages),[]);assert.match(messages[0].text,/Google Gemini API/);
});

test('invitation drafting is not intercepted as social chat; only saved receipt gets an acknowledgement sticker',()=>{
 const f=createGas({text:'[[PUBLIC]]\n## 聯絡方式\nEmail：resume@company.tw\n[[/PUBLIC]]'});
 assert.deepEqual(stickers(send(f,'留下邀約')),[]);assert.deepEqual(stickers(send(f,'謝謝')),[]);
 assert.deepEqual(stickers(send(f,'想邀請面試工程師')),[]);assert.deepEqual(stickers(send(f,'hr@company.tw')),[]);
 const key=f.gas.invitationKey_('visitor-a',f.gas.config_()),id=f.gas.invitationDraft_(key).id;
 send(f,'週三上午');const record=f.gas.invitationDraft_(key);assert.equal(record.fields.company,'謝謝');assert.equal(record.step,4);
 assert.deepEqual(stickers(send(f,'invite:submit:'+id)),['52002740']);assert.deepEqual(stickers(send(f,'invite:submit:'+id)),[]);
 assert.equal(Object.keys(f.gas.loadPortfolioStore_(f.gas.config_()).invitations).length,1);
});
