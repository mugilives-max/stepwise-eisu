const {test}=require('node:test'),assert=require('node:assert/strict'),board=require('../assets/schedule-board.js');
const {createUI,flush}=require('./helpers/operations-ui-harness.cjs');
const date='2026-09-10',lesson=(start,min,mode='in_person',studentId='b')=>({id:start,date,start,min,deliveryMode:mode,studentId,status:'booked'});
test('capacity uses actual overlapping intervals, not the number of all intersecting lessons',()=>{
 const d={date,start:'10:00',min:120,deliveryMode:'in_person',studentId:'a'};
 assert.deepEqual(board.warnings({slots:[lesson('10:00',60),lesson('11:00',60)]},d),[]);
 assert.match(board.warnings({slots:[lesson('10:00',90),lesson('11:00',60)]},d).join(),/定員2人/);
 assert.match(board.warnings({slots:[lesson('10:00',60,'online')]},d).join(),/1対1/);
});
test('normal hours use lesson end and restriction warnings remain scoped to the selected child',()=>{
 assert.deepEqual(board.warnings({}, {date,start:'21:00',min:60}),[]);
 assert.match(board.warnings({}, {date,start:'21:30',min:60}).join(),/範囲外/);
 const data={blocked:[{date,studentId:'b'}],teacherOff:[{date,start:'11:00',end:'12:00'}]};
 assert.deepEqual(board.warnings(data,{date,start:'10:00',min:60,studentId:'a'}),[]);
 assert.match(board.warnings(data,{date,start:'10:00',min:60,studentId:'b'}).join(),/この生徒/);
});
test('board renders ordinary hours, escapes labels and explicitly surfaces off-hour lessons',()=>{
 const data={today:date,slots:[{...lesson('06:00',60),studentName:'<img>'}]};
 const normal=board.render(data,{date});assert.ok(!normal.includes('data-board-time="06:00"'));assert.match(normal,/時間外の授業が1件/);
 const full=board.render(data,{date,full:true});assert.match(full,/data-board-time="06:00"/);assert.match(full,/&lt;img&gt;/);
});
async function ready(){const ui=createUI('admin',{hash:'#lessons'});ui.requests[0].reply({admin:{today:date,students:[{id:'a',active:true,name:'【テスト】A',deliveryMode:'in_person'}],slots:[],blocked:[],teacherOff:[],wishes:[],events:[],plans:[]}});await flush();return ui;}
test('calendar composer validates the default hours before sending and preserves fields across failed writes',async()=>{
 const ui=await ready();assert.equal(ui.el('f-date'),undefined);ui.click('board-new');ui.change('f-student','a');ui.change('f-subject','英語');ui.input('f-start','21:30');ui.change('f-min','60');ui.click('offerslot');assert.equal(ui.requests.length,1);
 ui.input('f-start','21:00');ui.click('offerslot');assert.equal(ui.requests.length,2);assert.equal(ui.requests[1].body.start,'21:00');assert.equal(ui.requests[1].body.deliveryMode,'in_person');
 ui.requests[1].fail();await flush();assert.equal(ui.el('f-start').value,'21:00');assert.match(ui.html(),/入力を保持/);
});
test('calendar navigation does not render the removed preview or global restriction lists',async()=>{const ui=await ready();assert.ok(!ui.html().includes('先生の休み(先生が授業できない日)'));assert.match(ui.html(),/先生の授業不可時間を登録/);ui.click('board-next');assert.equal(ui.el('board-date').value,'2026-09-17');});
