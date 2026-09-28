'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createUI, flush} = require('./helpers/operations-ui-harness.cjs');
const items = () => [
  {itemId:'hw-1', title:'ワーク p21', type:'宿題', dueMode:'nextLesson', due:''},
  {itemId:'hw-2', title:'ワーク p22', type:'宿題', dueMode:'date', due:'2026-09-30'},
  {itemId:'hw-3', title:'ドリル p7〜10', type:'宿題', dueMode:'none', due:''}
];
async function ready(homework=items(), extra={}) {
  const ui=createUI('admin',{hash:'#lesson?student=test-a&slot=slot-a'});
  ui.requests[0].reply({ok:true,context:{today:'2026-09-22',student:{id:'test-a',name:'【テスト】生徒',active:true},slot:{id:'slot-a',date:'2026-09-22',start:'13:00',min:60,subject:'数学',status:'booked',done:true},record:{id:'record-a',revision:1,status:'active',content:'授業の報告',homework},previous:null,otherPrevious:[],openTasks:[],homeworkState:[],draft:null,pending:null,slotChanged:false,...extra}});
  await flush(); return ui;
}
test('homework uses labeled table fields with optional reusable material',async()=>{
 const ui=await ready(items(),{materials:['テスト教材']});
 assert.match(ui.html(),/lc-homework-table/);assert.match(ui.html(),/<option value="テスト教材">/);
 assert.equal(ui.el('lc-title-2').getAttribute('aria-label'),'宿題 3 の内容');
 assert.equal(ui.beforeUnload(),false);
 ui.input('lc-material-0','新しい教材');ui.input('lc-title-0','p12〜15');ui.input('lc-due-1','2026-10-01');ui.input('lc-due-mode-2','nextLesson');
 ui.click('lc-publish');const req=ui.requests.at(-1),hw=req.body.record.homework;
 assert.equal(hw[0].material,'新しい教材');assert.equal(hw[0].title,'p12〜15');assert.equal(hw[1].due,'2026-10-01');assert.equal(hw[2].dueMode,'nextLesson');
 req.fail();await flush();assert.equal(ui.el('lc-material-0').value,'新しい教材');ui.click('lc-retry');assert.deepEqual(ui.requests.at(-1).body,req.body);
});

test('removing a row preserves neighbors, restores focus and requires another share preview',async()=>{
  const ui=await ready();
  ui.click('lc-remove',{'data-item':'hw-2'});
  assert.equal(ui.el('lc-share-confirm'),undefined); assert.equal(ui.requests.length,1);
  assert.equal(ui.focused(),'lc-title-1'); assert.equal(ui.el('lc-title-1').value,'ドリル p7〜10');
  ui.click('lc-publish'); assert.deepEqual(Array.from(ui.requests.at(-1).body.record.homework,x=>x.itemId),['hw-1','hw-3']);
  assert.equal(ui.requests.length,2,'removing from the report must not withdraw a published task');
});
test('read-only records show compact deadline summaries without actionable edit menus',async()=>{
  const ui=await ready(items(),{slotChanged:true});
  assert.equal(ui.el('lc-title-0').disabled,true);
  assert.doesNotMatch(ui.html(),/data-lc-menu|data-action="lc-duetoggle"|data-action="lc-remove"/);
  assert.equal(ui.el('lc-due-1').value,'2026-09-30');
  assert.equal(ui.el('lc-material-0').disabled,true);
});
