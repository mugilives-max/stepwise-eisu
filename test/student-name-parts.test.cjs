'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness}=require('./gas-harness.cjs');
test('explicit name parts persist without changing full name and are exposed to the family',()=>{
 const h=createHarness({iterations:10}),c=h.context();c.ensureSchema_();
 const before=h.rows('students').find(s=>s.id==='test-a').name;
 let r=h.admin('kanriSaveProfile',{studentId:'test-a',profile:{'姓':'【テスト】','名':'保護者認証A'}});assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(h.rows('students').find(s=>s.id==='test-a').name,before);
 assert.equal(c.studentState_('synthetic-link-a').me.givenName,'保護者認証A');
 assert.equal(c.kanriStudent_('test-a').profile['姓'],'【テスト】');
 assert.ok(h.admin('kanriSaveProfile',{studentId:'test-a',profile:{'姓':'間違い','名':'名'}}).error);
 assert.equal(c.studentNameParts_('test-b').givenName,'');
});
