'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./gas-harness.cjs');
function fixture(){const h=createHarness({iterations:10});h.context().ensureSchema_();h.setRow('students','id','test-a',{deliveryMode:'in_person'});h.setRow('students','id','test-b',{deliveryMode:'in_person'});h.seed=(id,studentId,start,min=60,mode='in_person',patch={})=>{const row={id,studentId,date:'2026-09-10',start,min,deliveryMode:mode,status:'booked',...patch};const sh=h.spreadsheet.getSheetByName('slots');sh.appendRow(sh.values[0].map(k=>row[k]??''));return row;};h.check=(patch={})=>h.parent('wishAvailability',{kind:'want',date:'2026-09-10',start:'13:00',min:60,...patch});return h;}
test('availability enforces in-person capacity, online exclusivity and half-open boundaries without identity leaks',()=>{
 const h=fixture();h.seed('other-secret','test-b','13:00');assert.equal(h.check().days[0].status,'available');
 assert.equal(h.check({deliveryMode:'online'}).days[0].status,'full');h.seed('third-secret','third-student-secret','13:30');
 const full=h.check();assert.equal(full.days[0].status,'full');assert.equal(JSON.stringify(full).includes('secret'),false);assert.equal(JSON.stringify(full).includes('test-b'),false);
 assert.equal(h.check({start:'14:30'}).days[0].status,'available');
});
test('flexible windows need one uninterrupted lesson and consider occupied proposals, breaks and student blocks',()=>{
 const h=fixture();h.seed('occupied','test-b','13:00',60,'online',{status:'offered'});
 let q=h.check({kind:'ok',start:'13:00',end:'15:00',min:90});assert.equal(q.days[0].status,'full');
 q=h.check({kind:'ok',start:'13:00',end:'15:00',min:60});assert.equal(q.days[0].firstStart,'14:00');
 h.spreadsheet.getSheetByName('teacherOff').appendRow(['rest','2026-09-10','PRIVATE_BREAK','14:00','14:30']);
 q=h.check({kind:'ok',start:'13:00',end:'16:00',min:60});assert.equal(q.days[0].firstStart,'14:30');assert.equal(JSON.stringify(q).includes('PRIVATE_BREAK'),false);
 h.spreadsheet.getSheetByName('blocked').appendRow(['blocked','test-a','2026-09-10','','','']);assert.equal(h.check({start:'16:00'}).days[0].status,'unavailable');
});
test('availability protects pending edit destinations and handles unknown modes conservatively',()=>{
 const h=fixture(),s=h.seed('move','test-b','15:00',60,'online');
 h.spreadsheet.getSheetByName('offerEdits').appendRow(['edit','test-b','edit','move',JSON.stringify({slot:s}),JSON.stringify({slot:{...s,start:'13:00'}}),'pending','','']);
 assert.equal(h.check().days[0].status,'full');
 h.seed('unknown','unknown-student','16:00',60,'');assert.equal(h.check({start:'16:00'}).days[0].status,'unknown');
});
test('malformed dates, times, durations, duplicate student lessons and inactive links are handled before writes',()=>{
 const h=fixture();for(const patch of [{date:'2026-02-30'},{start:'25:00'},{start:'23:30',min:60},{kind:'ok',start:'13:00',end:'13:30',min:60},{min:10},{dates:Array(21).fill('2026-09-10')}])assert.ok(h.check(patch).error,JSON.stringify(patch));
 h.seed('own','test-a','13:00');assert.equal(h.check().days[0].status,'full');h.setRow('students','id','test-a',{active:false});assert.equal(h.check().badCode,true);assert.equal(h.rows('wishes').length,0);
});
test('a full wish is accepted with a visible stored status, mode and length but never reserves or confirms a lesson',()=>{
 const h=fixture();h.seed('online','test-b','13:00',60,'online');const before=JSON.stringify(h.rows('slots')),check=h.check();
 const req={kind:'want',date:'2026-09-10',start:'13:00',min:60,deliveryMode:'in_person',availabilitySeen:check.days.map(d=>({date:d.date,status:d.status}))};
 const r=h.parent('wish',req);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.state.wishes[0].availability,'full');assert.equal(r.state.wishes[0].duration,60);assert.equal(r.state.wishes[0].deliveryMode,'in_person');
 assert.equal(JSON.stringify(h.rows('slots')),before);assert.equal(h.parent('wish',req).replayed,true);assert.equal(h.rows('wishes').length,1);
 assert.ok(h.parent('wish',{...req,note:'別のメモ'}).error);assert.equal(h.rows('wishes')[0].note,'');
});
test('changed availability requires a fresh visible confirmation and batch validation writes no partial selection',()=>{
 const h=fixture(),old=h.check();h.seed('online','test-b','13:00',60,'online');
 let r=h.parent('wish',{kind:'want',date:'2026-09-10',start:'13:00',min:60,availabilitySeen:old.days.map(d=>({date:d.date,status:d.status}))});assert.equal(r.errorCode,'availabilityChanged');assert.equal(r.availability.days[0].status,'full');assert.equal(h.rows('wishes').length,0);
 r=h.parent('wishMany',{kind:'want',dates:['2026-09-10','2026-02-30'],start:'13:00',min:60});assert.ok(r.error);assert.equal(h.rows('wishes').length,0);
 const dates=['2026-09-10','2026-09-11'],check=h.check({dates});r=h.parent('wishMany',{kind:'want',dates,start:'13:00',min:60,availabilitySeen:check.days.map(d=>({date:d.date,status:d.status}))});assert.equal(r.ok,true);assert.deepEqual(h.rows('wishes').map(w=>w.availability),['full','available']);
});
test('paired record contexts require teacher authentication and real overlap of two distinct in-person students',()=>{
 const h=fixture();h.seed('a','test-a','13:00',90);h.seed('b','test-b','14:00');
 let r=h.admin('lessonPairContext',{slotId:'a'});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.contexts.map(c=>c.student.id),['test-a','test-b']);
 assert.equal(h.admin('lessonPairContext',{slotId:'a',token:''}).badAuth,true);
 h.setRow('slots','id','b',{start:'14:30'});r=h.admin('lessonPairContext',{slotId:'a',otherSlotId:'b'});assert.equal(r.errorCode,'conflict');
 h.setRow('slots','id','b',{start:'14:00',deliveryMode:'online'});r=h.admin('lessonPairContext',{slotId:'a'});assert.equal(r.contexts.length,1);
 assert.equal(h.parent('lessonPairContext',{slotId:'a'}).error,'unknown action');
});
test('pair choices do not arbitrarily select between successive overlapping partners',()=>{
 const h=fixture();h.seed('a','test-a','13:00',120);h.seed('b','test-b','13:00');h.seed('c','test-inactive','14:00');
 let r=h.admin('lessonPairContext',{slotId:'a'});assert.equal(r.choices.length,2);assert.equal(r.contexts.length,1);
 r=h.admin('lessonPairContext',{slotId:'a',otherSlotId:'c'});assert.equal(r.contexts[1].student.id,'test-inactive');assert.equal(r.contexts[1].student.active,false);
});
