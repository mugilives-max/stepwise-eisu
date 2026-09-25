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
test('homework rows keep accessible names but no repeated heading or expanded deadline controls',async()=>{
  const ui=await ready();
  const group=ui.html().split('<div class="lc-hwgroup">')[1].split('<aside')[0];
  assert.equal((group.match(/基本の期限：/g)||[]).length,1);
  assert.doesNotMatch(group,/<label for="lc-title-|＋ 期限を設定|<select|<details[^>]* open/);
  assert.match(group,/data-lc-menu><summary[^>]*aria-label="宿題 1 の操作"/);
  assert.equal(ui.el('lc-title-2').getAttribute('aria-label'),'宿題 3 の内容');
  assert.match(group,/期限：2026-09-30/); assert.match(group,/期限なし/);
  assert.equal(ui.requests.length,1);
  assert.equal(ui.beforeUnload(),false,'only viewing options must not dirty the saved report');
});
test('individual deadline edit preserves text and other items, closes compactly, and serializes unchanged IDs',async()=>{
  const ui=await ready(); ui.input('lc-title-0','変更した宿題');
  ui.click('lc-duetoggle',{'data-item':'hw-2'});
  assert.equal(ui.focused(),'lc-due-mode-1'); assert.equal(ui.el('lc-due-1').value,'2026-09-30');
  ui.input('lc-due-1','2026-10-01'); ui.click('lc-dueclose',{'data-item':'hw-2'});
  assert.equal(ui.el('lc-due-1'),undefined); assert.equal(ui.focused(),'lc-hw-more-1');
  assert.match(ui.html(),/期限：2026-10-01/); assert.equal(ui.el('lc-title-0').value,'変更した宿題');
  ui.click('lc-duetoggle',{'data-item':'hw-3'}); ui.input('lc-due-mode-2','nextLesson');
  assert.equal(ui.focused(),'lc-due-mode-2'); ui.click('lc-dueclose',{'data-item':'hw-3'});
  ui.click('lc-publish');
  const saved=ui.requests.at(-1).body.record.homework;
  assert.deepEqual(JSON.parse(JSON.stringify(saved)),[
    {...items()[0],title:'変更した宿題'}, {...items()[1],due:'2026-10-01'}, {...items()[2],dueMode:'nextLesson'}
  ]);
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
  assert.match(ui.html(),/期限：2026-09-30/);
});
