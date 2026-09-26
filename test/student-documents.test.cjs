const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
const {createParity}=require('./helpers/parity-harness.cjs');
test.before(async()=>{(await import('../scripts/build-gas-bundle.mjs')).generate();});
const pdf={name:'【テスト】予定表.pdf',mime:'application/pdf',base64:Buffer.from('%PDF-1.4\nsynthetic test').toString('base64')};
async function setup(){
 const h=createHarness();h.admin('state');const p=await createParity(h);
 const {handleDocuments}=await import('../cf/worker/documents.mjs');let writes=0,reads=0;
 const env={DB:p.d1,SYNC_KEY:'x'.repeat(32),GAS_URL:'https://script.google.com/macros/s/synthetic/exec'};
 const fetcher=async(url,opts)=>{const b=JSON.parse(opts.body);assert.equal(b.key,env.SYNC_KEY);if(b.document.op==='store'){writes++;return Response.json({ok:true,fileId:'private-test-file'});}reads++;return Response.json({ok:true,base64:pdf.base64});};
 return {h,p,env,call:(b)=>handleDocuments(b,env,{fetcher}),counts:()=>({writes,reads})};
}
const admin={token:TEACHER_TOKEN,studentId:'test-a'};
test('PDF upload is teacher-only, idempotent, scoped, and hides Drive IDs',async()=>{
 const s=await setup();
 assert.ok((await s.call({action:'documentUpload',k:'synthetic-link-a',pdf})).error);
 assert.ok((await s.call({action:'documentUpload',token:'wrong',studentId:'test-a',pdf})).error);
 assert.ok((await s.call({action:'documentUpload',...admin,pdf:{...pdf,base64:Buffer.from('not pdf').toString('base64')}})).error);
 assert.deepEqual(s.counts(),{writes:0,reads:0});
 const a=await s.call({action:'documentUpload',...admin,pdf});assert.equal(a.ok,true);
 assert.equal((await s.call({action:'documentUpload',...admin,pdf})).id,a.id);assert.equal(s.counts().writes,1);
 const list=await s.call({action:'documentList',k:'synthetic-link-a',studentId:'test-b'});assert.equal(list.documents.length,1);assert.equal(list.documents[0].name,pdf.name);assert.equal(list.documents[0].fileId,undefined);
 assert.equal((await s.call({action:'documentList',k:'synthetic-link-b'})).documents.length,0);
 assert.ok((await s.call({action:'documentRead',k:'synthetic-link-b',id:a.id})).error);assert.equal(s.counts().reads,0);
 assert.equal((await s.call({action:'documentRead',k:'synthetic-link-a',id:a.id})).base64,pdf.base64);
 assert.ok((await s.call({action:'documentRemove',k:'synthetic-link-a',id:a.id})).error);
 assert.equal((await s.call({action:'documentRemove',...admin,id:a.id})).ok,true);
 assert.ok((await s.call({action:'documentRead',k:'synthetic-link-a',id:a.id})).error);
 assert.equal((await s.call({action:'documentList',...admin})).documents.length,0);
 assert.equal((await s.call({action:'documentUpload',...admin,pdf})).id,a.id);assert.equal(s.counts().writes,1);
});
test('unrelated family and expired sessions cannot access documents',async()=>{
 const s=await setup();assert.ok((await s.call({action:'documentList',ftoken:'expired',studentId:'test-a'})).error);assert.ok((await s.call({action:'documentRead',id:'x'})).error);
});
test('storage failure does not create visible metadata and is retryable',async()=>{
 const s=await setup(),{handleDocuments}=await import('../cf/worker/documents.mjs');
 await assert.rejects(handleDocuments({action:'documentUpload',...admin,pdf},s.env,{fetcher:async()=>Response.json({error:'failed'})}));
 assert.equal((await s.call({action:'documentList',...admin})).documents.length,0);
 assert.equal((await s.call({action:'documentUpload',...admin,pdf})).ok,true);
});

test('family access follows current links and cannot upload or remove',async()=>{
 const {createFamilyHarness}=require('./helpers/family-harness.cjs');
 const h=createFamilyHarness();h.admin('state');
 h.admin('kanriSaveProfile',{studentId:'test-a',profile:{'姓':'【テスト】','名':'資料'}});
 const family=h.admin('familyCreate',{label:'【テスト】資料',studentIds:['test-a']});
 const pass='test-document-password';h.family('familyRegister',{inviteCode:family.inviteCode,email:'docs@example.invalid',pass});
 const challenge=h.latestChallenge();h.family('familyVerify',{challenge});h.family('familyCompleteRegistration',{challenge,pass});
 const login=h.family('familyLogin',{email:'docs@example.invalid',pass});assert.ok(login.ftoken);
 const p=await createParity(h),{handleDocuments}=await import('../cf/worker/documents.mjs');
 const call=b=>handleDocuments(b,{DB:p.d1},{now:h.now()});
 assert.equal((await call({action:'documentList',ftoken:login.ftoken,studentId:'test-a'})).ok,true);
 assert.ok((await call({action:'documentList',ftoken:login.ftoken,studentId:'test-b'})).error);
 assert.ok((await call({action:'documentUpload',ftoken:login.ftoken,studentId:'test-a',pdf})).error);
 await p.d1.prepare("update familyLinks set active = 'false'").run();
 assert.ok((await call({action:'documentList',ftoken:login.ftoken,studentId:'test-a'})).error);
});
test('GAS storage refuses callers without the bridge secret and shared files',()=>{
 const vm=require('node:vm'),fs=require('node:fs');let reads=0;
 const ctx={PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'x'.repeat(32)})},Utilities:{sleep(){}},servicePdfFolder_:()=>({getId:()=> 'folder'}),DriveApp:{Access:{PRIVATE:'private'},getFileById:()=>{reads++;return {getParents:()=>({hasNext:()=>false})};}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('gas/Sync.gs','utf8'),ctx);
 assert.ok(ctx.effectsOp_({key:'wrong',document:{op:'read',fileId:'private'}}).badAuth);assert.equal(reads,0);
 assert.ok(ctx.effectsOp_({key:'x'.repeat(32),document:{op:'read',fileId:'outside-folder'}}).error);
});
