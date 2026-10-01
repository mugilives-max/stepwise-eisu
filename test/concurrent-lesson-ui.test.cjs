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
 assert.doesNotMatch(ui.html(),/本人確認待ち|data-action="toggledone"/);
 // 2026-09-27 から入口は授業記録ページの「複数授業を記録」。一覧から開いた記録ページに出る
 const link=(ui.html().match(/href="(#lesson[?]student=test-a&amp;slot=a(?:&amp;[^"]*)?)"/)||[])[1];assert.ok(link,'一覧に授業記録へのリンクがない');
 ui.navigate(link.replace(/&amp;/g,'&'));assert.equal(ui.requests.at(-1).body.op,'lessonContext');
 ui.requests.at(-1).reply({ok:true,context:{today:a.date,student:{id:'test-a',name:a.studentName,active:true},slot:a,record:null,previous:null,otherPrevious:[],openTasks:[],homeworkState:[],draft:null,pending:null,slotChanged:false,lessonChoices:[]}});await flush();
 assert.equal(ui.html().includes('複数授業を記録'),wanted,'記録ページの入口: '+link);
});
