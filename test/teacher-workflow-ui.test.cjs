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
 assert.equal(ui.html().includes('data-action="offerslot"'),false);
 // 料金の設定は 2026-09-23 に生徒設定から「月間計画・請求」へ移った（3cd9a95）
 ui.navigate('#s=test-a&tab=billing');assert.equal(ui.requests.at(-1).body.section,'billing');
 ui.requests.at(-1).reply({data:card({section:'billing'})});await flush();
 assert.match(ui.html(),/data-action="editfee"/);assert.equal(ui.html().includes('data-action="offerslot"'),false);
 ui.click('editfee');ui.input('e-rate','2000');assert.equal(ui.html().includes('id="e-monthly"'),false);ui.click('savefee');
 assert.equal(ui.requests.at(-1).body.op,'setFee');assert.equal(ui.requests.at(-1).body.rate30,2000);assert.equal(ui.requests.at(-1).body.section,'billing');const count=ui.requests.length;
 ui.requests.at(-1).reply({ok:true,data:card({section:'billing',rate30:2000})});await flush();assert.equal(ui.requests.length,count);
 assert.equal(ui.html().includes('data-action="offerslot"'),false);
});
test('a delayed settings write cannot replace the overview or invalidate its in-flight read',async()=>{
 // 料金の設定は「月間計画・請求」にある（3cd9a95）
 const ui=await adminReady(card({section:'billing'}),'billing');ui.click('editfee');ui.input('e-rate','2000');assert.equal(ui.html().includes('id="e-monthly"'),false);ui.click('savefee');const save=ui.requests.at(-1);
 ui.navigate('#s=test-a');const read=ui.requests.at(-1);
 save.reply({ok:true,data:card({section:'billing',rate30:2000})});await flush();
 // The act helper may refresh the destination after an unrelated write; answer the newest read.
 ui.requests.at(-1).reply({data:card({section:'overview'})});read.reply({data:card({section:'overview'})});await flush();
 assert.match(ui.html(),/data-action="sdayadd"/);assert.equal(ui.html().includes('data-action="editfee"'),false);
});
// 授業準備の欄は 2026-09-23 に廃止（1fe7ded）。未来の授業の記録ページは授業一覧へ戻し、非公開の準備は表示も保存もしない
test('future lessons return to the lesson list without exposing the retired preparation form',async()=>{
 const ui=await preparation(context({preparation:{body:'PRIVATE_PREP_UI',revision:1}}));
 assert.equal(ui.location.hash,'#lessons');assert.equal(ui.html().includes('PRIVATE_PREP_UI'),false);assert.doesNotMatch(ui.html(),/data-action=.lc-(prep-save|publish|keep)/);
 assert.equal(ui.requests.length,1);assert.equal(JSON.stringify([...ui.local,...ui.session,ui.logs]).includes('PRIVATE_PREP_UI'),false);
});
test('today permits public records but does not copy private preparation into them',async()=>{
 const ui=await preparation(context({today:'2026-09-10',preparation:{body:'PRIVATE_PREP_UI',revision:1}}));
 // 授業準備の欄は廃止（1fe7ded）だが、保存済みの準備は文脈に残る。公開する記録へ写さない
 assert.match(ui.html(),/data-action="lc-publish"/);assert.equal(ui.el('lc-preparation'),undefined);assert.equal(ui.el('lc-content').value,'');ui.input('lc-content','公開する記録');ui.click('lc-publish');
 assert.equal(ui.requests.at(-1).body.op,'lessonRecordSave');assert.equal(JSON.stringify(ui.requests.at(-1).body).includes('PRIVATE_PREP_UI'),false);
});
test('unrecorded past lessons show a visible completion action separate from the record editor',async()=>{
 const ui=await adminReady(card({unrecordedLessons:[slot('old',{date:'2025-01-01',status:'booked',done:false})]}));
 assert.match(ui.html(),/実施状況の確認が必要/);ui.click('toggledone',{'data-id':'old'});assert.equal(ui.requests.at(-1).body.op,'toggleDone');assert.equal(ui.requests.at(-1).body.slotId,'old');
});
