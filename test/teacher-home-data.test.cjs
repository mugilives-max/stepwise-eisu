'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createTeacherHomeFixture}=require('./helpers/teacher-home-fixture.cjs');
test('dashboard preserves lesson kind so editing a course offer cannot silently turn it into a regular lesson',()=>{
  const {h}=createTeacherHomeFixture();
  const r=h.admin('kanriDashboard');assert.equal(r.ok,true);
  assert.equal(r.data.lessonKinds.some(k=>k.name==='夏期講習'),true);
  for(const key of ['slots','pending']) assert.equal(r.data[key].find(s=>s.id==='home-future-offer').kind,'夏期講習');
  assert.equal(r.data.lessonsToday.length,2);
  assert.equal(r.data.unrecordedLessons.some(s=>s.id==='home-yesterday-check'),true);
  const s=r.data.pending.find(s=>s.id==='home-future-offer');
  const edit=h.admin('editOffered',{studentId:s.studentId,slotId:s.id,requestId:'home-preview-kind-edit',expectedSnapshot:s,date:s.date,start:'18:00',min:s.min,subject:s.subject,kind:s.kind,deliveryMode:s.deliveryMode,from:'kanri',view:'home'});
  assert.equal(edit.ok,true,JSON.stringify(edit));
  assert.equal(edit.dash.pending.find(x=>x.id===s.id).kind,'夏期講習');
  assert.equal(edit.dash.pending.find(x=>x.id===s.id).start,'18:00');
});
