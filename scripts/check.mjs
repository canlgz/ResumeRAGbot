import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const names = (await readdir(new URL('../gas/', import.meta.url))).filter(n => n.endsWith('.gs')).sort();
for (const name of names) new vm.Script(await readFile(new URL('../gas/' + name, import.meta.url), 'utf8'), { filename: name });
const manifest = JSON.parse(await readFile(new URL('../gas/appsscript.json', import.meta.url), 'utf8'));
assert.equal(manifest.runtimeVersion, 'V8');
assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
console.log(`${names.length} Apps Script files and manifest validated.`);
