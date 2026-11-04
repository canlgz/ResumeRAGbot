import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from './harness.mjs';

function fixture() {
  const f = createGas(), text = 'DEMO-IMG-7319 INPUT CHECK REPORT Validation sample count: 37';
  const index = { fingerprint: 'fresh', chunks: [{id:'S2', imageKey:'img', section:'測試作品（虛構）｜圖片 1（圖片辨識）', text:'圖片文字（轉寫）：\n'+text}],
    imageSources:[{imageKey:'img',section:'測試作品（虛構）｜圖片 1（圖片辨識）'}], imageTexts:{img:{transcription:text}} };
  const source = { fingerprint:'fresh', images:{img:{}} };
  f.gas.readPublicSource_ = () => source;
  f.gas.embedQuery_ = f.gas.generateAnswer_ = () => { throw new Error('must not regenerate known transcription'); };
  return {...f,index,source};
}
test('named image transcription returns indexed words and sources without model or feedback writes', () => {
  const f = fixture();
  const result = f.gas.answerResult_('請逐字列出測試作品三個彩色區塊內的英文文字',f.gas.config_(),null,null,f);
  assert.equal(result.status,'answered');
  assert.match(result.answerText,/INPUT CHECK REPORT/);
  assert.match(result.source,/圖片辨識/);
  assert.equal(f.state.documentWrites,0);
});
test('transcription respects removal, topic scope, ambiguity and corrected text', () => {
  const f=fixture(),run=chunks=>f.gas.imageTranscriptResult_('測試作品的英文文字',f.index,f.source,chunks,null);
  assert.equal(run([]),null);
  delete f.source.images.img; assert.equal(run(f.index.chunks),null); f.source.images.img={};
  f.index.imageSources.push({...f.index.imageSources[0]}); assert.equal(run(f.index.chunks),null); f.index.imageSources.pop();
  f.index.imageReviewedTexts={img:{transcription:'CORRECTED'}};
  assert.equal(run(f.index.chunks),null);
  f.index.chunks[0].text='CORRECTED'; assert.match(run(f.index.chunks).answerText,/CORRECTED/);
});
test('source changes before sending transcription block stale answers', () => {
  const f=fixture(); f.gas.readPublicSource_=()=>({fingerprint:'changed'});
  assert.equal(f.gas.answerResult_('測試作品的英文文字',f.gas.config_(),null,null,f).status,'stale');
});
