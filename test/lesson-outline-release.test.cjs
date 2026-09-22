'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createLessonOutlineFixture}=require('./helpers/lesson-outline-fixture.cjs');
const {createParity}=require('./helpers/parity-harness.cjs');
const {createBillingHarness}=require('./helpers/billing-harness.cjs');
const {TEACHER_TOKEN}=require('./gas-harness.cjs');
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r).slice(0,300));return r;};
test.before(async()=>{(await import('../scripts/build-gas-bundle.mjs')).generate();});
test('outline-linked public report and three tasks work through a genuine family session on D1',async()=>{
  const {h,line,items,record,ftoken}=createLessonOutlineFixture(),p=await createParity(h);
  const approvalsBefore=(await p.d1.prepare('SELECT count(*) AS n FROM approvalEvents').first()).n;
  const {runWrite}=await import('../cf/worker/write.mjs');
  const family={ftoken,studentId:'test-a'};
  const write=async body=>ok((await runWrite(body,p.env,{now:h.now()})).result);
  // learningService uses the common doPost path, including its read-only operations.
  const read=op=>write({action:'learningService',op,...family});
  const state=await p.worker({action:'familyStudentState',...family});
  assert.equal(state.lessonRecords.length,1);assert.equal(state.tasks.length,3);
  assert.equal(state.lessonRecords[0].outline.ordinal,1);assert.equal(state.lessonRecords[0].outline.plannedCount,2);
  assert.equal(ok(await read('recordReadStatus')).reads[0].readRevision,0);
  await write({action:'learningService',op:'recordRead',recordId:record.recordId,revision:1,...family});
  await write({action:'learningService',op:'recordRead',recordId:record.recordId,revision:1,...family});
  assert.equal(ok(await read('recordReadStatus')).reads[0].readRevision,1);
  assert.equal((await p.d1.prepare('SELECT count(*) AS n FROM lessonReadReceipts').first()).n,1);
  await write({action:'admin',op:'planOutlineSave',token:TEACHER_TOKEN,studentId:'test-a',lineId:line.id,expectedRevision:1,expectedPlanRevision:line.revision,requestId:'private-outline-change',publication:'keep',items:items.map(x=>({...x,title:'PRIVATE_OUTLINE_'+x.id}))});
  const after=await p.worker({action:'familyStudentState',...family});
  assert.doesNotMatch(JSON.stringify(after),/PRIVATE_TEACHER|PRIVATE_OUTLINE/);
  assert.equal(after.lessonRecords[0].outline.title,'方程式の計算');
  const saved=record.context.record;
  const corrected=await write({action:'admin',op:'lessonRecordSave',token:TEACHER_TOKEN,studentId:'test-a',slotId:'preview-current',expectedRevision:1,requestId:'corrected-report',record:{content:'【テスト】報告の訂正',report:saved.report,teacherNote:saved.teacherNote,homework:saved.homework.map(({itemId,title,type,dueMode,due})=>({itemId,title,type,dueMode,due}))}});
  assert.equal(corrected.revision,2);
  const stale=(await runWrite({action:'learningService',op:'recordRead',recordId:record.recordId,revision:1,...family},p.env,{now:h.now()})).result;
  assert.equal(stale.errorCode,'updated');
  await write({action:'learningService',op:'recordRead',recordId:record.recordId,revision:2,...family});
  assert.equal(ok(await read('recordReadStatus')).reads[0].readRevision,2);
  const foreign=(await runWrite({action:'learningService',op:'recordRead',ftoken,studentId:'test-b',recordId:record.recordId,revision:2},p.env,{now:h.now()})).result;
  assert.ok(foreign.error);
  assert.equal((await p.d1.prepare('SELECT count(*) AS n FROM approvalEvents').first()).n,approvalsBefore);
  assert.equal((await p.d1.prepare('SELECT count(*) AS n FROM tasks').first()).n,3);
});
test('D1 export and Sheets mirror preserve all three new tables with actual report snapshots',async()=>{
  const {h}=createLessonOutlineFixture(),p=await createParity(h);
  const {books}=await import('../cf/lib/sheet-view.mjs');
  const {TABLE_COLUMNS}=await import('../cf/worker/generated/schema.mjs');
  const exported={ok:true,exportedAt:'2026-09-22T02:00:00.000Z',...(await books(p.d1,TABLE_COLUMNS))};
  const mirror=createBillingHarness({urlFetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(exported)})});
  mirror.properties.set('WORKER_SYNC_KEY','synthetic-outline-mirror');mirror.properties.set('WORKER_OWNS_LEDGER','1');
  ok(mirror.context().mirrorLedgerFromWorker());
  for(const name of ['planOutlines','lessonOutlineLinks','lessonOutlineSnapshots']) {
    assert.ok(exported.app[name].length>1,name+' must include real synthetic rows');
    const values=mirror.spreadsheet.getSheetByName(name).getDataRange().getValues();
    assert.deepEqual(values.map(r=>r.map(String)),exported.app[name].map(r=>r.map(v=>String(v??''))));
  }
});
