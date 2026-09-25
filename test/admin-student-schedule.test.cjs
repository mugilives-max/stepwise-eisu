const test=require('node:test');
const assert=require('node:assert/strict');
const {adminReady,card,flush}=require('./helpers/operations-ui-harness.cjs');
test('student schedule shares lesson rows and keeps manual and AI writes scoped to the student',async()=>{
 const ui=await adminReady(card({nlEnabled:true,lessons:[{id:'lesson-a',date:'2026-09-15',start:'17:00',min:90,status:'booked',subject:'英語',deliveryMode:'online'}]}));
 ui.click('calday',{'data-date':'2026-09-15'});
 assert.match(ui.html(),/9\/15.*の授業/);
 assert.match(ui.html(),/data-action="slotedit"[^>]*data-sid="test-a"/);
 assert.doesNotMatch(ui.html().split('schedule-day-heading')[1].split('data-fold="upcoming"')[0],/>予定<\/span>|予定の編集/);
 ui.click('sdayadd');assert.ok(ui.el('student-schedule'));
 ui.click('dayoffer');assert.ok(ui.el('f-date'));
 ui.click('sdayclose');ui.click('sdayadd');ui.click('sblockopen');
 ui.input('sb-start','16:00');ui.input('sb-end','18:00');ui.input('sb-note','テスト');ui.click('sblockadd');
 assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.op,'addBlock');
});
test('AI opens in a modal for the current student',async()=>{
 const ui=await adminReady(card({nlEnabled:true}));ui.click('sdayai');
 assert.ok(ui.el('student-schedule'));ui.input('tnl-text','来週の英語');ui.click('tnl-parse');
 assert.equal(ui.requests.at(-1).body.op,'scheduleParseTeacher');assert.equal(ui.requests.at(-1).body.studentId,'test-a');
});

for(const block of [false,true])test('event does not block lessons unless explicitly selected: '+block,async()=>{
 const ui=await adminReady(card({nlEnabled:true,events:[{id:'event-a',date:'2026-09-15',dateTo:'2026-09-15',title:'大会'}]}));
 assert.match(ui.html(),/<h2>イベント /);assert.doesNotMatch(ui.html(),/共有予定|予定の共有|data-fold="upcoming"/);
 ui.click('sdayai');ui.input('tnl-text','15日に大会');ui.click('tnl-parse');
 ui.requests.at(-1).reply({items:[{kind:'event',dates:['2026-09-15'],title:'大会',alsoBlock:true}]});await flush();
 assert.match(ui.html(),/イベント：大会/);assert.doesNotMatch(ui.html(),/data-action="tnl-event-block"[^>]* checked/);
 if(block)ui.click('tnl-event-block',{'data-i':'0'});
 ui.click('tnl-register');assert.equal(ui.requests.at(-1).body.items[0].alsoBlock,block);
});
