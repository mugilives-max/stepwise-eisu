'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
test('material persists across publication, task application and completion; completed edits are held',()=>{
 const h=createHarness({iterations:10}),c=h.context();c.ensureLessonSchema_();
 h.spreadsheet.getSheetByName('slots').appendRow(['slot-material','2026-09-07','13:00',60,'booked','test-a',false,'','','英語','']);
 const call=(op,args)=>c.lessonAdmin_(Object.assign({action:'admin',op,token:TEACHER_TOKEN,studentId:'test-a'},args));
 const record={content:'報告',homework:[{itemId:'material-item',title:'p12',material:'テスト教材',type:'宿題',due:'2026-09-09'}]};
 const saved=call('lessonRecordSave',{slotId:'slot-material',expectedRevision:0,requestId:'material-save',record});assert.equal(saved.ok,true,JSON.stringify(saved));
 const applied=call('lessonHomeworkApply',{recordId:saved.recordId,expectedRevision:saved.revision,requestId:'material-apply'});assert.equal(applied.ok,true,JSON.stringify(applied));
 const task=h.rows('tasks')[0];assert.equal(task.material,'テスト教材');assert.equal(c.tasksFor_('test-a',60)[0].material,'テスト教材');
 assert.equal(c.lessonPublishedForStudent_('test-a')[0].homework[0].material,'テスト教材');assert.ok(c.lessonMaterialChoices_().includes('テスト教材'));
 c.lessonSetTaskDone_(task,true,false);assert.equal(h.rows('tasks')[0].material,'テスト教材');
 record.homework[0].material='別の教材';const changed=call('lessonRecordSave',{slotId:'slot-material',expectedRevision:saved.revision,requestId:'material-change',record});assert.equal(changed.ok,true,JSON.stringify(changed));
 const again=call('lessonHomeworkApply',{recordId:saved.recordId,expectedRevision:changed.revision,requestId:'material-reapply'});assert.equal(again.ok,true,JSON.stringify(again));assert.equal(h.rows('tasks')[0].material,'テスト教材');
});
test('legacy normalization stays compatible and material is length validated',()=>{
 const c=createHarness().context(),x={itemId:'old',title:'内容',type:'宿題',due:''};
 assert.equal(Object.hasOwn(c.lessonHomework_([x])[0],'material'),false);
 assert.throws(()=>c.lessonHomework_([{...x,material:'a'.repeat(121)}]));
 assert.equal(c.lessonHomework_([{...x,material:'  教材  '}])[0].material,'教材');
});

test('adding the material column preserves existing task values',()=>{
 const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),path=require('node:path');const db=new DatabaseSync(':memory:');
 const dir=path.join(__dirname,'../cf/migrations');for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<'0015').sort())db.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 db.exec("INSERT INTO tasks (id,studentId,title) VALUES ('legacy','test-a','既存の内容')");const before=db.prepare('SELECT * FROM tasks').get();db.exec(fs.readFileSync(path.join(dir,'0015_homework_material.sql'),'utf8'));const after=db.prepare('SELECT * FROM tasks').get();assert.equal(after.material,'');delete after.material;assert.deepEqual(after,before);db.close();
});
