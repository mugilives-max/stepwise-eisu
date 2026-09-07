import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const begin = '// BEGIN GENERATED PARENT CRYPTO';
const end = '// END GENERATED PARENT CRYPTO';
const result = await build({entryPoints:['scripts/parent-crypto-entry.js'], bundle:true,
  platform:'browser', format:'iife', globalName:'StepwiseParentCrypto', target:'es2020',
  minify:true, write:false, legalComments:'inline'});
const generated = `${begin}\n// @noble/hashes 1.8.0 (MIT), see gas/THIRD_PARTY_LICENSES.md. Regenerate: npm run build:crypto\n${result.outputFiles[0].text.trim()}\n${end}`;
const path = 'gas/Code.gs';
const old = readFileSync(path,'utf8').replace(/\r\n/g,'\n');
const start = old.indexOf(begin), finish = old.indexOf(end);
if ((start === -1) !== (finish === -1)) throw Error('Incomplete generated block');
writeFileSync(path, start < 0 ? `${old.trimEnd()}\n\n${generated}\n` : old.slice(0,start) + generated + old.slice(finish+end.length));
