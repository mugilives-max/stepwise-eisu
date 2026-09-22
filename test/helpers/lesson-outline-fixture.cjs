'use strict';
// Shared local UI / release-check fixture. No live ledger, email or network.
const {createFamilyHarness} = require('./family-harness.cjs');
const ok = r => { if (!r.ok) throw Error(JSON.stringify(r)); return r; };
function createLessonOutlineFixture() {
  const h = createFamilyHarness();
  ok(h.admin('state'));
  for (const s of h.rows('students')) h.setRow('students','id',s.id,{deliveryMode:'in_person'});
  const line = ok(h.admin('planLineSave',{studentId:'test-a',subject:'数学',kind:'通常',count:10,startDate:'2026-09-01',endDate:'2026-09-30',lessonMin:60,lessonFee:3000,comment:'【テスト】中学1・2年の基礎事項をしっかり定着させるための復習計画です。',propose:true})).line;
  const items = [{id:'numbers',title:'数と式・計算',count:2},{id:'equations',title:'方程式の計算',count:2},{id:'words',title:'方程式の文章題',count:2},{id:'geometry',title:'図形',count:3},{id:'review',title:'総復習',count:1}];
  ok(h.admin('planOutlineSave',{studentId:'test-a',lineId:line.id,expectedRevision:0,expectedPlanRevision:line.revision,requestId:'preview-outline',publication:'publish',items}));
  const slots = h.spreadsheet.getSheetByName('slots');
  for (const [id,date,done] of [['preview-current','2026-09-07',true],['preview-next','2026-09-14',false]]) {
    const slot = {id,date,done,studentId:'test-a',subject:'数学',kind:'通常',start:'15:00',min:60,status:'booked',deliveryMode:'in_person'};
    slots.appendRow(slots.values[0].map(k=>slot[k]??''));
  }
  const record = ok(h.admin('lessonRecordSave',{studentId:'test-a',slotId:'preview-current',expectedRevision:0,requestId:'preview-report',record:{
    content:'本日は方程式の計算を扱いました。文字が１つの方程式では非常によく解けていました。連立方程式では、代入法や係数が分数を含む計算で間違いが多かったため解説し、解説を元に理解して解くことができました。最後の解きなおしでは間違えた問題をすべて正答することができました。',
    report:{actualUnit:'方程式の計算'},teacherNote:'PRIVATE_TEACHER_SYNTHETIC',
    homework:['スーパー数学基礎演習 p21','スーパー数学基礎演習 p22','ウルトラ数学ドリル p7〜10'].map((title,i)=>({itemId:'preview-hw-'+i,title,type:'宿題',dueMode:'nextLesson',due:''})),
    outline:{lineId:line.id,itemId:'equations',expectedRevision:1,expectedPlanRevision:line.revision}
  }}));
  ok(h.admin('lessonHomeworkApply',{studentId:'test-a',recordId:record.recordId,expectedRevision:record.revision,requestId:'preview-homework'}));
  const family = ok(h.admin('familyCreate',{label:'【テスト】授業報告の確認用',studentIds:['test-a']}));
  const email = 'lesson-preview@example.invalid', pass = 'Synthetic preview password!';
  ok(h.family('familyRegister',{inviteCode:family.inviteCode,email}));
  const challenge = h.latestChallenge();
  ok(h.family('familyVerify',{challenge}));
  ok(h.family('familyCompleteRegistration',{challenge,pass}));
  const session = ok(h.family('familyLogin',{email,pass}));
  return {h,line,items,record,ftoken:session.ftoken};
}
module.exports = {createLessonOutlineFixture};
