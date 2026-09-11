'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,card,slot,state,adminReady,studentReady,flush}=require('./helpers/operations-ui-harness.cjs');
test('teachers see the stored adjustment warning and inherit the requested format and duration',async()=>{
 const ui=await adminReady(card({wishes:[{id:'wish',studentId:'test-a',date:'2026-09-10',start:'13:00',end:'16:00',kind:'ok',duration:45,deliveryMode:'in_person',availability:'full'}]}));
 assert.match(ui.html(),/送信時：満員・要調整/);ui.click('usewish',{'data-id':'wish'});assert.equal(ui.el('f-delivery').value,'in_person');assert.equal(ui.el('f-min').value,'45');
});
function ctx(id,extra={}){return {today:'2026-09-10',student:{id,name:'【テスト】'+id,active:true},slot:slot('slot-'+id,{date:'2026-09-10',start:'13:00',status:'booked'}),record:null,preparation:null,previous:null,otherPrevious:[],openTasks:[],homeworkState:[],draft:null,pending:null,slotChanged:false,lessonChoices:[],...extra};}
const key=id=>'#lesson?student='+id+'&slot=slot-'+id;
async function pairUI(){const ui=createUI('admin',{hash:'#lesson-pair?slot=slot-test-a'});assert.equal(ui.requests[0].body.op,'lessonPairContext');ui.requests[0].reply({ok:true,contexts:[ctx('test-a'),ctx('test-b')],choices:[{slotId:'slot-test-b',studentId:'test-b',name:'【テスト】B'}]});await flush();return ui;}
test('paired records keep identities and field IDs separate and do not redraw the other editor during a save',async()=>{
 const ui=await pairUI();assert.match(ui.el('pair-pane-0').innerHTML,/【テスト】test-a/);assert.match(ui.el('pair-pane-1').innerHTML,/【テスト】test-b/);
 ui.input('pair-0-lc-content','Aの記録');ui.input('pair-1-lc-content','Bの記録');const fieldB=ui.el('pair-1-lc-content');
 ui.click('lc-save',{'data-lc-editor':key('test-a')});const req=ui.requests.at(-1);assert.equal(req.body.studentId,'test-a');assert.equal(req.body.record.content,'Aの記録');assert.equal(ui.el('pair-1-lc-content'),fieldB);
 ui.input('pair-1-lc-content','Bは入力を継続');req.reply({ok:true,operation:'lessonRecordSave',context:ctx('test-a',{record:{id:'ra',revision:1,content:'Aの記録',publishedRevision:1,status:'active',homework:[]}})});await flush();
 assert.equal(ui.el('pair-1-lc-content'),fieldB);assert.equal(fieldB.value,'Bは入力を継続');assert.equal(ui.beforeUnload(),true);
 ui.click('lc-save',{'data-lc-editor':key('test-b')});assert.equal(ui.requests.at(-1).body.studentId,'test-b');assert.equal(ui.requests.at(-1).body.record.content,'Bは入力を継続');
});
test('a failed paired save retries its own request while the other student saves independently',async()=>{
 const ui=await pairUI();ui.input('pair-0-lc-content','Aの記録');ui.click('lc-save',{'data-lc-editor':key('test-a')});const a=ui.requests.at(-1),payload=structuredClone(a.body);a.fail();await flush();
 ui.input('pair-1-lc-content','Bの記録');ui.click('lc-save',{'data-lc-editor':key('test-b')});const b=ui.requests.at(-1);assert.equal(b.body.studentId,'test-b');
 ui.click('lc-retry',{'data-lc-editor':key('test-a')});assert.deepEqual(ui.requests.at(-1).body,payload);assert.notEqual(payload.requestId,b.body.requestId);
 ui.navigate('#home');ui.navigate('#lesson-pair?slot=slot-test-a');assert.equal(ui.el('pair-0-lc-content').value,'Aの記録');assert.equal(ui.el('pair-1-lc-content').value,'Bの記録');
 assert.equal(JSON.stringify([...ui.local,...ui.session]).includes('Aの記録'),false);
});
test('paired preparation and homework stay in the selected student editor',async()=>{
 const ui=await pairUI();ui.input('pair-1-lc-preparation','Bの非公開準備');ui.click('lc-prep-save',{'data-lc-editor':key('test-b')});assert.equal(ui.requests.at(-1).body.studentId,'test-b');assert.equal(ui.requests.at(-1).body.body,'Bの非公開準備');
 ui.click('lc-add',{'data-lc-editor':key('test-a')});ui.input('pair-0-lc-content','A授業');ui.input('pair-0-lc-title-0','A宿題');ui.input('pair-0-lc-due-mode-0','date');ui.input('pair-0-lc-due-0','2026-09-12');ui.click('lc-save',{'data-lc-editor':key('test-a')});
 assert.equal(ui.requests.at(-1).body.record.homework[0].title,'A宿題');assert.equal(JSON.stringify(ui.requests.at(-1).body).includes('Bの非公開準備'),false);
});
