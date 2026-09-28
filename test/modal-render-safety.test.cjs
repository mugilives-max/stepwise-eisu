const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('application renderers must not append through innerHTML reassignment',()=>{for(const p of ['kanri/index.html','assets/portal.js'])assert.doesNotMatch(fs.readFileSync(p,'utf8'),/innerHTML\s*\+=/,p+' must preserve existing dialog nodes when appending');});
