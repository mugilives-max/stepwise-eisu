const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,flush,card,line}=require('./helpers/operations-ui-harness.cjs');
for(const count of [1,2])test('overlap offers explicit parent selection and retains inputs: '+count,async()=>{
 const parents=Array.from({length:count},(_,i)=>line({id:'parent-'+i,status:'approved'}));
 const ui=createUI('admin',{hash:'#plans?student=test-a'});ui.requests[0].reply({data:card({plan:{lines:parents,defaultRows:[]}})});await flush();ui.click('pe-new');
 ui.input('pe-subject','英語');ui.input('pe-start','2026-09-01');ui.input('pe-end','2026-09-30');ui.input('pe-count','2');ui.input('pe-comment','追加演習');
 const n=ui.requests.length;ui.click('pe-send');assert.equal(ui.requests.length,n);assert.match(ui.html(),/2回を追加して案内する/);
 ui.click('pe-addition-send',{'data-line':'parent-'+(count-1)});const r=ui.requests.at(-1).body;assert.equal(r.op,'planLineSave');assert.equal(r.parentId,'parent-'+(count-1));assert.equal(r.count,2);assert.equal(r.comment,'追加演習');assert.equal(r.startDate,'2026-09-01');assert.equal(r.propose,true);assert.equal(r.lineId,undefined);
});

test('plan details open an addition without editing the original',async()=>{const parent=line({id:'parent',status:'approved',count:14});const ui=createUI('admin',{hash:'#plans?student=test-a'});ui.requests[0].reply({data:card({plan:{lines:[parent],defaultRows:[]}})});await flush();ui.click('plan-detail',{'data-line':'parent'});assert.match(ui.html(),/追加の計画を作成/);ui.click('pe-addon');ui.input('pe-count','2');ui.input('pe-comment','追加の演習');ui.click('pe-send');const r=ui.requests.at(-1).body;assert.equal(r.parentId,'parent');assert.equal(r.lineId,undefined);assert.equal(r.count,2);assert.equal(r.propose,true);assert.equal(parent.count,14);});

test('inline kind creation retains plan and selects new kind',async()=>{const ui=createUI('admin',{hash:'#plans?student=test-a'});ui.requests[0].reply({data:card()});await flush();ui.click('pe-new');ui.input('pe-count','8');ui.input('pe-comment','演習');ui.click('pe-kind-add');ui.input('pe-kind-name','夏期講習');ui.click('pe-kind-save');assert.equal(ui.requests.at(-1).body.op,'lessonKinds');ui.requests.at(-1).reply({lessonKinds:[{name:'通常'}]});await flush();assert.equal(ui.requests.at(-1).body.op,'lessonKindSave');assert.equal(ui.requests.at(-1).body.name,'夏期講習');ui.requests.at(-1).reply({lessonKinds:[{name:'通常'},{name:'夏期講習'}]});await flush();assert.equal(ui.el('pe-kind').value,'夏期講習');assert.equal(ui.el('pe-count').value,'8');assert.equal(ui.el('pe-comment').value,'演習');});
