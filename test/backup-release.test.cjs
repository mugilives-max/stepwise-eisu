const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const release=require('../scripts/gas-release.cjs');
test('release preserves manifest and remote Japanese name, normalizes line endings',()=>{
 const remote={'コード.js':'old','appsscript.json':'{"oauthScopes":["existing"]}'};
 const staged=release.stageSources(remote,{'Code.gs':'new','Backup.gs':'backup'});
 assert.equal(staged['コード.js'],'new');assert.equal(staged['Backup.js'],'backup');assert.equal(staged['appsscript.json'],remote['appsscript.json']);
 release.baselineCheck(remote,n=>{assert.equal(n,'Code.gs');return 'old\r\n';});
 assert.equal(release.hash('a\r\nb'),release.hash('a\nb\n'));
});
test('release refuses drift, unmanaged files, missing manifest and implicit deletion',()=>{
 assert.throws(()=>release.baselineCheck({'コード.js':'unexpected'},()=> 'expected'),/diverged/);
 assert.throws(()=>release.baselineCheck({'index.html':'x'},()=> ''),/Unmanaged/);
 assert.throws(()=>release.stageSources({'obsolete.js':'x','appsscript.json':'{}'},{'Code.gs':'x'}),/deletion/);
 assert.throws(()=>release.stageSources({}, {'Code.gs':'x'}),/manifest/);
 assert.throws(()=>release.stageSources({'コード.js':'x','Code.gs':'y','appsscript.json':'{}'},{'Code.gs':'x'}),/Ambiguous/);
});
function fixture(){
 let sequence=0;const all=new Map(),books=new Map(),props={},triggers=[];
 const iterator=a=>{let i=0;return {hasNext:()=>i<a.length,next:()=>a[i++]};};
 function file(name,body='',folder=null){const f={id:'file-'+(++sequence),name,body,folder,access:'PRIVATE',editors:[],viewers:[],trashed:false,
 getId(){return this.id;},getName(){return this.name;},getSharingAccess(){return this.access;},getEditors(){return this.editors;},getViewers(){return this.viewers;},
 getSize(){return Buffer.byteLength(this.body);},getLastUpdated(){return new Date('2026-09-09T00:00:00Z');},
 getBlob(){return {getDataAsString:()=>this.body,getBytes:()=>[...Buffer.from(this.body)]};},setContent(s){this.body=s;return this;},setTrashed(v){this.trashed=v;},
 makeCopy(n,dest){const c=file(n,this.body,dest.id);if(books.has(this.id))books.set(c.id,structuredClone(books.get(this.id)));return c;}};
 all.set(f.id,f);return f;
 }
 function folder(name){const f=file(name);f.createFile=(n,b)=>file(n,b,f.id);f.createFolder=n=>{const c=folder(n);c.folder=f.id;return c;};f.getFiles=()=>iterator([...all.values()].filter(x=>x.folder===f.id&&!x.trashed&&!x.createFile));f.getFilesByName=n=>iterator([...all.values()].filter(x=>x.folder===f.id&&x.name===n&&!x.trashed));return f;}
 function book(id){return {getId:()=>id,getSheets:()=>books.get(id).map(s=>({getName:()=>s.name,getDataRange:()=>({getNumRows:()=>s.values.length,getNumColumns:()=>s.values[0].length,getValues:()=>s.values,getFormulas:()=>s.formulas})}))};}
 const one=file('reservation'),two=file('ledger');for(const b of [one,two])books.set(b.id,[{name:'data',values:[['header'],[new Date('2026-09-08')]],formulas:[[''],['=1+1']]}]);
 const pdfFolder=folder('PDF');pdfFolder.createFile('exam.pdf','%PDF-synthetic');props.EXAM_PDF_FOLDER_ID=pdfFolder.id;props.SECRET='synthetic-secret';
 const context={Date,JSON,Error,LEDGER_ID:two.id,ss_:()=>book(one.id),
 Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(alg,v)=>[...crypto.createHash(alg).update(v).digest()]},
 DriveApp:{Access:{PRIVATE:'PRIVATE'},createFolder:folder,getFolderById:id=>all.get(id),getFileById:id=>all.get(id)},
 SpreadsheetApp:{openById:book},MimeType:{PLAIN_TEXT:'text/plain'},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty:(k,v)=>{props[k]=v;},getProperties:()=>({...props})})},
 LockService:{getScriptLock:()=>({waitLock(){},tryLock:()=>true,releaseLock(){}})},
 ScriptApp:{getScriptId:()=> 'script',getProjectTriggers:()=>triggers.slice(),deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1),WeekDay:{SUNDAY:'Sunday'},newTrigger(handler){const t={getHandlerFunction:()=>handler};const builder={timeBased(){return this;},onWeekDay(){return this;},atHour(){return this;},inTimezone(){return this;},everyMinutes(){return this;},create(){triggers.push(t);return t;}};return builder;}}
 };
 vm.createContext(context);vm.runInContext(fs.readFileSync('gas/Backup.gs','utf8'),context);
 return {c:context,props,all,books,one,two,triggers,pdfFolder,finish(){for(let i=0;i<10&&context.stepwiseBackupStatus().status==='running';i++)context.continueStepwiseBackup();}};
}
test('weekly setup is idempotent and preserves unrelated triggers',()=>{
 const h=fixture(),other={getHandlerFunction:()=> 'unrelated'};h.triggers.push(other);h.c.setupStepwiseBackups();h.c.setupStepwiseBackups();
 assert.equal(h.triggers.length,2);assert.ok(h.triggers.includes(other));
 h.c.stopStepwiseBackups();assert.deepEqual(h.triggers,[other]);
});
test('backup compares both books/PDF/settings and verifies isolated restore without production writes',()=>{
 const h=fixture();h.c.setupStepwiseBackups();const before=JSON.stringify([...h.books]);h.c.startStepwiseBackup();h.finish();
 assert.equal(h.c.stepwiseBackupStatus().status,'complete');assert.ok(h.props.STEPWISE_BACKUP_LATEST);
 const result=h.c.verifyStepwiseBackupRestore();assert.equal(result.books,2);assert.equal(result.pdfs,1);
 assert.equal(JSON.stringify([...h.books].slice(0,2)),before);assert.ok(h.props.STEPWISE_BACKUP_RESTORE_CHECK);
 assert.equal(h.triggers.length,1);assert.ok([...h.all.values()].some(f=>f.name.startsWith('【テスト】')&&f.trashed));
});
test('changed source fails closed and retains previous good backup',()=>{
 const h=fixture();h.c.setupStepwiseBackups();h.c.startStepwiseBackup();h.finish();const latest=h.props.STEPWISE_BACKUP_LATEST;
 h.c.startStepwiseBackup();h.books.get(h.one.id)[0].values[0][0]='changed';assert.throws(()=>h.c.continueStepwiseBackup(),/backup failed/);
 assert.equal(h.c.stepwiseBackupStatus().status,'failed');assert.equal(h.props.STEPWISE_BACKUP_LATEST,latest);
});
test('public folder and copied-script execution are refused',()=>{
 const h=fixture();h.c.setupStepwiseBackups();h.all.get(h.props.STEPWISE_BACKUP_FOLDER).access='ANYONE';assert.throws(()=>h.c.startStepwiseBackup(),/owner-only/);
 h.props.STEPWISE_BACKUP_SCRIPT='other-script';assert.throws(()=>h.c.startStepwiseBackup(),/setup required/);assert.throws(()=>h.c.setupStepwiseBackups(),/Copied script/);
});
test('partial copy is reused on resumed execution and pending worker is recovered',()=>{
 const h=fixture();h.c.setupStepwiseBackups();h.c.startStepwiseBackup();const state=JSON.parse(h.props.STEPWISE_BACKUP_STATE),m=JSON.parse(h.all.get(state.manifest).body);
 h.one.makeCopy('book_'+h.one.id,h.all.get(m.folder));h.c.startStepwiseBackup();h.finish();
 assert.equal(h.c.stepwiseBackupStatus().status,'complete');assert.equal([...h.all.values()].filter(f=>f.folder===m.folder&&f.name==='book_'+h.one.id).length,1);
});
test('tampered stored settings fail restore check',()=>{
 const h=fixture();h.c.setupStepwiseBackups();h.c.startStepwiseBackup();h.finish();const m=JSON.parse(h.all.get(h.props.STEPWISE_BACKUP_LATEST).body);h.all.get(m.config).body='[]';
 assert.throws(()=>h.c.verifyStepwiseBackupRestore(),/properties changed/);assert.equal(h.props.STEPWISE_BACKUP_RESTORE_CHECK,undefined);
});
