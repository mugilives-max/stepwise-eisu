'use strict';
// Real handlers, synthetic students and in-memory sheets only.
const {createLessonOutlineFixture} = require('./lesson-outline-fixture.cjs');
function createTeacherHomeFixture() {
  const fixture=createLessonOutlineFixture(), h=fixture.h;
  h.advance(Date.parse('2026-09-23T04:00:00Z')-h.now());
  const kind=h.admin('lessonKindSave',{name:'夏期講習',standardMin:60,active:true});
  if(!kind.ok)throw Error(JSON.stringify(kind));
  const sheet=h.spreadsheet.getSheetByName('slots');
  const add=(id,patch={})=>{
    const s={id,date:'2026-09-23',start:'17:00',min:60,status:'booked',done:false,studentId:'test-a',subject:'数学',kind:'通常',deliveryMode:'in_person',...patch};
    sheet.appendRow(sheet.values[0].map(k=>s[k]??''));
  };
  add('home-today-record',{start:'15:00',done:true});
  add('home-today-next',{start:'17:00',studentId:'test-b',subject:'英語'});
  add('home-today-offer',{start:'19:00',status:'offered',kind:'夏期講習'});
  add('home-yesterday-record',{date:'2026-09-22',start:'16:00',done:true});
  add('home-yesterday-check',{date:'2026-09-22',start:'18:00',studentId:'test-b'});
  add('home-old-record',{date:'2026-09-12',done:true});
  add('home-expired',{date:'2026-09-21',status:'offered'});
  add('home-future-offer',{date:'2026-09-25',status:'offered',kind:'夏期講習'});
  add('home-future-booked',{date:'2026-09-24',start:'18:00',studentId:'test-b',subject:'英語'});
  return fixture;
}
module.exports={createTeacherHomeFixture};
