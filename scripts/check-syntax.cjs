const fs = require('node:fs');
const vm = require('node:vm');
new vm.Script(fs.readFileSync('gas/Code.gs','utf8'), {filename:'gas/Code.gs'});
for (const file of ['kanri/index.html','yoyaku/index.html']) {
  const html = fs.readFileSync(file,'utf8');
  for (const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(match[1], {filename:`${file}:script${i}`});
  }
}
console.log('GAS and both application scripts: syntax OK');
