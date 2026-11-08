import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
const order = ['Config', 'StarterResume', 'PortfolioStore', 'QuickTopics', 'Knowledge', 'Images', 'Portfolio', 'Conversation', 'Gemini', 'Feedback', 'Line', 'OwnerLine', 'Contact', 'JobMatch', 'Chat', 'Review', 'ReviewUi', 'Webhook', 'Admin'];
// 新增 .gs 檔卻忘了排進單檔安裝包，學生貼上後會缺函式；這裡直接擋下。
const present = (await readdir(new URL('../gas/', import.meta.url))).filter(n => n.endsWith('.gs')).map(n => n.replace(/\.gs$/, ''));
const missing = present.filter(n => !order.includes(n));
if (missing.length) throw new Error('bundle order is missing: ' + missing.join(', '));
const pieces = await Promise.all(order.map(async name => `// ===== ${name}.gs =====\n` + await readFile(new URL(`../gas/${name}.gs`, import.meta.url), 'utf8')));
const bundled = '// ResumeRAGbot — generated with npm run bundle\n\n' + pieces.join('\n\n');
const target = new URL('../dist/Code.gs', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== bundled) throw new Error('dist/Code.gs is stale. Run npm run bundle.');
  console.log('Single-file installer matches gas/ sources.');
} else {
  await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
  await writeFile(target, bundled);
  console.log('Created dist/Code.gs for single-file copy/paste installation.');
}
