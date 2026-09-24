'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
const {TEACHER_TOKEN}=require('./gas-harness.cjs');
test('parent preview resolves the actual family and allows linked sibling reads only',()=>{
 const h=createFamilyHarness(); const made=h.admin('familyCreate',{label:'【テスト】兄弟保護者',studentIds:['test-a','test-b']}); assert.equal(made.ok,true);
 const call=args=>JSON.parse(h.context().doPost({postData:{contents:JSON.stringify({action:'preview',token:TEACHER_TOKEN,...args})}}).getContent());
 const before=JSON.stringify([h.rows('familyAccounts'),h.rows('familyLinks'),h.rows('slots')]);
 const home=call({studentId:'test-a',view:'home'});assert.equal(home.ok,true);assert.equal(home.family.label,'【テスト】兄弟保護者');assert.deepEqual(home.children.map(c=>c.studentId),['test-a','test-b']);
 const sibling=call({studentId:'test-b',familyStudentId:'test-a',view:'student'});assert.ok(sibling.me);assert.equal(sibling.viewer,'preview');
 const grades=call({studentId:'test-b',familyStudentId:'test-a',view:'grades'});assert.equal(grades.ok,true);assert.ok(Array.isArray(grades.grades));assert.equal(call({studentId:'test-b',view:'grades',token:'wrong'}).badAuth,true);
 const parent=call({studentId:'test-b',familyStudentId:'test-a',view:'parent'});assert.equal(parent.ok,true);
 assert.equal(call({studentId:'test-b',view:'home',token:'wrong'}).badAuth,true);
 assert.equal(JSON.stringify([h.rows('familyAccounts'),h.rows('familyLinks'),h.rows('slots')]),before);
});
test('unlinked parent preview reports missing linkage instead of inventing a family',()=>{
 const h=createFamilyHarness();const r=h.context().previewOp_({token:TEACHER_TOKEN,studentId:'test-a',view:'home'});assert.equal(r.errorCode,'previewFamilyUnavailable');
});
