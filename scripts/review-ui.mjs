import { readFile, writeFile } from 'node:fs/promises';
const html = await readFile(new URL('../web/image-review.html', import.meta.url), 'utf8');
const source = '/**\n * 【圖片校對頁：自動產生的 HTML】\n * 來源為 web/image-review.html，請修改來源後執行 npm run bundle。\n * 學生單檔安裝已包含此頁，不須在 GAS 另外建立 HTML 檔案。\n */\nfunction reviewHtml_() { return ' + JSON.stringify(html) + '; }\n';
const target = new URL('../gas/ReviewUi.gs', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== source) throw new Error('ReviewUi.gs is stale. Run npm run bundle.');
  console.log('Image review UI matches its HTML source.');
} else await writeFile(target, source);
