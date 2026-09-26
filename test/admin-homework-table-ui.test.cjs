const test=require('node:test'),assert=require('node:assert/strict');
const {adminReady,card,flush}=require('./helpers/operations-ui-harness.cjs');
test('student overview shows open homework and confirms completion in a modal',async()=>{
 const c=card({tasks:[{id:'open',title:'【テスト】課題',type:'宿題',due:'2026-09-10',dueSubject:'英語'},{id:'done',title:'完了済課題',done:true,reviewedAt:'2026-09-08'},{id:'memo',title:'メモ課題',type:'メモ'}]});
 const ui=await adminReady(c);assert.doesNotMatch(ui.html(),/授業履歴|完了済課題|メモ課題/);assert.match(ui.html(),/あと2日/);
 ui.click('homework-open',{'data-id':'open'});assert.equal(ui.requests.length,1);assert.match(ui.html(),/宿題の確認/);
 ui.click('homework-confirm');assert.equal(ui.requests.at(-1).body.op,'taskDone');assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.taskId,'open');assert.equal(ui.requests.at(-1).body.done,true);
 ui.requests.at(-1).reply({data:card({tasks:[{...c.tasks[0],done:true,reviewedAt:'2026-09-08'}]})});await flush();assert.match(ui.html(),/未完了の宿題はありません/);assert.doesNotMatch(ui.html(),/id="admin-homework-dialog"/);
});

test('teacher sees submitted homework first and can return it with a comment',async()=>{
 const ui=await adminReady(card({tasks:[{id:'open',title:'未提出',due:'2026-09-08'},{id:'claim',title:'申告済',due:'2026-09-10',done:true}]}));
 assert.ok(ui.html().indexOf('申告済')<ui.html().indexOf('未提出'));assert.match(ui.html(),/確認待ち/);
 ui.click('homework-open',{'data-id':'claim'});ui.input('homework-review-note','解き直してください');ui.click('homework-return');
 assert.equal(ui.requests.at(-1).body.reviewNote,'解き直してください');assert.equal(ui.requests.at(-1).body.done,false);
});
