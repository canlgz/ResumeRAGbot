import test from 'node:test';
import assert from 'node:assert/strict';
import { jobFixture } from './job-match-fixture.mjs';

const lineFetches = f => f.state.calls.filter(c => c.url.includes('api-data.line.me'));
const ocrCalls = f => f.state.calls.filter(c => c.body?.generationConfig?.responseSchema?.properties?.jobText);

test('screenshot in input stage is recognized once and appended as text', () => {
  const f = jobFixture({ jobText: { status: 'readable', jobText: '必要：熟悉 Python' } });
  f.send('jm:start', { postback: true }); const m = f.send('', { image: true });
  assert.equal(f.draft().imageCount, 1); assert.equal(f.draft().texts[0], '必要：熟悉 Python');
  assert.match(m[0].text, /1 張圖/);
  assert.equal(lineFetches(f).length, 1);
  assert.match(lineFetches(f)[0].url, /\/v2\/bot\/message\/img-\d+\/content$/);
  assert.equal(lineFetches(f)[0].headers.Authorization, 'Bearer test-line');
  assert.equal(ocrCalls(f).length, 1);
  const prompt = JSON.stringify(ocrCalls(f)[0].body.systemInstruction);
  assert.match(prompt, /不可信/); assert.match(prompt, /欄位：內容/);
  assert(ocrCalls(f)[0].body.contents[0].parts.some(p => p.inlineData?.mimeType === 'image/png'));
});

test('fourth screenshot is refused without fetching', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true });
  for (let i = 0; i < 3; i++) f.send('', { image: true });
  const m = f.send('', { image: true });
  assert.match(m[0].text, /最多 3 張/); assert.equal(lineFetches(f).length, 3); assert.equal(f.draft().imageCount, 3);
});

test('unreadable screenshot does not count and asks for text', () => {
  const f = jobFixture({ jobText: { status: 'unreadable', jobText: '' } });
  f.send('jm:start', { postback: true }); const m = f.send('', { image: true });
  assert.match(m[0].text, /看不清楚/); assert.equal(f.draft().imageCount, 0); assert.equal(f.draft().texts.length, 0);
});

test('unsupported image type or failed download is reported without AI', () => {
  for (const response of [{ status: 200, mime: 'image/gif', bytes: [1, 2, 3] }, { status: 404, body: {} }]) {
    const f = jobFixture({ response: call => call.url.includes('api-data.line.me') ? response : null });
    f.send('jm:start', { postback: true }); const m = f.send('', { image: true });
    assert.match(m[0].text, /截圖/); assert.equal(ocrCalls(f).length, 0); assert.equal(f.draft().imageCount, 0);
  }
});

test('image without a job draft keeps v2 reply and fetches nothing', () => {
  const f = jobFixture(); const m = f.send('', { image: true });
  assert.match(m[0].text, /請輸入文字問題/); assert.equal(lineFetches(f).length, 0);
});

test('screenshot after confirm stage is ignored with a hint', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.send('必要：熟悉 Python');
  f.send('jm:done:' + f.draft().id, { postback: true });
  const m = f.send('', { image: true });
  assert.equal(lineFetches(f).length, 0); assert.equal(f.draft().stage, 'confirm'); assert.equal(m[0].type, 'flex');
});

test('slow steps show the LINE loading animation', () => {
  const f = jobFixture(); f.send('jm:start', { postback: true }); f.send('必要：熟悉 Python');
  const loading = () => f.state.calls.filter(c => c.url.endsWith('/chat/loading/start')).length;
  f.send('jm:done:' + f.draft().id, { postback: true }); assert.equal(loading(), 1);
  f.send('jm:run:' + f.draft().id, { postback: true }); assert.equal(loading(), 2);
});
