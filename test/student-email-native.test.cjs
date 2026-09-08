'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHarness}=require('./gas-harness.cjs');
test('native student email helper uses only a fresh test book, fake mail and sanitized evidence',()=>{
  const h=createHarness({iterations:10}),c=h.context(),before=JSON.stringify([...h.spreadsheet.sheets].map(([n,s])=>[n,s.values])),created=[];
  const Spreadsheet=h.spreadsheet.constructor,Range=h.spreadsheet.getSheetByName('config').getRange(1,1).constructor;
  Range.prototype.getFormula=function(){return '';};
  c.SpreadsheetApp.create=()=>{const book=new Spreadsheet();book.getId=()=> 'synthetic-student-email-book';book.getUrl=()=> 'https://example.invalid/synthetic-student-email-book';created.push(book);return book;};
  vm.runInContext(fs.readFileSync(require.resolve('./gas-native-student-email-check.gs'),'utf8'),c);
  const r=c.stepwiseNativeStudentEmailCheck();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(created.length,1);assert.ok(Object.keys(r.checks).length>=30);assert.ok(Object.values(r.checks).every(Boolean));
  assert.equal(/se1\.|native-student-email-link/.test(JSON.stringify(r)),false);assert.equal(h.effects.some(e=>['email','calendar'].includes(e.kind)),false);
  assert.equal(JSON.stringify([...h.spreadsheet.sheets].map(([n,s])=>[n,s.values])),before);assert.equal(c.ss_(),h.spreadsheet);
});
