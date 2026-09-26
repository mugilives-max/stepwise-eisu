const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,flush}=require('./helpers/operations-ui-harness.cjs');
for(const [label,other,wanted] of [
 ['alone',null,false],['overlap',{start:'18:30'},true],['touching',{start:'19:00'},false],
 ['same student',{studentId:'test-a'},false],['online',{deliveryMode:'online'},false],['unapproved',{status:'offered'},false]
])test('daily simultaneous record button: '+label,async()=>{
 const ui=createUI('admin',{hash:'#lessons'});
 const a={id:'a',studentId:'test-a',studentName:'【テスト】A',date:'2026-09-08',start:'18:00',min:60,status:'booked',deliveryMode:'in_person',subject:'英語',teacherBooking:{status:'pending'}};
 const slots=[a];if(other)slots.push({...a,id:'b',studentId:'test-b',studentName:'【テスト】B',...other});
 ui.requests[0].reply({admin:{today:a.date,slots,students:[],teacherOff:[],blocked:[],wishes:[],events:[],plans:[]}});await flush();
 assert.equal(ui.html().includes('同時受講の記録'),wanted);
 assert.doesNotMatch(ui.html(),/本人確認待ち|data-action="toggledone"/);
});
