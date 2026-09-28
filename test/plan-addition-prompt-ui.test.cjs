const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,flush,card,line}=require('./helpers/operations-ui-harness.cjs');
for(const count of [1,2])test('overlap offers explicit parent selection and retains inputs: '+count,async()=>{
 const parents=Array.from({length:count},(_,i)=>line({id:'parent-'+i,status:'approved'}));
 const ui=createUI('admin',{hash:'#plans?student=test-a'});ui.requests[0].reply({data:card({plan:{lines:parents,defaultRows:[]}})});await flush();ui.click('pe-new');
 ui.input('pe-subject','英語');ui.input('pe-start','2026-09-01');ui.input('pe-end','2026-09-30');ui.input('pe-count','2');ui.input('pe-comment','追加演習');
 const n=ui.requests.length;ui.click('pe-send');assert.equal(ui.requests.length,n);assert.match(ui.html(),/2回を追加して案内する/);
 ui.click('pe-addition-send',{'data-line':'parent-'+(count-1)});const r=ui.requests.at(-1).body;assert.equal(r.op,'planLineSave');assert.equal(r.parentId,'parent-'+(count-1));assert.equal(r.count,2);assert.equal(r.comment,'追加演習');assert.equal(r.startDate,'2026-09-01');assert.equal(r.propose,true);assert.equal(r.lineId,undefined);
});
