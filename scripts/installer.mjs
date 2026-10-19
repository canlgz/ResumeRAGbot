import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const [template, code, manifest, pkg] = await Promise.all([
  readFile(new URL('scripts/installer-template.html', root), 'utf8'),
  readFile(new URL('dist/Code.gs', root), 'utf8'),
  readFile(new URL('gas/appsscript.json', root), 'utf8'),
  readFile(new URL('package.json', root), 'utf8').then(JSON.parse)
]);
// Embedded source must remain data even when a later GAS file contains HTML strings.
const data = JSON.stringify({ code, manifest }).replace(/</g, '\\u003c');
const html = template.replaceAll('__VERSION__', pkg.version).replace('__INSTALL_DATA__', () => data);
const target = new URL('START_HERE.html', root);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== html) throw new Error('START_HERE.html is stale. Run npm run bundle.');
  console.log('Offline installer matches source, manifest and package version.');
} else {
  await writeFile(target, html);
  console.log('Created START_HERE.html for browser-only student installation.');
}
