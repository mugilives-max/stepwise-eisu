const test=require('node:test'),assert=require('node:assert/strict');
const {adminReady,card,flush}=require('./helpers/operations-ui-harness.cjs');
test('student overview shows open homework and confirms completion in a modal',async()=>{
 const c=card({tasks:[{id:'open',title:'【テスト】課題',type:'宿題',due:'2026-09-10',dueSubject:'英語'},{id:'done',title:'完了済課題',done:true},{id:'memo',title:'メモ課題',type:'メモ'}]});
 const ui=await adminReady(c);assert.doesNotMatch(ui.html(),/授業履歴|完了済課題|メモ課題/);assert.match(ui.html(),/あと2日/);
 ui.click('homework-open',{'data-id':'open'});assert.equal(ui.requests.length,1);assert.match(ui.html(),/宿題の完了登録/);
 ui.click('homework-confirm');assert.equal(ui.requests.at(-1).body.op,'taskDone');assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.taskId,'open');assert.equal(ui.requests.at(-1).body.done,true);
 ui.requests.at(-1).reply({data:card({tasks:[{...c.tasks[0],done:true}]})});await flush();assert.match(ui.html(),/未完了の宿題はありません/);assert.doesNotMatch(ui.html(),/id="admin-homework-dialog"/);
});
