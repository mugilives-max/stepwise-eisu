const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
function fixture(){const h=createHarness({iterations:10});h.admin('state');assert.equal(h.admin('taskAdd',{studentId:'test-a',title:'【テスト】確認課題',dueMode:'date',due:'2026-09-10'}).ok,true);return h;}
function exercise(request,admin,row){return (async()=>{
 const id=(await row()).id;
 assert.ok((await request({action:'taskDone',k:'synthetic-link-b',taskId:id,done:true})).error);
 assert.equal((await request({action:'taskDone',k:'synthetic-link-a',taskId:id,done:true,reviewedAt:'forged'})).ok,true);
 assert.ok((await row()).doneAt);assert.equal((await row()).reviewedAt||'','');
 assert.ok((await admin({studentId:'test-b',taskId:id,done:true})).error);
 assert.equal((await admin({studentId:'test-a',taskId:id,done:false,reviewNote:'途中式を書いてください'})).ok,true);
 assert.equal((await row()).doneAt,'');assert.equal((await row()).reviewNote,'途中式を書いてください');
 assert.equal((await request({action:'taskDone',k:'synthetic-link-a',taskId:id,done:true})).ok,true);
 assert.equal((await admin({studentId:'test-a',taskId:id,done:true})).ok,true);const reviewed=(await row()).reviewedAt;assert.ok(reviewed);
 assert.equal((await admin({studentId:'test-a',taskId:id,done:true})).ok,true);assert.equal((await row()).reviewedAt,reviewed);
 assert.ok((await request({action:'taskDone',k:'synthetic-link-a',taskId:id,done:false})).error);assert.equal((await row()).reviewedAt,reviewed);
 assert.equal((await admin({studentId:'test-a',taskId:id,done:false,reviewNote:'再確認'})).ok,true);
 assert.equal((await admin({studentId:'test-a',taskId:id,done:true})).ok,true,'teacher may confirm without student claim');
 })();}
test('homework claim, teacher review, return, ownership and confirmed lock in GAS',async()=>{const h=fixture();await exercise(x=>h.request(x),x=>h.admin('taskDone',x),()=>h.rows('tasks')[0]);});
test('same review workflow through Worker D1 writes',async()=>{const h=fixture();const {createParity}=require('./helpers/parity-harness.cjs');const p=await createParity(h);const {runWrite}=await import('../cf/worker/write.mjs');await exercise(async x=>(await runWrite(x,p.env)).result,async x=>(await runWrite({action:'admin',op:'taskDone',token:TEACHER_TOKEN,...x},p.env)).result,()=>p.env.DB.prepare('SELECT * FROM tasks LIMIT 1').first());});
