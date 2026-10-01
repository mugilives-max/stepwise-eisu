const test=require('node:test');
const assert=require('node:assert/strict');
const {adminReady,card,flush}=require('./helpers/operations-ui-harness.cjs');
test('student schedule shares lesson rows and keeps manual and AI writes scoped to the student',async()=>{
 const ui=await adminReady(card({nlEnabled:true,lessons:[{id:'lesson-a',date:'2026-09-15',start:'17:00',min:90,status:'booked',subject:'英語',deliveryMode:'online'}]}));
 ui.click('calday',{'data-date':'2026-09-15'});
 assert.match(ui.html(),/9\/15.*の授業/);
 assert.match(ui.html(),/data-action="slotedit"[^>]*data-sid="test-a"/);
 assert.doesNotMatch(ui.html().split('schedule-day-heading')[1].split('<h2>')[0],/>予定<\/span>|予定の編集/);
 // ＋は授業一覧と共通の案内モーダル(board-editor)を、表示中の生徒・選んだ日で開く(d046b20)。生徒は選び直せない
 ui.click('sdayadd');assert.equal(ui.el('board-editor').modal,true);assert.equal(ui.el('student-schedule'),undefined);
 assert.match(ui.html(),/<input type="hidden" id="f-student" value="test-a">/);assert.equal(ui.el('f-date').value,'2026-09-15');
 ui.input('f-subject','英語');ui.click('offerslot');
 assert.equal(ui.requests.at(-1).body.op,'offer');assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.equal(ui.requests.at(-1).body.date,'2026-09-15');
});
test('AI opens in a modal for the current student',async()=>{
 const ui=await adminReady(card({nlEnabled:true}));ui.click('sdayai');
 // AIは文章入力の共通モーダル(ai-schedule)。生徒欄は表示中の生徒だけで選択済み(d046b20・e5bfbb9)
 assert.equal(ui.el('ai-schedule').modal,true);assert.equal(ui.el('ai-student').value,'test-a');assert.doesNotMatch(ui.html(),/<option value="(?!test-a")[^"]+"/);
 ui.input('tnl-text','来週の英語');ui.click('tnl-parse');
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

// 日程の決め方（2026-10-01）: 「予定表にまとめて、あとで送る」と、未送信の仮予定をまとめて送るボタン
test('the offer form can hold lessons for the schedule, and held lessons are sent together from the student page',async()=>{
 const held={id:'held-a',date:'2026-09-21',start:'17:00',min:60,status:'offered',subject:'英語',deliveryMode:'in_person',flow:{confirmBy:'',held:true,change:null}};
 const ui=await adminReady(card({lessons:[held,Object.assign({},held,{id:'held-b',date:'2026-09-28'})]}));
 assert.match(ui.html(),/未送信の仮予定 2件<\/strong>（9\/21\(月\)〜9\/28\(月\)）/);
 ui.click('calday',{'data-date':'2026-09-21'});
 assert.match(ui.html(),/data-action="teacher-book-open" data-id="held-a"[^>]*>未送信（予定表）/);
 ui.click('sched-send',{'data-sid':'test-a'});assert.equal(ui.confirms(),1,'送る前に確認する');
 assert.equal(ui.requests.at(-1).body.op,'scheduleSend');assert.equal(ui.requests.at(-1).body.studentId,'test-a');assert.match(ui.requests.at(-1).body.requestId,/^lc-/);
 ui.requests.at(-1).reply({ok:true,sent:2,id:'test-a',data:card({lessons:[]})});await flush();
 ui.click('sdayadd');assert.match(ui.html(),/<option value="hold">予定表にまとめて、あとで送る<\/option>/);
 ui.input('f-subject','英語');ui.input('f-send','hold');ui.click('offerslot');
 assert.equal(ui.requests.at(-1).body.op,'offer');assert.equal(ui.requests.at(-1).body.hold,true);
});
