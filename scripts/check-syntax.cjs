const fs = require('node:fs');
const vm = require('node:vm');
for (const file of [...fs.readdirSync('gas').filter(f=>f.endsWith('.gs')).map(f=>'gas/'+f),...fs.readdirSync('test').filter(f=>/^gas-native-.*\.gs$/.test(f)).map(f=>'test/'+f)]) {
  new vm.Script(fs.readFileSync(file,'utf8'), {filename:file});
}
for (const file of ['kanri/index.html','yoyaku/index.html']) {
  const html = fs.readFileSync(file,'utf8');
  for (const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], {filename:`${file}:script${i}`});
  }
}
console.log('GAS, native verification helper and both application scripts: syntax OK');
