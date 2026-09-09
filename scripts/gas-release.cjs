// Deployment credentials and pulled production sources stay outside Git.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const CLASP = path.join(ROOT, 'node_modules/@google/clasp/build/src/index.js');
const SCRIPT = '1vlfS4thMpRgV0WbHXZ8joFLzZBMmoROdopAJXK6JEIQWplokSgvgo619';
const DEPLOY = 'AKfycbz53sl4GgKNY1UY1gaBndjDplQk5MrA9EfShYfy05Jl4JNEFEl7-B1uKSmd0v5Mhn4Irw';
const BASE = path.join(ROOT, '.verification', 'releases');
const norm = s => s.replace(/\r\n/g, '\n').trimEnd() + '\n';
const hash = s => crypto.createHash('sha256').update(norm(s)).digest('hex');
function run(cmd, args, cwd=ROOT) {
  const r=spawnSync(cmd,args,{cwd,encoding:'utf8',maxBuffer:16*1024*1024,timeout:180000,windowsHide:true});
  if(r.error||r.status!==0) throw Error(`${path.basename(cmd)} failed: ${(r.stderr||r.error?.message||r.stdout||'').slice(0,1500)}`);
  return r.stdout.trim();
}
function git(...args){return run('git',args);}
function clean(){if(git('status','--porcelain'))throw Error('Commit or preserve working changes before planning a release.');}
function json(file, value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
function clasp(dir,...args){return JSON.parse(run(process.execPath,[CLASP,'--json','-P',path.join(dir,'.clasp.json'),...args],dir));}
function project(dir){fs.mkdirSync(dir,{recursive:true});json(path.join(dir,'.clasp.json'),{scriptId:SCRIPT,rootDir:'.'});}
function pull(dir,version){project(dir);clasp(dir,'pull',...(version?['--versionNumber',String(version)]:[]));return files(dir);}
function files(dir){
  const out={};
  for(const n of fs.readdirSync(dir)){
    if(n.startsWith('.'))continue;
    const p=path.join(dir,n);if(!fs.statSync(p).isFile())throw Error('Unexpected source directory: '+n);
    if(!/\.(gs|js|html|json)$/.test(n))throw Error('Unexpected source file: '+n);
    out[n]=fs.readFileSync(p,'utf8');
  }
  return out;
}
function digest(files){return Object.fromEntries(Object.keys(files).sort().map(k=>[k,hash(files[k])]));}
function same(a,b){return JSON.stringify(digest(a))===JSON.stringify(digest(b));}
function canonical(name){return name.replace(/^コード\./,'Code.').replace(/\.js$/,'.gs');}
function uniqueNames(remote){const names=Object.keys(remote).map(canonical);if(new Set(names).size!==names.length)throw Error('Ambiguous remote filenames');}
function baselineCheck(remote,baseline){
  uniqueNames(remote);
  for(const [n,body] of Object.entries(remote)){
    if(n==='appsscript.json')continue;
    const name=canonical(n);
    if(!name.endsWith('.gs'))throw Error('Unmanaged remote file: '+n);
    if(hash(body)!==hash(baseline(name)))throw Error('Remote diverged from Git baseline: '+n);
  }
}
function stageSources(remote,local){
  uniqueNames(remote);
  const stage={...remote};
  for(const n of Object.keys(remote))if(n!=='appsscript.json'&&!Object.hasOwn(local,canonical(n)))throw Error('Remote deletion needs a separately reviewed migration: '+n);
  for(const [n,body] of Object.entries(local)){
    const remoteName=Object.keys(remote).find(r=>canonical(r)===n)||n.replace(/\.gs$/,'.js');stage[remoteName]=body;
  }
  if(!stage['appsscript.json'])throw Error('Missing production manifest');
  return stage;
}
function target(dir){const d=clasp(dir,'list-deployments',SCRIPT).find(d=>d.deploymentId===DEPLOY);if(!d?.versionNumber)throw Error('Existing deployment not found');return d;}
function load(id){if(!/^[0-9TZ-]+$/.test(id||''))throw Error('Use the release ID printed by plan.');const dir=path.join(BASE,id);const p=JSON.parse(fs.readFileSync(path.join(dir,'plan.json'),'utf8'));if(p.script!==SCRIPT||p.deployment!==DEPLOY)throw Error('Wrong project');return {dir,p};}
function save(dir,p){json(path.join(dir,'plan.json'),p);}
async function health(expected){
  let last;
  for(let i=0;i<3;i++){
    try{const r=await fetch(`https://script.google.com/macros/s/${DEPLOY}/exec`,{signal:AbortSignal.timeout(60000)});const b=await r.json();if(r.ok&&b.ok&&b.release===expected)return b;last='unexpected response';}catch(e){last=e.message;}
    if(i<2)await new Promise(r=>setTimeout(r,10000));
  }
  throw Error('Public verification failed; deployment left for inspection: '+last);
}
async function main(args){
  const [command,id]=args;
  if(command==='login'){const r=spawnSync(process.execPath,[CLASP,'login'],{cwd:ROOT,stdio:'inherit',windowsHide:true});if(r.status!==0)throw Error('Google login not completed');return;}
  if(command==='plan'){
    clean();run(process.execPath,['scripts/check-syntax.cjs']);
    const base=args[1]||'origin/main',head=git('rev-parse','HEAD'),baseline=git('rev-parse',base);
    const id=new Date().toISOString().replace(/[:.]/g,'-'),dir=path.join(BASE,id),beforeDir=path.join(dir,'before');
    project(beforeDir);const deployment=target(beforeDir),remote=pull(beforeDir);
    baselineCheck(remote,n=>git('show',`${baseline}:gas/${n}`));
    const published=pull(path.join(dir,'published'),deployment.versionNumber);
    if(!same(remote,published))throw Error('Editor HEAD differs from deployed source. Reconcile it before release.');
    const local=Object.fromEntries(fs.readdirSync(path.join(ROOT,'gas')).filter(n=>n.endsWith('.gs')).map(n=>[n,fs.readFileSync(path.join(ROOT,'gas',n),'utf8')]));
    const stage=stageSources(remote,local),stageDir=path.join(dir,'stage');project(stageDir);
    for(const [n,body] of Object.entries(stage))fs.writeFileSync(path.join(stageDir,n),norm(body));
    const expected=local['Code.gs'].match(/release:\s*'([^']+)'/)?.[1];if(!expected)throw Error('Release marker missing');
    const p={script:SCRIPT,deployment:DEPLOY,id,head,baseline,oldVersion:deployment.versionNumber,oldDescription:deployment.description||'',oldRelease:published[Object.keys(published).find(n=>canonical(n)==='Code.gs')]?.match(/release:\s*'([^']+)'/)?.[1],expected,before:digest(remote),stage:digest(stage),status:'planned'};
    if(p.oldRelease===expected&&!same(stage,remote))throw Error('Change the release marker before deploying code changes.');
    save(dir,p);console.log(JSON.stringify({id,oldVersion:p.oldVersion,expected,changed:Object.keys(stage).filter(n=>hash(stage[n])!==hash(remote[n]||'')),next:`npm run gas:apply -- ${id}`},null,2));return;
  }
  if(command==='apply'||command==='stage'){
    const {dir,p}=load(id);clean();if(git('rev-parse','HEAD')!==p.head)throw Error('Git HEAD changed; make a new plan.');
    const stage=files(path.join(dir,'stage'));if(JSON.stringify(digest(stage))!==JSON.stringify(p.stage))throw Error('Staged files changed');
    let deployment=target(path.join(dir,'stage'));
    if(p.status==='complete'){console.log('Already complete');return;}
    if(deployment.versionNumber!==p.oldVersion&&deployment.versionNumber!==p.newVersion)throw Error('Deployment changed by another actor');
    const remote=pull(path.join(dir,'check-'+Date.now()));
    if(p.status==='planned'){
      if(JSON.stringify(digest(remote))!==JSON.stringify(p.before))throw Error('Editor changed since plan');
      p.status='pushing';save(dir,p);clasp(path.join(dir,'stage'),'push','--force');
    }else if(!same(remote,stage))throw Error('Partial/unknown push; inspect before restarting, do not overwrite automatically.');
    const readback=pull(path.join(dir,'readback-'+Date.now()));if(!same(readback,stage))throw Error('Readback mismatch; existing deployment preserved');
    if(command==='stage'){if(p.newVersion)throw Error('Version already created; use apply');p.status='staged';save(dir,p);console.log('Editor verified; public deployment unchanged. Complete schema preparation, then apply the same ID.');return;}
    if(!p.newVersion){
      if(p.status==='creating-version')throw Error('Version creation outcome unknown. Inspect versions before making a new plan.');
      p.status='creating-version';save(dir,p);p.newVersion=clasp(path.join(dir,'stage'),'create-version',`${p.expected} ${p.head.slice(0,8)}`).versionNumber;
      if(!Number.isInteger(p.newVersion))throw Error('Missing version');p.status='version-created';save(dir,p);
    }
    if(!same(pull(path.join(dir,'version-'+Date.now()),p.newVersion),stage))throw Error('Immutable version mismatch');
    deployment=target(path.join(dir,'stage'));
    if(deployment.versionNumber!==p.oldVersion&&deployment.versionNumber!==p.newVersion)throw Error('Deployment changed before publishing');
    p.status='publishing';save(dir,p);
    clasp(path.join(dir,'stage'),'update-deployment',DEPLOY,'--versionNumber',String(p.newVersion),'--description',p.expected);
    if(target(path.join(dir,'stage')).versionNumber!==p.newVersion)throw Error('Deployment verification failed');
    json(path.join(dir,'health.json'),await health(p.expected));p.status='complete';save(dir,p);console.log(`Published v${p.newVersion}; previous v${p.oldVersion}; ${p.expected}`);return;
  }
  if(command==='rollback'){
    const {dir,p}=load(id);if(!p.newVersion||!p.oldRelease)throw Error('No verified rollback target');
    const current=target(path.join(dir,'stage'));if(current.versionNumber!==p.newVersion)throw Error('Deployment changed; inspect manually');
    clasp(path.join(dir,'stage'),'update-deployment',DEPLOY,'--versionNumber',String(p.oldVersion),'--description',p.oldDescription);
    await health(p.oldRelease);p.status='rolled-back';save(dir,p);console.log('Previous deployment restored. Editor HEAD and business data were not rolled back.');return;
  }
  throw Error('Commands: login | plan [Git baseline] | apply <release-id> | rollback <release-id>');
}
module.exports={norm,hash,canonical,baselineCheck,stageSources,same};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
