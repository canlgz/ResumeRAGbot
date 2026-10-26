import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioFixture,candidate,paragraph } from './portfolio-fixture.mjs';
import { createGas,event } from './harness.mjs';
const index=f=>f.gas.loadIndex_(f.gas.config_());
const classifications=f=>f.state.calls.filter(c=>c.body?.generationConfig?.responseSchema?.properties?.topics);

test('the two essential entries are always visible and the homepage uses their exact same order',()=>{
  const {gas,state}=createGas();gas.handleEvent_(event('選單','no-index'),gas.config_());
  const welcome=state.calls.find(c=>c.url.endsWith('/message/reply')).body.messages[0];
  assert.deepEqual(welcome.quickReply.items.map(i=>i.action.label),['我是誰','快速一覽']);
  assert.deepEqual(welcome.contents.contents[2].body.contents.slice(2).flatMap(row=>row.contents.map(b=>b.action.label)),['我是誰','快速一覽']);
});

test('intro and overview each reset work memory but use different source and answer-format scopes',()=>{
  const f=portfolioFixture(),idx=index(f),core=f.gas.menuTopics_(idx).slice(0,2),work=idx.imageSources[0].imageKey;
  const sources=[];
  for(const [i,topic] of core.entries()){
    f.gas.saveConversation_('user-1',idx.fingerprint,{question:'這張配色',focus:work},[work],Date.now());
    const before=f.state.calls.length;
    f.gas.handleEvent_({...event('','core-'+i),type:'postback',postback:{data:'topic:'+topic.id}},f.gas.config_());
    const calls=f.state.calls.slice(before),generation=calls.find(c=>c.url.endsWith(':generateContent'));
    const payload=JSON.parse(generation.body.contents[0].parts[0].text);sources.push(payload.evidence.map(e=>e.id));
    assert.equal(payload.conversation.answerMode,topic.kind);assert.equal(payload.conversation.previousQuestion,'');
    assert.deepEqual([...payload.conversation.excludedTopics],[]);
    assert.equal(calls.filter(c=>c.url.endsWith(':embedContent')).length,1);
    assert.equal(calls.filter(c=>c.url.endsWith(':generateContent')).length,1);
    assert(calls.find(c=>c.url.endsWith('/message/reply')).body.messages.some(m=>m.text?.startsWith('資料來源：')));
  }
  assert(sources[0].every(id=>idx.quickTopics.profileChunkIds.includes(id)));
  for(const topic of idx.quickTopics.topics)assert(sources[1].some(id=>topic.chunkIds.includes(id)),'overview should include each adaptive area');
  assert(sources[1].some(id=>idx.quickTopics.profileChunkIds.includes(id)));
  assert.equal(f.state.documentWrites,0);
});

test('core IDs remain usable after resume updates and punctuation in the typed intro label is accepted',()=>{
  const f=portfolioFixture(),before=f.gas.menuTopics_(index(f)).slice(0,2).map(t=>t.id);
  f.nodes.splice(9,0,paragraph('新增加的經歷。'));f.gas.syncKnowledgeBase();
  assert.deepEqual([...f.gas.menuTopics_(index(f)).slice(0,2).map(t=>t.id)],[...before]);
  f.gas.handleEvent_(event('我是誰？','intro-question'),f.gas.config_());
  const call=f.state.calls.filter(c=>c.url.endsWith(':generateContent')&&!c.body.generationConfig.responseSchema.properties.topics).at(-1);
  assert.equal(JSON.parse(call.body.contents[0].parts[0].text).conversation.answerMode,'intro');
});

test('a follow-up after an essential entry keeps its subject but does not remain trapped in intro formatting',()=>{
  const f=portfolioFixture();f.gas.handleEvent_(event('我是誰','about'),f.gas.config_());
  const memory=f.gas.readConversation_('user-1',index(f).fingerprint);assert.equal(memory.lastQuestion,'我是誰');
  f.gas.handleEvent_(event('用什麼技術','about-followup'),f.gas.config_());
  const call=f.state.calls.filter(c=>c.url.endsWith(':generateContent')&&!c.body.generationConfig.responseSchema.properties.topics).at(-1);
  const payload=JSON.parse(call.body.contents[0].parts[0].text);
  assert.equal(payload.conversation.previousQuestion,'我是誰');assert.equal(payload.conversation.answerMode,null);
  assert.equal(payload.conversation.topicScope,null);
});

test('four adaptive areas plus two essentials fit the six-button limit without losing any area',()=>{
  const {gas}=createGas();
  const chunks=Array.from({length:5},(_,i)=>({id:'S'+i,section:'組'+i,text:'內容'+i}));
  const groups=gas.topicGroups_(chunks),quickTopics=gas.validateQuickTopics_({profileGroupIds:['G1'],topics:groups.slice(1).map((g,i)=>({category:'專案',label:'特色領域'+i,scope:'範圍'+i,groupIds:[g.id]}))},groups,'fp',chunks);
  const menu=gas.menuTopics_({chunks,quickTopics});assert.equal(menu.length,6);
  assert.deepEqual([...menu.slice(0,2).map(t=>t.label)],['我是誰','快速一覽']);
  assert.equal(new Set(menu.map(t=>t.label)).size,6);
});

test('legacy metadata shows both essentials while a menu-only upgrade preserves vectors and OCR',()=>{
  const f=portfolioFixture(),file=f.state.files.get(f.state.properties.get('INDEX_FILE_ID')),old=index(f);
  old.quickTopics.version=2;delete old.quickTopics.profileChunkIds;file.content=JSON.stringify(old);
  assert.deepEqual([...f.gas.menuTopics_(index(f)).slice(0,2).map(t=>t.label)],['我是誰','快速一覽']);
  const before=f.state.calls.length;f.gas.syncKnowledgeBase();
  const calls=f.state.calls.slice(before);assert.equal(index(f).quickTopics.version,4);
  assert(!calls.some(c=>c.url.endsWith(':batchEmbedContents')||c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)));
});

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

test('sync generates adaptive themes once; profile and adaptive sources are exclusive and the two core entries stay first',()=>{
  const f=portfolioFixture(),topics=index(f).quickTopics;
  assert.equal(topics.status,'ready');assert.equal(topics.topics.length,2);
  const menu=f.gas.menuTopics_(index(f));assert.deepEqual([...menu.slice(0,2).map(t=>t.label)],['我是誰','快速一覽']);assert.equal(menu.length,4);
  const ids=[...topics.profileChunkIds,...topics.topics.flatMap(t=>[...t.chunkIds])];assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,index(f).chunks.length);
  const groups=f.gas.topicGroups_(index(f).chunks);
  const work=groups.find(g=>g.section.includes('閱讀'));
  assert(work.chunkIds.length>=2);
  assert.equal(topics.topics.filter(t=>work.chunkIds.some(id=>t.chunkIds.includes(id))).length,1);
  const revision=topics.revision;f.gas.syncKnowledgeBase();assert.equal(index(f).quickTopics.revision,revision);
  assert.equal(classifications(f).length,1);
  for(const [i,text] of ['選單','使用說明','作品圖庫','網站介面','海報作品'].entries())f.gas.handleEvent_(event(text,'t'+i),f.gas.config_());
  assert.equal(classifications(f).length,1);
  const replies=f.state.calls.filter(c=>c.url.endsWith('/message/reply'));
  const expected=JSON.stringify(menu.map(t=>t.label));
  for(const call of replies)for(const message of call.body.messages){if(message.type==='sticker')continue;
    assert.equal(JSON.stringify(message.quickReply.items.map(i=>i.action.label)),expected);
    assert(message.quickReply.items.every(i=>i.action.type==='postback'&&/^topic:/.test(i.action.data)));
  }
});

test('profile/adaptive duplicates, incomplete groups, core-label collisions and more than four features are rejected',()=>{
  const f=portfolioFixture(),idx=index(f),groups=f.gas.topicGroups_(idx.chunks);
  const good=groups.slice(0,2).map((g,i)=>({category:'作品',label:['網站設計','攝影海報'][i],scope:'單一範圍'+i,groupIds:[g.id]}));
  const validate=(topics,profileGroupIds=[groups[2].id])=>f.gas.validateQuickTopics_({profileGroupIds,topics},groups,idx.fingerprint,idx.chunks);
  assert.doesNotThrow(()=>validate(good));
  assert.throws(()=>validate(good.slice(0,1)),/QUICK_TOPICS_INCOMPLETE/);
  assert.throws(()=>validate([...good,...good,...good]),/QUICK_TOPICS_INVALID/);
  assert.throws(()=>validate(good,[groups[0].id,groups[2].id]),/QUICK_TOPICS_OVERLAP/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,groupIds:[groups[0].id]}:t)),/QUICK_TOPICS_OVERLAP/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,label:'網站設計實作'}:t)),/QUICK_TOPICS_OVERLAP/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,label:'個人介紹'}:t)),/QUICK_TOPICS_INVALID/);
  assert.throws(()=>validate(good.map((t,i)=>i===1?{...t,label:'快速一覽'}:t)),/QUICK_TOPICS_INVALID/);
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
  assert.deepEqual(reply.quickReply.items.map(item=>item.action.label),['我是誰','快速一覽']);
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

test('malformed classification retries once and profile-only content keeps just the two basic entries',()=>{
  const f=portfolioFixture(),idx=index(f);let n=0;
  f.state.topicResponse=call=>{const groups=JSON.parse(call.body.contents[0].parts[0].text).groups;
    return ++n===1?candidate({topics:[]}):candidate({profileGroupIds:[groups[2].id],topics:groups.slice(0,2).map((g,i)=>({category:'作品',label:['介面創作','視覺設計'][i],scope:'範圍'+i,groupIds:[g.id]}))});};
  assert.equal(f.gas.buildQuickTopics_(idx.chunks,f.gas.config_(),idx.fingerprint).topics.length,2);assert.equal(n,2);
  const sparse=createGas();const result=sparse.gas.buildQuickTopics_([{id:'S1',section:'簡介',text:'只有名字。'}],sparse.gas.config_(),'f');
  assert.equal(result.status,'ready');assert.equal(result.topics.length,0);assert.equal(sparse.state.calls.length,1);
  assert.deepEqual([...sparse.gas.menuTopics_({chunks:[{id:'S1'}],quickTopics:result}).map(t=>t.label)],['我是誰','快速一覽']);
});

test('adaptive labels contain a validated category and a distinct title; category cannot hide duplicate topics',()=>{
 const {gas}=createGas(),chunks=[{id:'S1',section:'介紹',text:'本人背景'},{id:'S2',section:'專案',text:'知識助理案例'},{id:'S3',section:'設計',text:'海報作品'}],groups=gas.topicGroups_(chunks);
 const topics=[{category:'專案',label:'知識助理',scope:'只介紹助理案例',groupIds:['G2']},{category:'作品',label:'海報設計',scope:'只介紹海報作品',groupIds:['G3']}];
 const validate=items=>gas.validateQuickTopics_({profileGroupIds:['G1'],topics:items},groups,'fp',chunks);
 const result=validate(topics);assert.equal(result.version,4);assert.deepEqual([...result.topics.map(t=>t.label)],['專案：知識助理','作品：海報設計']);
 assert.equal(result.topics[0].title,'知識助理');assert.equal(result.topics[0].category,'專案');
 for(const change of [{category:undefined},{category:'其他'},{label:'專案：知識助理'}])assert.throws(()=>validate([{...topics[0],...change},topics[1]]),/QUICK_TOPICS_INVALID/);
 assert.throws(()=>validate([topics[0],{...topics[1],category:'技能',label:'知識助理'}]),/QUICK_TOPICS_OVERLAP/);
 assert(result.topics.every(t=>Array.from(t.label).length<=20));
});

test('v3 label upgrade reuses OCR and vectors, keeps compatible topic IDs, and sync-only classification is stable',()=>{
 const f=portfolioFixture(),old=index(f),file=f.state.files.get(f.state.properties.get('INDEX_FILE_ID'));
 const ids=old.quickTopics.topics.map(t=>t.id);old.quickTopics.version=3;
 old.quickTopics.topics.forEach(t=>{t.label=t.title;delete t.category;delete t.title;});file.content=JSON.stringify(old);
 const before=f.state.calls.length;f.gas.syncKnowledgeBase();const calls=f.state.calls.slice(before),updated=index(f);
 assert.equal(updated.quickTopics.version,4);assert.deepEqual([...updated.quickTopics.topics.map(t=>t.id)],[...ids]);
 assert.equal(calls.filter(c=>c.body?.generationConfig?.responseSchema?.properties?.topics).length,1);
 assert(!calls.some(c=>c.url.endsWith(':batchEmbedContents')||c.body?.contents?.[0]?.parts?.some(p=>p.inlineData)));
 const revision=updated.quickTopics.revision,after=f.state.calls.length;f.gas.syncKnowledgeBase();assert.equal(index(f).quickTopics.revision,revision);
 assert(!f.state.calls.slice(after).some(c=>c.url.includes('generativelanguage')));
});

test('typed prefixed, ASCII-colon and legacy short names all select the same constrained topic',()=>{
 const f=portfolioFixture(),topic=index(f).quickTopics.topics[0];
 for(const [i,label] of [topic.label,topic.label.replace('：',':'),topic.title].entries()){
  const before=f.state.calls.length;f.gas.handleEvent_(event(label,'categorized-'+i),f.gas.config_());
  const call=f.state.calls.slice(before).find(c=>c.url.endsWith(':generateContent'));
  const payload=JSON.parse(call.body.contents[0].parts[0].text);
  assert(payload.evidence.every(e=>topic.chunkIds.includes(e.id)));assert.equal(f.gas.readConversation_('user-1',index(f).fingerprint).topicId,topic.id);
 }
});
