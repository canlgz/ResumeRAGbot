import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioFixture,candidate,paragraph } from './portfolio-fixture.mjs';
import { createGas,event } from './harness.mjs';
const index=f=>f.gas.loadIndex_(f.gas.config_());
const classifications=f=>f.state.calls.filter(c=>c.body?.generationConfig?.responseSchema?.properties?.topics);

test('every topic click resets prior work focus and supplies nonempty evidence from only the selected topic',()=>{
  const f=portfolioFixture(),idx=index(f),cfg=f.gas.config_(),previousWork=idx.imageSources[0].imageKey;
  const topics=idx.quickTopics.topics.slice().sort((a,b)=>Number(a.imageKeys.includes(previousWork))-Number(b.imageKeys.includes(previousWork)));
  for(const [n,topic] of topics.entries()){
    // Reproduce the real failure: first focus a work, then click a different topic.
    f.gas.saveConversation_('user-1',idx.fingerprint,{question:'這張作品的配色',focus:previousWork},[previousWork],Date.now());
    const before=f.state.calls.length;
    f.gas.handleEvent_({...event('','switch-'+n),type:'postback',postback:{data:'topic:'+topic.id}},cfg);
    const calls=f.state.calls.slice(before),reply=calls.find(c=>c.url.endsWith('/message/reply'));
    assert(reply.body.messages.some(m=>m.text?.startsWith('資料來源：')),topic.label+' should answer rather than claim missing data');
    const generated=calls.find(c=>c.url.endsWith(':generateContent'));
    assert(generated,'each topic must reach answer generation');
    const payload=JSON.parse(generated.body.contents[0].parts[0].text);
    assert(payload.evidence.length>0);assert(payload.evidence.every(e=>topic.chunkIds.includes(e.id)));
    assert(payload.question.includes(topic.label));assert.equal(payload.conversation.previousQuestion,'');
    assert.equal(f.gas.readConversation_('user-1',idx.fingerprint).topicId,topic.id);
  }
  assert.equal(f.state.documentWrites,0);
});

test('typing an exact current topic label selects its own sources without inheriting another work',()=>{
  const f=portfolioFixture(),idx=index(f),topic=idx.quickTopics.topics.at(-1),previousWork=idx.imageSources[0].imageKey;
  f.gas.saveConversation_('user-1',idx.fingerprint,{question:'閱讀作品',focus:previousWork},[previousWork],Date.now());
  const before=f.state.calls.length;f.gas.handleEvent_(event(topic.label,'typed-topic'),f.gas.config_());
  const call=f.state.calls.slice(before).find(c=>c.url.endsWith(':generateContent'));
  const payload=JSON.parse(call.body.contents[0].parts[0].text);
  assert(payload.evidence.length>0);assert(payload.evidence.every(e=>topic.chunkIds.includes(e.id)));
  assert.equal(f.gas.readConversation_('user-1',idx.fingerprint).topicId,topic.id);
});

test('owner topic diagnostics exercise real conversation code after prior-work memory and never send LINE messages',()=>{
  const f=portfolioFixture(),data=index(f),before=f.state.documentWrites;
  for(const topic of data.quickTopics.topics){
    const result=f.gas.testImageReviewTopic(f.token,topic.id);
    assert.equal(result.status,'answered');assert.equal(result.previousWorkSeeded,true);
    assert(result.messages.some(text=>text.startsWith('資料來源：')));
  }
  assert.equal(f.gas.testQuickReplyTopics().status,'ready');
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/message/reply')).length,0);
  assert.equal(f.state.documentWrites,before);
  assert(![...f.state.cache.keys()].some(key=>key.startsWith('conversation:')));
  f.state.activeEmail='';assert.throws(()=>f.gas.testQuickReplyTopics(),/OWNER_ONLY/);
});

test('invalid topic source mapping is an index error, never a missing-resume record',()=>{
  const f=portfolioFixture(),idx=index(f),topic=idx.quickTopics.topics[0];
  const file=f.state.files.get(f.state.properties.get('INDEX_FILE_ID'));
  idx.quickTopics.topics[0].chunkIds=['S999'];file.content=JSON.stringify(idx);
  let recorded=0;f.gas.recordUnansweredQuestion_=()=>{recorded++;return true;};
  f.gas.handleEvent_({...event('','bad-source'),type:'postback',postback:{data:'topic:'+topic.id}},f.gas.config_());
  const reply=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages[0].text;
  assert.match(reply,/來源對應暫時異常/);assert.equal(recorded,0);
});

test('AI declining a generated overview never accuses the resume of lacking its own topic',()=>{
  const f=portfolioFixture(),topic=index(f).quickTopics.topics[0],response=f.state.response;
  f.state.response=call=>call.url.endsWith(':generateContent')?candidate({grounded:false,answer:'資料不足',evidence:[],sticker:'none'}):response(call);
  let recorded=0;f.gas.recordUnansweredQuestion_=()=>{recorded++;return true;};
  const result=f.gas.answerLineConversation_('請介紹所選主題',f.gas.config_(),topic.label,'test-user',null,false,topic.id);
  assert.equal(result.answerStatus,'unavailable');assert.equal(recorded,0);
  assert.match(result.messages[0].text,/有相關履歷資料/);
});

test('a genuinely missing follow-up records the actual question rather than the topic label',()=>{
  const f=portfolioFixture(),idx=index(f),topic=idx.quickTopics.topics.at(-1),response=f.state.response;
  f.gas.handleEvent_({...event('','intro'),type:'postback',postback:{data:'topic:'+topic.id}},f.gas.config_());
  f.state.response=call=>call.url.endsWith(':generateContent')?candidate({grounded:false,answer:'資料不足',evidence:[],sticker:'none'}):response(call);
  let recorded;f.gas.recordUnansweredQuestion_=question=>{recorded=question;return true;};
  f.gas.handleEvent_(event('用什麼技術','missing-followup'),f.gas.config_());
  assert.equal(recorded,'用什麼技術');
});

test('sync generates 3–6 representative topics once with exclusive complete source membership; subsequent messages reuse them',()=>{
  const f=portfolioFixture(),topics=index(f).quickTopics;
  assert.equal(topics.status,'ready');assert.equal(topics.topics.length,3);
  const ids=topics.topics.flatMap(t=>[...t.chunkIds]);assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,index(f).chunks.length);
  const groups=f.gas.topicGroups_(index(f).chunks);
  const work=groups.find(g=>g.section.includes('閱讀'));
  assert(work.chunkIds.length>=2);
  assert.equal(topics.topics.filter(t=>work.chunkIds.some(id=>t.chunkIds.includes(id))).length,1);
  const revision=topics.revision;f.gas.syncKnowledgeBase();assert.equal(index(f).quickTopics.revision,revision);
  assert.equal(classifications(f).length,1);
  for(const [i,text] of ['選單','使用說明','作品圖庫','網站介面','海報作品'].entries())f.gas.handleEvent_(event(text,'t'+i),f.gas.config_());
  assert.equal(classifications(f).length,1);
  const replies=f.state.calls.filter(c=>c.url.endsWith('/message/reply'));
  const expected=JSON.stringify(topics.topics.map(t=>t.label));
  for(const call of replies)for(const message of call.body.messages){if(message.type==='sticker')continue;
    assert.equal(JSON.stringify(message.quickReply.items.map(i=>i.action.label)),expected);
    assert(message.quickReply.items.every(i=>i.action.type==='postback'&&/^topic:/.test(i.action.data)));
  }
});

test('duplicate assignments, missing groups, overlapping labels and invalid topic counts cannot publish a menu',()=>{
  const f=portfolioFixture(),idx=index(f),groups=f.gas.topicGroups_(idx.chunks);
  const good=groups.map((g,i)=>({label:['網站設計','攝影海報','職涯背景'][i],scope:'單一範圍'+i,groupIds:[g.id]}));
  const validate=topics=>f.gas.validateQuickTopics_({topics},groups,idx.fingerprint,idx.chunks);
  assert.doesNotThrow(()=>validate(good));
  assert.throws(()=>validate(good.slice(0,2)),/QUICK_TOPICS_INVALID/);
  assert.throws(()=>validate([...good,...good,...good]),/QUICK_TOPICS_INVALID/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,groupIds:[groups[0].id]}:t)),/QUICK_TOPICS_OVERLAP/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,label:'網站設計實作'}:t)),/QUICK_TOPICS_OVERLAP/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,label:'個人介紹'}:t)),/QUICK_TOPICS_INVALID/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,groupIds:['G999']}:t)),/QUICK_TOPICS_OVERLAP/);
});

test('topic buttons constrain answers and follow-ups to their assigned sources; changed resume replaces menu only on sync',()=>{
  const f=portfolioFixture(),idx=index(f),topic=idx.quickTopics.topics.find(t=>t.imageKeys.includes(idx.imageSources[0].imageKey));
  f.gas.handleEvent_({...event('','topic1'),type:'postback',postback:{data:'topic:'+topic.id}},f.gas.config_());
  f.gas.handleEvent_(event('用什麼技術','followup'),f.gas.config_());
  const generation=f.state.calls.filter(c=>c.body?.contents&&c.url.endsWith(':generateContent')&&!c.body.generationConfig.responseSchema.properties.topics&&!c.body.contents[0].parts.some(p=>p.inlineData));
  for(const call of generation){const value=JSON.parse(call.body.contents[0].parts[0].text);assert(value.evidence.every(e=>topic.chunkIds.includes(e.id)));}
  assert.equal(f.gas.readConversation_('user-1',idx.fingerprint).topicId,topic.id);
  f.nodes.splice(9,0,paragraph('新增的職涯成果。'));
  f.gas.handleEvent_(event('選單','beforeSync'),f.gas.config_());
  const reply=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  assert(!reply.quickReply);
  f.gas.syncKnowledgeBase();assert.notEqual(index(f).quickTopics.revision,idx.quickTopics.revision);assert.equal(classifications(f).length,2);
  f.gas.handleEvent_({...event('','oldTopic'),type:'postback',postback:{data:'topic:'+topic.id}},f.gas.config_());
  const oldReply=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages[0];assert.match(oldReply.text,/主題已更新/);
});

test('upgrading a compatible old index adds only topic metadata and failed classification preserves working knowledge',()=>{
  const f=portfolioFixture(),id=f.state.properties.get('INDEX_FILE_ID'),file=f.state.files.get(id);
  const value=JSON.parse(file.content);delete value.quickTopics;file.content=JSON.stringify(value);
  const vectorCalls=f.state.calls.filter(c=>c.url.endsWith(':batchEmbedContents')).length;
  f.state.topicResponse=()=>({status:429,body:{error:{message:'sensitive-quota'}}});
  assert.throws(()=>f.gas.syncKnowledgeBase(),/GEMINI_HTTP_429/);
  assert.equal(f.state.properties.get('INDEX_FILE_ID'),id);assert(!file.trashed);assert.equal(index(f).chunks.length,value.chunks.length);
  f.state.topicResponse=null;assert.equal(f.gas.syncKnowledgeBase().status,'unchanged');assert.equal(index(f).quickTopics.status,'ready');
  assert.equal(f.state.calls.filter(c=>c.url.endsWith(':batchEmbedContents')).length,vectorCalls);
});

test('malformed classification retries once; genuinely sparse content does not invent representative keywords',()=>{
  const f=portfolioFixture(),idx=index(f);let n=0;
  f.state.topicResponse=call=>++n===1?candidate({topics:[]}):candidate({topics:JSON.parse(call.body.contents[0].parts[0].text).groups.map((g,i)=>({label:['介面創作','視覺設計','職涯成長'][i],scope:'範圍'+i,groupIds:[g.id]}))});
  assert.equal(f.gas.buildQuickTopics_(idx.chunks,f.gas.config_(),idx.fingerprint).topics.length,3);assert.equal(n,2);
  const sparse=createGas();const result=sparse.gas.buildQuickTopics_([{id:'S1',section:'簡介',text:'只有名字。'}],sparse.gas.config_(),'f');
  assert.equal(result.status,'insufficient_content');assert.equal(result.topics.length,0);assert.equal(sparse.state.calls.length,0);
});
