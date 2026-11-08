import test from 'node:test';
import assert from 'node:assert/strict';
import {event,assertFlexSane} from './harness.mjs';
import {portfolioFixture,paragraph,candidate} from './portfolio-fixture.mjs';

const JD='【AI 應用工程師】台北市內湖區\n年資 3 年以上，資訊相關科系\n必備：Python、SQL、REST API 串接經驗\n加分：Google Apps Script、資料視覺化\n月薪 55,000～75,000，混合辦公\n'+'工作內容：'.padEnd(820,'負責內部工具開發與維護。');

function fixture(){
  const f=portfolioFixture();
  f.nodes.splice(9,0,paragraph('姓名：陳沐言。具備四年三個月的營運資料分析與自動化經驗。'),
    paragraph('工作偏好：台北或新北地區，可接受混合辦公。'),
    paragraph('Python：使用 pandas 整理 CSV 與 Excel 資料，撰寫欄位檢查與排程腳本。'),
    paragraph('學校：青禾應用大學。科系：資訊管理學系，學士。'));
  const prior=f.state.response;
  f.state.response=call=>{
    const schema=call.body?.generationConfig?.responseSchema?.properties;
    if(schema?.jobs){
      const jobPosting=JSON.parse(call.body.contents[0].parts[0].text).jobPosting;
      const ai={title:'AI 應用工程師',location:'台北市內湖區',years:'3 年以上',education:'資訊相關科系',
        must:[{label:'Python',category:'技能'},{label:'SQL',category:'技能'},{label:'REST API',category:'經驗'}],nice:[{label:'Google Apps Script',category:'工具'},{label:'資料視覺化',category:'技能'},{label:'不存在的條件',category:'其他'}]};
      const second={title:'前端工程師',location:'高雄',years:'',education:'',must:[{label:'React',category:'技能'}],nice:[]};
      return candidate({jobs:jobPosting.includes('前端工程師')?[ai,second]:[ai]});
    }
    if(schema?.results){
      const payload=JSON.parse(call.body.contents[0].parts[0].text);
      const python=payload.evidence.find(e=>e.text.includes('pandas'));
      return candidate({results:payload.criteria.map(c=>c.label==='Python'?{id:c.id,status:'match',chunkId:python.id,quote:'使用 pandas 整理 CSV 與 Excel 資料',note:'履歷寫明 pandas 經驗'}
        :c.label==='SQL'?{id:c.id,status:'match',chunkId:python.id,quote:'精通 PostgreSQL 與 MySQL 多年',note:'捏造的引用'}
        :{id:c.id,status:'unknown',chunkId:'',quote:'',note:'履歷未提及'})});
    }
    return prior(call);
  };
  f.gas.syncKnowledgeBase();
  return f;
}
const post=(data,id)=>({...event('',id),type:'postback',postback:{data}});
const last=f=>{const m=f.state.calls.filter(c=>c.url.endsWith('/message/reply')).at(-1).body.messages;assertFlexSane(m);return m;};

test('paste flow: chooser → paste → result card straight away, with a review card to adjust conditions',()=>{
  const f=fixture(),cfg=f.gas.config_(),writes=f.state.documentWrites;
  f.gas.handleEvent_(post('jobmatch:start','s1'),cfg);
  const chooser=last(f)[0];assert.equal(chooser.type,'flex');assert.match(JSON.stringify(chooser),/直接貼上職缺/);
  f.gas.handleEvent_(post('jobmatch:paste','s2'),cfg);assert.match(last(f)[0].text,/貼上來/);
  assert(JD.length>800,'the fixture job posting must exceed the ordinary 800-character question limit');
  f.gas.handleEvent_(event(JD,'s3'),cfg);
  const result=last(f)[0],rj=JSON.stringify(result);
  assert.match(result.altText,/符合 4、待確認 4、不符 0/);
  const rows=result.contents.body.contents[4].contents.map(r=>JSON.stringify(r));
  assert.match(rows.find(r=>r.includes('台北市內湖區')),/✔/);assert.match(rows.find(r=>r.includes('台北市內湖區')),/台北或新北/);assert.match(rows.find(r=>r.includes('台北市內湖區')),/地點符合：/);
  assert.match(rows.find(r=>r.includes('3 年以上')),/年資符合：/);assert.match(rows.find(r=>r.includes('資訊相關科系')),/學歷符合：/);
  assert.match(rows.find(r=>r.includes('"Python"')),/技能符合：/);assert.match(rows.find(r=>r.includes('"REST API"')),/經驗待確認：/);assert.match(rows.find(r=>r.includes('Google Apps Script')),/工具待確認：/);
  assert.match(rows.find(r=>r.includes('3 年以上')),/✔/);assert.match(rows.find(r=>r.includes('3 年以上')),/四年三個月/);
  assert.match(rows.find(r=>r.includes('資訊相關科系')),/✔/);
  assert.match(rows.find(r=>r.includes('"Python"')),/✔/);assert.match(rows.find(r=>r.includes('"Python"')),/pandas/);
  assert.match(rows.find(r=>r.includes('"SQL"')),/？/);assert.match(rows.find(r=>r.includes('"SQL"')),/引用無法對回履歷/);
  assert(!rj.includes('PostgreSQL 與 MySQL'),'an unverifiable quote must never be shown');
  assert.match(rj,/薪資：面談確認/);assert.match(rj,/比對條件：台北市內湖區・3 年以上・資訊相關科系/);
  assert(!rj.includes('不存在的條件'),'parsed skills must be literal substrings of the job posting');
  f.gas.handleEvent_(post('jobmatch:review','s4b'),cfg);
  const review=last(f)[0],cj=JSON.stringify(review);assert.match(cj,/改好後再比一次/);assert.match(cj,/台北市內湖區/);assert.match(cj,/"Python"/);assert.match(cj,/Google Apps Script/);
  f.gas.handleEvent_(post(review.contents.footer.contents[0].action.data,'s4c'),cfg);
  assert.match(last(f)[0].altText,/符合 4、待確認 4、不符 0/);
  const questionsData=result.contents.footer.contents[0].action.data;
  f.gas.handleEvent_(post(questionsData,'s5'),cfg);
  const questions=last(f)[0].text;assert.match(questions,/技能｜SQL：履歷未提到/);assert.match(questions,/經驗｜REST API/);assert.match(questions,/薪資與到職日/);
  assert.equal(f.state.documentWrites,writes,'job postings must never be written to the Doc');
  assert(!f.state.calls.some(c=>c.url.endsWith(':generateContent')&&c.body.contents[0].parts[0].text.includes('待補充')));
});

test('step flow collects answers from buttons and text, allows skipping, and the location rule only compares cities',()=>{
  const f=fixture(),cfg=f.gas.config_();
  f.gas.handleEvent_(post('jobmatch:start','t1'),cfg);f.gas.handleEvent_(post('jobmatch:steps','t2'),cfg);
  assert.match(last(f)[0].text,/1 \/ 6/);
  f.gas.handleEvent_(event('資料分析師','t3'),cfg);assert.match(last(f)[0].text,/工作地點/);
  assert(last(f)[0].quickReply.items.some(i=>i.action.label==='新北'));
  f.gas.handleEvent_(post('jobmatch:answer:新北','t4'),cfg);
  f.gas.handleEvent_(post('jobmatch:answer:5 年以上','t5'),cfg);
  f.gas.handleEvent_(event('SQL, Python',"t6"),cfg);
  f.gas.handleEvent_(post('jobmatch:skip','t7'),cfg);
  f.gas.handleEvent_(post('jobmatch:answer:碩士以上','t8'),cfg);
  const result=last(f)[0];assert.match(result.altText,/符合 2、待確認 1、不符 2/);assert.match(JSON.stringify(result),/資料分析師/);
  const rows=result.contents.body.contents[4].contents.map(r=>JSON.stringify(r));
  assert.match(rows.find(r=>r.includes('"新北"')),/✔/);
  assert.match(rows.find(r=>r.includes('5 年以上')),/✘/);assert.match(rows.find(r=>r.includes('5 年以上')),/四年三個月/);
  assert.match(rows.find(r=>r.includes('碩士以上')),/✘/);
});

test('cancel and home leave no job state, redelivered events are not answered twice, and stale cards are refused',()=>{
  const f=fixture(),cfg=f.gas.config_();
  f.gas.handleEvent_(post('jobmatch:start','c1'),cfg);
  const replies=()=>f.state.calls.filter(c=>c.url.endsWith('/message/reply')).length,count=replies();
  f.gas.handleEvent_(post('jobmatch:start','c1'),cfg);assert.equal(replies(),count,'a redelivered event is not answered twice');
  f.gas.handleEvent_(post('jobmatch:cancel','c2'),cfg);assert.match(last(f)[0].text,/已取消/);
  const before=f.state.calls.length;
  f.gas.handleEvent_(event('台北市內湖區 AI 工程師 需要 Python 與 SQL','c3'),cfg);
  assert(f.state.calls.slice(before).some(c=>c.url.endsWith(':generateContent')),'after cancel, ordinary text goes back to resume Q&A');
  f.gas.handleEvent_(post('jobmatch:start','c4'),cfg);f.gas.handleEvent_(post('jobmatch:paste','c5'),cfg);
  f.gas.handleEvent_(event('首頁','c6'),cfg);assert.equal(last(f)[0].contents.type,'bubble');
  f.gas.handleEvent_(post('jobmatch:confirm:'+'a'.repeat(32),'c7'),cfg);assert.match(last(f)[0].text,/重新選擇「貼職缺比對」/);
});

test('a short paste switches to the step flow and the location/years/education rules handle missing resume data',()=>{
  const {gas}=portfolioFixture();
  assert.equal(gas.matchLocation_({label:'台北市內湖區'},['以 Google Apps Script 開發互動應用。']).status,'unknown');
  assert.equal(gas.matchLocation_({label:'高雄'},['工作偏好：台北或新北地區。']).status,'mismatch');
  assert.equal(gas.matchLocation_({label:'遠端'},['工作偏好：高雄。']).status,'match');
  assert.equal(gas.matchYears_({label:'三年以上'},['具備四年三個月的經驗。'],{years:'四年三個月'}).status,'match');
  assert.equal(gas.matchYears_({label:'3 年'},['沒有寫年資。'],{}).status,'unknown');
  assert.equal(gas.matchEducation_({label:'大學以上'},['學校：青禾應用大學。科系：資訊管理學系，學士。'],{school:'青禾應用大學'}).status,'match');
  assert.equal(gas.matchEducation_({label:'設計相關科系'},['學校：青禾應用大學。科系：資訊管理學系，學士。'],{}).status,'unknown');
  assert.equal(gas.parseYears_('2-4 年經驗'),2);assert.equal(gas.parseYears_('十年'),10);assert.equal(gas.parseYears_('不限'),null);
  assert.deepEqual([...gas.splitSkills_('Python、SQL, GAS；不限',8)],['Python','SQL','GAS']);
});

test('several postings in one paste: the visitor picks one, gets its result, and 再比一個 offers the rest',()=>{
  const f=fixture(),cfg=f.gas.config_();
  f.gas.handleEvent_(post('jobmatch:start','m1'),cfg);f.gas.handleEvent_(post('jobmatch:paste','m2'),cfg);
  f.gas.handleEvent_(event(JD+'\n\n【前端工程師】高雄 必備：React','m3'),cfg);
  const prompt=last(f)[0];assert.match(prompt.text,/我看到 2 個職缺/);assert.match(prompt.text,/2\. 前端工程師/);
  assert.deepEqual([...prompt.quickReply.items.map(i=>i.action.data).slice(0,2)],['jobmatch:pick:0','jobmatch:pick:1']);
  f.gas.handleEvent_(post('jobmatch:pick:1','m4'),cfg);
  const result=last(f)[0];assert.match(JSON.stringify(result.contents.header),/前端工程師/);assert.match(result.altText,/不符 1/);
  const rows=result.contents.body.contents[4].contents.map(r=>JSON.stringify(r));assert.match(rows.find(r=>r.includes('"高雄"')),/地點不符：/);
  f.gas.handleEvent_(post('jobmatch:restart','m5'),cfg);
  const again=last(f)[0];assert.match(again.text,/2\. 前端工程師（已比對）/);
  f.gas.handleEvent_(event('1','m6'),cfg);assert.match(JSON.stringify(last(f)[0].contents.header),/AI 應用工程師/);
});

test('when LINE rejects the result card, the same reply token gets a plain-text version of the results',()=>{
  const f=fixture(),cfg=f.gas.config_(),prior=f.state.response;
  let rejected=0;
  f.state.response=call=>{
    if(call.url.endsWith('/message/reply')&&call.body.messages.some(m=>m.type==='flex'&&/職缺比對結果/.test(m.altText||''))){rejected++;return {status:400,body:{message:'invalid'}};}
    return prior(call);
  };
  f.gas.handleEvent_(post('jobmatch:start','f1'),cfg);f.gas.handleEvent_(post('jobmatch:paste','f2'),cfg);
  f.gas.handleEvent_(event(JD,'f3'),cfg);
  const replies=f.state.calls.filter(c=>c.url.endsWith('/message/reply'));
  const sent=replies.at(-1).body.messages;
  assert.equal(replies.at(-2).body.messages[0].type,'flex');assert.equal(sent[0].type,'text');
  assert.match(sent[0].text,/符合 4・待確認 4/);assert.match(sent[0].text,/✔ 地點符合：台北市內湖區/);assert.match(sent[0].text,/？ 技能待確認：SQL/);
  assert(!JSON.stringify(replies.at(-2).body).includes('fallbackText'),'internal fallbackText must not be sent to LINE');
  f.gas.handleEvent_(event('產生面談問題','f4'),cfg);assert.match(last(f)[0].text,/面談問題/);
});
