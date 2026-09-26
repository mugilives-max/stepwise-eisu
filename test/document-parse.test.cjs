const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
const {createParity}=require('./helpers/parity-harness.cjs');
test.before(async()=>{(await import('../scripts/build-gas-bundle.mjs')).generate();});
const event={date:'2026-10-01',dateTo:'2026-10-01',title:'中間テスト',audience:'target',test:true};
async function setup(){
 const h=createHarness();h.admin('state');h.admin('kanriSaveProfile',{studentId:'test-a',profile:{'学年':'中学3年生'}});
 const p=await createParity(h);await p.d1.prepare("insert into _studentDocuments (id,studentId,name,fileId,fileHash,size,createdAt) values ('doc','test-a','test.pdf','file','hash',50,'2026-09-26')").run();
 const {handleDocuments}=await import('../cf/worker/documents.mjs');let ai=0,reads=0,payload;
 const env={DB:p.d1,NL_ENABLED:'1',ANTHROPIC_API_KEY:'synthetic',SYNC_KEY:'x'.repeat(32),GAS_URL:'https://script.google.com/macros/s/synthetic/exec'};
 const options={fetcher:async()=>{reads++;return Response.json({ok:true,base64:Buffer.from('%PDF-1.4 test').toString('base64')});},aiFetch:async(url,opt)=>{ai++;payload=JSON.parse(opt.body);return Response.json({content:[{type:'tool_use',name:'school_events',input:{events:[event,{...event,title:'他学年',audience:'other'},{...event,title:'対象不明',audience:'unknown'}],summary:'テスト候補'}}]});}};
 return {h,p,env,options,call:(b)=>handleDocuments(b,env,options),counts:()=>({ai,reads}),payload:()=>payload};
}
const req={action:'documentParse',token:TEACHER_TOKEN,studentId:'test-a',id:'doc',year:2026};
test('teacher only; ownership and invalid year checked before reading/AI',async()=>{
 const s=await setup();for(const b of [{...req,token:'bad'},{...req,token:undefined,k:'synthetic-link-a'},{...req,studentId:'test-b'},{...req,year:'oops'}])assert.ok((await s.call(b)).error);
 assert.deepEqual(s.counts(),{ai:0,reads:0});
});
test('PDF and registered grade are sent, unrelated grades excluded, same result reused',async()=>{
 const s=await setup();const result=await s.call(req);assert.equal(result.ok,true);assert.equal(result.grade,'中学3年生');assert.equal(result.events.length,2);assert.equal(result.events[1].review,true);
 assert.match(s.payload().system,/中学3年生/);assert.equal(s.payload().messages[0].content[0].type,'document');assert.ok(!JSON.stringify(s.payload()).includes('test-a'));
 assert.equal((await s.call(req)).cached,true);assert.deepEqual(s.counts(),{ai:1,reads:1});
 await s.p.d1.prepare("update _studentDocuments set removedAt = 'removed'").run();assert.ok((await s.call(req)).error);
});
test('lock, quota and upstream errors do not register events; retry works',async()=>{
 const s=await setup();await s.p.d1.prepare('update _studentDocuments set parseUntil = ?').bind(new Date(Date.now()+60000).toISOString()).run();assert.ok((await s.call(req)).error);assert.equal(s.counts().ai,0);
 await s.p.d1.prepare("update _studentDocuments set parseUntil = ''").run();const real=s.options.aiFetch;s.options.aiFetch=async()=>{throw Error('offline');};assert.ok((await s.call(req)).error);assert.equal((await s.p.d1.prepare('select parseUntil from _studentDocuments').first()).parseUntil,'');
 s.options.aiFetch=real;assert.equal((await s.call(req)).ok,true);
 assert.equal((await s.p.d1.prepare('select count(*) n from events').first()).n,0);
 await s.p.d1.prepare("update _studentDocuments set analysis = ''").run();for(let i=0;i<10;i++)await s.p.d1.prepare('insert into _nl_usage (scope,createdAt) values (?,?)').bind('document:teacher',new Date().toISOString()).run();assert.match((await s.call(req)).error,/10回/);
});
test('normalization rejects impossible dates, outside year, reversed ranges and duplicates',async()=>{
 const {normalizeEvents}=await import('../cf/worker/document-parse.mjs');const r=normalizeEvents({events:[event,event,{...event,date:'2026-02-30'},{...event,date:'2025-09-01'},{...event,dateTo:'2026-09-30'}]},2026);assert.equal(r.events.length,1);
 assert.throws(()=>normalizeEvents({events:'bad'},2026));
});
test('confirmed events persist once across retries and never block lessons',async()=>{
 const s=await setup(),{runWrite}=await import('../cf/worker/write.mjs');const b={action:'admin',op:'documentEventAdd',token:TEACHER_TOKEN,studentId:'test-a',...event};
 assert.equal((await runWrite(b,s.env)).result.ok,true);assert.equal((await runWrite(b,s.env)).result.existing,true);
 assert.equal((await s.p.d1.prepare('select count(*) n from events').first()).n,1);assert.equal((await s.p.d1.prepare('select count(*) n from blocked').first()).n,0);
 assert.ok((await runWrite({...b,token:'wrong',title:'other'},s.env)).result.error);
 assert.ok((await runWrite({...b,date:'2026-02-30'},s.env)).result.error);
});

test('missing grade is conservative, grade/year changes bypass cache, truncated output is retryable',async()=>{
 const {normalizeEvents}=await import('../cf/worker/document-parse.mjs');assert.equal(normalizeEvents({events:[event]},2026,'').events[0].review,true);
 const s=await setup();await s.call(req);const cached=await s.p.d1.prepare('select analysis from _studentDocuments').first();assert.ok(cached.analysis);
 assert.equal((await s.call({...req,year:2027})).cached,undefined);assert.equal(s.counts().ai,2);
 await s.p.d1.prepare("update _studentDocuments set analysis = ''").run();s.options.aiFetch=async()=>Response.json({stop_reason:'max_tokens',content:[]});assert.match((await s.call(req)).error,/分けたPDF/);
 assert.equal((await s.p.d1.prepare('select analysis from _studentDocuments').first()).analysis,'');
});
