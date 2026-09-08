'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createUI,card,slot,adminReady,flush}=require('./helpers/operations-ui-harness.cjs');
function context(extra={}){return {today:'2026-09-08',student:{id:'test-a',name:'【テスト】準備',active:true},slot:slot('slot-a',{status:'booked'}),record:null,preparation:null,previous:null,otherPrevious:[],openTasks:[],homeworkState:[],draft:null,pending:null,slotChanged:false,lessonChoices:[],...extra};}
async function preparation(c=context()){const ui=createUI('admin',{hash:'#lesson?student=test-a&slot=slot-a'});ui.requests[0].reply({ok:true,context:c});await flush();return ui;}
test('overview separates settings and loads each section only on navigation',async()=>{
 const legacy=createUI('admin',{local:new Map([['sw_kanri_c','legacy cached personal data']])});assert.equal(legacy.local.has('sw_kanri_c'),false);
 const ui=await adminReady(card({section:'overview'}));
 assert.equal(ui.requests[0].body.section,'overview');
 assert.equal(ui.html().includes('data-action="editfee"'),false); assert.equal(ui.html().includes('data-action="billing-preview"'),false);
 ui.navigate('#s=test-a&tab=settings');assert.equal(ui.requests.at(-1).body.section,'settings');
 ui.requests.at(-1).reply({data:card({section:'settings'})});await flush();
 assert.match(ui.html(),/data-action="editfee"/);assert.match(ui.html(),/家族設定/);assert.equal(ui.html().includes('data-action="offerslot"'),false);
 ui.click('editfee');ui.input('e-rate','2000');ui.input('e-monthly','0');ui.click('savefee');
 assert.equal(ui.requests.at(-1).body.section,'settings');const count=ui.requests.length;
 ui.requests.at(-1).reply({ok:true,data:card({section:'settings',rate30:2000})});await flush();assert.equal(ui.requests.length,count);
 assert.equal(ui.html().includes('data-action="offerslot"'),false);
});
test('a delayed settings write cannot replace the overview or invalidate its in-flight read',async()=>{
 const ui=await adminReady(card({section:'settings'}),'settings');ui.click('editfee');ui.input('e-rate','2000');ui.input('e-monthly','0');ui.click('savefee');const save=ui.requests.at(-1);
 ui.navigate('#s=test-a');const read=ui.requests.at(-1);
 save.reply({ok:true,data:card({section:'settings',rate30:2000})});await flush();
 // The act helper may refresh the destination after an unrelated write; answer the newest read.
 ui.requests.at(-1).reply({data:card({section:'overview'})});read.reply({data:card({section:'overview'})});await flush();
 assert.match(ui.html(),/data-action="offerslot"/);assert.equal(ui.html().includes('data-action="editfee"'),false);
});
test('future lessons expose a private preparation form, preserve its draft and retry the same write',async()=>{
 const c=context(),ui=await preparation(c);assert.match(ui.html(),/<h1>授業準備<\/h1>/);assert.equal(ui.html().includes('data-action="lc-save"'),false);
 ui.input('lc-preparation','PRIVATE_PREP_UI');assert.match(ui.el('lc-preparation-status').textContent,/未保存/);assert.equal(ui.beforeUnload(),true);ui.click('lc-prep-save');const first=ui.requests.at(-1),payload=structuredClone(first.body);
 assert.equal(payload.op,'lessonPreparationSave');assert.equal(payload.body,'PRIVATE_PREP_UI');assert.equal(payload.record,undefined);
 first.fail();await flush();assert.equal(ui.el('lc-preparation').disabled,true);ui.click('lc-retry');assert.deepEqual(ui.requests.at(-1).body,payload);
 ui.requests.at(-1).reply({ok:true,operation:'lessonPreparationSave',context:context({preparation:{body:'PRIVATE_PREP_UI',revision:1,...c.slot}})});await flush();
 assert.equal(ui.beforeUnload(),false);assert.equal(JSON.stringify([...ui.local,...ui.session,ui.logs]).includes('PRIVATE_PREP_UI'),false);
 ui.navigate('#home');ui.navigate('#lesson?student=test-a&slot=slot-a');assert.equal(ui.el('lc-preparation').value,'PRIVATE_PREP_UI');
});
test('preparation conflicts retain input and require explicit reconciliation before a new revision',async()=>{
 const ui=await preparation();ui.input('lc-preparation','手元の準備');ui.click('lc-prep-save');ui.requests.at(-1).reply({error:'版が変わりました',errorCode:'conflict'});await flush();
 ui.click('lc-refresh');ui.requests.at(-1).reply({ok:true,context:context({preparation:{body:'サーバーの準備',revision:2}})});await flush();
 assert.equal(ui.el('lc-preparation').value,'手元の準備');const count=ui.requests.length;ui.click('lc-prep-save');assert.equal(ui.requests.length,count);
 ui.click('lc-prep-rebase');ui.click('lc-prep-save');assert.equal(ui.requests.at(-1).body.expectedRevision,2);assert.equal(ui.requests.at(-1).body.body,'手元の準備');
});
test('today permits public records but does not copy private preparation into them',async()=>{
 const ui=await preparation(context({today:'2026-09-10',preparation:{body:'PRIVATE_PREP_UI',revision:1}}));
 assert.match(ui.html(),/data-action="lc-save"/);assert.equal(ui.el('lc-content').value,'');ui.input('lc-content','公開する記録');ui.click('lc-save');
 assert.equal(ui.requests.at(-1).body.op,'lessonRecordSave');assert.equal(JSON.stringify(ui.requests.at(-1).body).includes('PRIVATE_PREP_UI'),false);
});
test('unrecorded past lessons show a visible completion action separate from the record editor',async()=>{
 const ui=await adminReady(card({unrecordedLessons:[slot('old',{date:'2025-01-01',status:'booked',done:false})]}));
 assert.match(ui.html(),/実施状況の確認が必要/);ui.click('toggledone',{'data-id':'old'});assert.equal(ui.requests.at(-1).body.op,'toggleDone');assert.equal(ui.requests.at(-1).body.slotId,'old');
});
