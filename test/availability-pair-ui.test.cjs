'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,card,slot,state,adminReady,studentReady,flush}=require('./helpers/operations-ui-harness.cjs');
async function wishUI(){const ui=await studentReady({...state(),me:{name:'【テスト】希望',deliveryMode:'in_person'}});ui.navigate('#schedule');ui.click('panel',{'data-p':'wish'});ui.click('wkind',{'data-k':'want'});ui.input('f-wdate','2026-09-10');ui.input('f-wstart','13:00');ui.input('f-wmin','60');ui.input('f-wnote','化学を希望');return ui;}
const result=(status='available')=>({ok:true,days:[{date:'2026-09-10',status,firstStart:status==='available'?'13:00':undefined}]});
test('a full wish is explained before an explicit send and still can be sent for adjustment',async()=>{
 const ui=await wishUI();ui.click('addwish');assert.equal(ui.requests.at(-1).body.action,'wishAvailability');assert.equal(ui.requests.at(-1).body.deliveryMode,'in_person');
 ui.requests.at(-1).reply(result('full'));await flush();assert.match(ui.html(),/現在は満員・要調整/);assert.match(ui.html(),/希望を送る/);assert.equal(ui.requests.length,2);
 ui.click('wish-confirm');const req=ui.requests.at(-1).body;assert.equal(req.action,'wish');assert.equal(req.note,'化学を希望');assert.deepEqual(req.availabilitySeen,[{date:'2026-09-10',status:'full'}]);
 ui.requests.at(-1).reply({ok:true,state:state()});await flush();assert.equal(ui.html().includes('授業希望の空き状況'),false);
});
test('a changed availability response replaces the visible result and cannot silently send a normal wish',async()=>{
 const ui=await wishUI();ui.click('addwish');ui.requests.at(-1).reply(result());await flush();ui.click('wish-confirm');
 ui.requests.at(-1).reply({error:'空き状況が変わりました',errorCode:'availabilityChanged',availability:result('full')});await flush();assert.match(ui.html(),/満員/);const count=ui.requests.length;assert.equal(count,3);
 ui.click('wish-confirm');assert.equal(ui.requests.at(-1).body.availabilitySeen[0].status,'full');
});
test('failed availability checks retain the form and ambiguous sends retain the exact payload',async()=>{
 const ui=await wishUI();ui.click('addwish');ui.requests.at(-1).fail();await flush();ui.click('wish-back');assert.equal(ui.el('f-wdate').value,'2026-09-10');assert.equal(ui.el('f-wnote').value,'化学を希望');
 ui.click('addwish');ui.requests.at(-1).reply(result());await flush();ui.click('wish-confirm');const payload=structuredClone(ui.requests.at(-1).body);ui.requests.at(-1).fail();await flush();ui.click('wish-confirm');assert.deepEqual(ui.requests.at(-1).body,payload);
});
test('a stale availability response for a different student never appears in their page',async()=>{
 const ui=await wishUI();ui.click('addwish');const old=ui.requests.at(-1);ui.switchStudent('another-link');ui.requests.at(-1).reply(state([], '【テスト】別生徒'));await flush();old.reply(result('full'));await flush();assert.equal(ui.html().includes('現在は満員'),false);
});
test('multi-day flexible wishes check the selected duration and mode for every chosen day',async()=>{
 const ui=await wishUI();ui.click('wkind',{'data-k':'ok'});ui.click('selstart',{'data-m':'wish'});ui.click('calday',{'data-date':'2026-09-10'});ui.click('calday',{'data-date':'2026-09-11'});
 ui.input('b-wmode','online');ui.input('b-wstart','13:00');ui.input('b-wend','16:00');ui.input('b-wmin','90');ui.click('selapply');
 const body=ui.requests.at(-1).body;assert.equal(body.action,'wishAvailability');assert.equal(body.kind,'ok');assert.equal(body.deliveryMode,'online');assert.equal(body.min,90);assert.deepEqual(body.dates,['2026-09-10','2026-09-11']);
 ui.requests.at(-1).reply({ok:true,days:[{date:'2026-09-10',status:'full'},{date:'2026-09-11',status:'available',firstStart:'14:00'}]});await flush();assert.match(ui.html(),/14:00開始/);ui.click('wish-confirm');assert.equal(ui.requests.at(-1).body.action,'wishMany');assert.equal(ui.requests.at(-1).body.availabilitySeen.length,2);
});
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
