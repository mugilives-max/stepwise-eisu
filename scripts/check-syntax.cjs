const fs = require('node:fs');
const vm = require('node:vm');
for (const file of ['gas/Code.gs','test/gas-native-auth-check.gs']) {
  new vm.Script(fs.readFileSync(file,'utf8'), {filename:file});
}
for (const file of ['kanri/index.html','yoyaku/index.html']) {
  const html = fs.readFileSync(file,'utf8');
  for (const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], {filename:`${file}:script${i}`});
  }
}
console.log('GAS, native verification helper and both application scripts: syntax OK');
