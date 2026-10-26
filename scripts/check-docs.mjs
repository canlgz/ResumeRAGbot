import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createGas } from '../test/harness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['README.md', 'CHANGELOG.md', ...(await readdir(path.join(root, 'docs')))
  .filter(name => name.endsWith('.md') && name !== '交付狀態.md').map(name => 'docs/' + name)];
let links = 0;
for (const name of files) {
  const text = await readFile(path.join(root, name), 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const url = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) continue;
    const target = decodeURIComponent(url.split('#')[0]);
    await access(path.resolve(root, path.dirname(name), target));
    links++;
  }
}
const sample = await readFile(path.join(root, 'docs/模擬履歷_陳沐言_AI自動化工程師.txt'), 'utf8');
assert.equal(createGas().gas.starterResumeText_(), sample, 'StarterResume.gs must match the documented sample.');
console.log(`${files.length} Markdown files, ${links} local links and starter resume consistency checked.`);
