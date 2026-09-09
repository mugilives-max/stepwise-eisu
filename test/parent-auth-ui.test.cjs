const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const harness=fs.readFileSync(path.join(__dirname,'operations-ui.test.cjs'),'utf8').split('\ntest(')[0];
const {createUI}=new Function('require','__dirname',harness+'\nreturn {createUI};')(require,__dirname);
test('old parent links show only email-based parent login',()=>{for(const hash of ['#parent','#parent/billing']){const ui=createUI('student',{hash});assert.match(ui.html(),/family-auth-form/);assert.ok(!ui.html().includes('f-ppass'));assert.ok(!ui.html().includes('従来の'));assert.equal(ui.requests.length,0);}});
