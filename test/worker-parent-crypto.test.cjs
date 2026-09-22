'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{pbkdf2Sync}=require('node:crypto');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
const {createParity}=require('./helpers/parity-harness.cjs');
const bytes=s=>new TextEncoder().encode(s);
const limit=()=>Object.assign(new Error('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).'),{name:'NotSupportedError'});
test.before(async()=>{(await import('../scripts/build-gas-bundle.mjs')).generate();});

test('native crypto succeeds without fallback',async()=>{
  const {parentCrypto}=await import('../cf/lib/parent-crypto.mjs');
  const p=bytes('Synthetic password!'),s=bytes('synthetic-salt');
  const hash=parentCrypto({derive(){throw Error('Unneeded fallback');}}).derive(p,s,1000);
  assert.equal(hash,pbkdf2Sync(p,s,1000,32,'sha256').toString('hex'));
});

test('hosted iteration limit preserves all 600000 rounds and UTF-8 hashes with bundled crypto',async()=>{
  const {parentCrypto}=await import('../cf/lib/parent-crypto.mjs');
  const fallback=createFamilyHarness().context().StepwiseParentCrypto;
  for(const [pass,salt] of [[' Synthetic parent password! ','salt-123'],[' 日本語のパスワード🔑 ','ソルト']]){
    const p=bytes(pass),s=bytes(salt);let calls=0;
    const hash=parentCrypto({derive(a,b,n){calls++;assert.equal(a,p);assert.equal(b,s);assert.equal(n,600000);return fallback.derive(a,b,n);}},()=>{throw limit();}).derive(p,s,600000);
    assert.equal(hash,pbkdf2Sync(p,s,600000,32,'sha256').toString('hex'));assert.equal(calls,1);
  }
});

test('unrelated failures never trigger fallback and fallback failures remain failures',async()=>{
  const {parentCrypto}=await import('../cf/lib/parent-crypto.mjs');
  for(const error of [new RangeError('invalid rounds'),Object.assign(new Error('Another algorithm is unsupported'),{name:'NotSupportedError'}),new Error('Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).')]){
    let called=false;assert.throws(()=>parentCrypto({derive(){called=true;}},()=>{throw error;}).derive(bytes('x'),bytes('y'),600000),e=>e===error);assert.equal(called,false);
  }
  const error=new Error('Fallback unavailable');assert.throws(()=>parentCrypto({derive(){throw error;}},()=>{throw limit();}).derive(bytes('x'),bytes('y'),600000),e=>e===error);
});

test('existing 600000-round family account logs in, rejects wrong passwords and revokes logout on Worker',async()=>{
  const h=createFamilyHarness(),pass='Synthetic production password!',email='worker-crypto@example.invalid';
  h.admin('state');const family=h.admin('familyCreate',{label:'【テスト】Worker認証',studentIds:['test-a']});
  h.family('familyRegister',{inviteCode:family.inviteCode,email});const challenge=h.latestChallenge();h.family('familyVerify',{challenge});h.family('familyCompleteRegistration',{challenge,pass});
  const a=h.rows('familyAccounts').find(a=>a.email===email);const hash='pbkdf2-sha256$600000$'+pbkdf2Sync(pass,a.passSalt,600000,32,'sha256').toString('hex');h.setRow('familyAccounts','id',a.id,{passHash:hash});
  const p=await createParity(h),{runWrite}=await import('../cf/worker/write.mjs');
  const call=async body=>(await runWrite(body,p.env,{now:h.now()})).result;
  assert.ok((await call({action:'familyLogin',email,pass:pass+'wrong'})).error);
  const logged=await call({action:'familyLogin',email,pass});assert.equal(logged.ok,true);assert.ok(logged.ftoken);assert.equal(logged.children.length,1);
  assert.equal((await p.worker({action:'familyHome',ftoken:logged.ftoken})).ok,true);
  assert.equal((await p.d1.prepare('SELECT passHash FROM familyAccounts WHERE id=?').bind(a.id).first()).passHash,hash);
  assert.equal((await call({action:'familyLogout',ftoken:logged.ftoken})).ok,true);
  assert.ok((await p.worker({action:'familyHome',ftoken:logged.ftoken})).familyAuthRequired);
});

async function fixture(registered=true) {
  const h=createFamilyHarness(),pass=' Synthetic 日本語 password! ',email='delegated@example.invalid';
  h.admin('state');const f=h.admin('familyCreate',{label:'【テスト】計算委譲',studentIds:['test-a']});
  h.family('familyRegister',{inviteCode:f.inviteCode,email});const challenge=h.latestChallenge();h.family('familyVerify',{challenge});
  if(registered)h.family('familyCompleteRegistration',{challenge,pass});
  const a=h.rows('familyAccounts').find(x=>x.email===email);
  if(registered)h.setRow('familyAccounts','id',a.id,{passHash:'pbkdf2-sha256$600000$'+pbkdf2Sync(pass,a.passSalt,600000,32,'sha256').toString('hex')});
  const p=await createParity(h);
  Object.assign(p.env,{GAS_URL:'https://script.google.com/macros/s/synthetic/exec',SYNC_KEY:'synthetic-private-key-for-test-only'});
  const {runWrite}=await import('../cf/worker/write.mjs');
  let calls=0,hook=async()=>{};
  const options={now:h.now(),parentCrypto:{nativeDerive(){throw limit();},async fetcher(url,init){
    calls++;assert.equal(url,p.env.GAS_URL);const req=JSON.parse(init.body);
    assert.equal(req.action,'parentCrypto');assert.equal(req.key,p.env.SYNC_KEY);assert.equal(req.iterations,600000);
    await hook(req);
    return Response.json({ok:true,derived:pbkdf2Sync(Buffer.from(req.passBytes,'base64'),Buffer.from(req.saltBytes,'base64'),req.iterations,32,'sha256').toString('hex')});
  }}};
  return {h,p,a,pass,email,challenge,options,calls:()=>calls,hook:f=>{hook=f;},call:body=>runWrite(body,p.env,options),account:()=>p.d1.prepare('SELECT * FROM familyAccounts WHERE id=?').bind(a.id).first()};
}

test('delegated login commits only once, preserves hash, locks after five failures and revokes logout',async()=>{
  const f=await fixture(),before=await f.account();
  for(let n=1;n<=5;n++){
    const out=await f.call({action:'familyLogin',email:f.email,pass:f.pass+'wrong'});
    assert.ok(out.result.error);assert.equal(out.effects.length,0);assert.equal((await f.account()).failCount,n);assert.equal(f.calls(),n);
  }
  assert.ok((await f.call({action:'familyLogin',email:f.email,pass:f.pass})).result.error);assert.equal(f.calls(),5);
  f.options.now+=16*60*1000;
  const logged=await f.call({action:'familyLogin',email:f.email,pass:f.pass});assert.equal(logged.result.ok,true);assert.ok(logged.result.ftoken);assert.equal(f.calls(),6);
  const after=await f.account();assert.equal(after.passHash,before.passHash);assert.equal(after.passSalt,before.passSalt);assert.equal(after.failCount,0);assert.equal(JSON.parse(after.tokenHash).length,1);
  assert.equal((await f.call({action:'familyLogout',ftoken:logged.result.ftoken})).result.ok,true);assert.equal((await f.account()).tokenHash,'');
});

test('delegation reloads account changes and never authenticates a disabled or changed account',async()=>{
  for(const column of ['status','passSalt']){
    const f=await fixture();f.hook(async()=>{await f.p.d1.prepare(`UPDATE familyAccounts SET ${column}=? WHERE id=?`).bind(column==='status'?'disabled':'changed-salt',f.a.id).run();});
    const result=await f.call({action:'familyLogin',email:f.email,pass:f.pass});assert.ok(result.result.error);assert.equal((await f.account()).tokenHash,'');
  }
});

test('delegated registration and reset keep one fresh salt across retries and consume proof once',async()=>{
  const f=await fixture(false);
  const complete=await f.call({action:'familyCompleteRegistration',challenge:f.challenge,pass:f.pass});assert.equal(complete.result.registered,true);assert.equal(f.calls(),1);
  let account=await f.account();assert.equal(account.passHash,'pbkdf2-sha256$600000$'+pbkdf2Sync(f.pass,account.passSalt,600000,32,'sha256').toString('hex'));const firstSalt=account.passSalt;
  assert.ok((await f.call({action:'familyCompleteRegistration',challenge:f.challenge,pass:f.pass})).result.error);assert.equal(f.calls(),1);
  const logged=(await f.call({action:'familyLogin',email:f.email,pass:f.pass})).result;assert.ok(logged.ftoken);
  const {createHash}=require('node:crypto'),id='synthetic-reset',secret='a'.repeat(64),token='fc1.'+id+'.'+secret;
  account=await f.account();
  await f.p.d1.prepare('INSERT INTO familyChallenges(id,familyId,kind,email,secretHash,expiresAt,securityVersion) VALUES(?,?,?,?,?,?,?)').bind(id,f.a.id,'reset',f.email,createHash('sha256').update('parent-v2:family-challenge:'+id+':'+secret).digest('hex'),f.options.now+60000,account.securityVersion).run();
  const pass='New synthetic password!';assert.equal((await f.call({action:'familyResetConfirm',challenge:token,pass})).result.reset,true);
  account=await f.account();assert.notEqual(account.passSalt,firstSalt);assert.equal(account.tokenHash,'');assert.equal(account.passHash,'pbkdf2-sha256$600000$'+pbkdf2Sync(pass,account.passSalt,600000,32,'sha256').toString('hex'));
  assert.ok((await f.call({action:'familyResetConfirm',challenge:token,pass})).result.error);
});

test('failed computation never saves speculative data or emits effects',async()=>{
  for(const fetcher of [async()=>{throw Error('network');},async()=>new Response('',{status:503}),async()=>Response.json({ok:true,derived:'bad'}),async()=>Response.json({error:'unauthorized'})]){
    const f=await fixture(),before=await f.account(),version=await f.p.d1.prepare('SELECT version FROM _ledger').first();f.options.parentCrypto.fetcher=fetcher;
    await assert.rejects(f.call({action:'familyLogin',email:f.email,pass:f.pass}),/Password computation service unavailable/);
    assert.deepEqual(await f.account(),before);assert.deepEqual(await f.p.d1.prepare('SELECT version FROM _ledger').first(),version);
  }
});

test('a registration proof revoked during computation is rechecked before any account commit',async()=>{
  const f=await fixture(false);f.hook(async()=>{await f.p.d1.prepare('UPDATE familyChallenges SET usedAt=? WHERE familyId=?').bind('revoked-during-computation',f.a.id).run();});
  assert.ok((await f.call({action:'familyCompleteRegistration',challenge:f.challenge,pass:f.pass})).result.error);assert.equal((await f.account()).passHash,'');assert.equal(f.calls(),1);
});

test('public Worker callers cannot use the internal computation operation',async()=>{
  const f=await fixture();const out=await f.call({action:'parentCrypto',key:f.p.env.SYNC_KEY,iterations:600000,passBytes:'eA==',saltBytes:'eQ=='});
  assert.equal(out.result.badAuth,true);assert.equal(f.calls(),0);assert.equal(out.effects.length,0);
});

test('GAS computation authenticates before KDF and does not access sheets, lock or sync',()=>{
  const key='synthetic-private-key-for-test-only',h=createFamilyHarness({properties:{WORKER_SYNC_KEY:key,WORKER_OWNS_LEDGER:'1'}}),c=h.context();
  c.ensureSchema_=()=>{throw Error('must not access ledger');};c.syncPush_=()=>{throw Error('must not sync');};c.LockService.getScriptLock=()=>({waitLock(){throw Error('must not lock');}});
  let calls=0;c.StepwiseParentCrypto={derive(p,s,n){calls++;return pbkdf2Sync(Buffer.from(p),Buffer.from(s),n,32,'sha256').toString('hex');}};
  const input={action:'parentCrypto',key,iterations:600000,passBytes:Buffer.from(' 日本語🔑 ').toString('base64'),saltBytes:Buffer.from('salt').toString('base64')};
  const call=req=>JSON.parse(c.doPost({postData:{contents:JSON.stringify(req)}}).getContent());
  for(const bad of [{key:''},{key:'x'.repeat(257)},{iterations:100000},{passBytes:''},{passBytes:'!bad'},{passBytes:Buffer.alloc(513).toString('base64')},{saltBytes:Buffer.alloc(257).toString('base64')}])assert.ok(call({...input,...bad}).error);
  assert.equal(calls,0);const result=call(input);assert.equal(result.ok,true);assert.equal(result.derived,pbkdf2Sync(' 日本語🔑 ','salt',600000,32,'sha256').toString('hex'));assert.equal(calls,1);assert.equal(h.effects.length,0);
  h.properties.set('WORKER_OWNS_LEDGER','0');assert.ok(call(input).error);assert.equal(calls,1);
});
