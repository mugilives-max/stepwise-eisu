const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(){const h=createFamilyHarness();h.admin('state');const sh=h.spreadsheet.getSheetByName('slots'),slot={id:'read-slot',studentId:'test-a',date:'2026-09-06',start:'10:00',min:60,status:'booked',subject:'英語'};sh.appendRow(sh.values[0].map(k=>slot[k]??''));
 h.save=(revision=0)=>ok(h.admin('lessonRecordSave',{studentId:'test-a',slotId:'read-slot',expectedRevision:revision,requestId:'read-save-'+revision,record:{content:'本文'+revision,teacherNote:'SECRET'}}));
 const family=ok(h.admin('familyCreate',{label:'【テスト】保護者',studentIds:['test-a']}));ok(h.family('familyRegister',{inviteCode:family.inviteCode,email:'read@example.invalid',pass:'Synthetic password!'}));ok(h.family('familyVerify',{challenge:h.latestChallenge()}));h.token=ok(h.family('familyLogin',{email:'read@example.invalid',pass:'Synthetic password!'})).ftoken;
 h.read=(op,args={})=>h.request({action:'learningService',op,ftoken:h.token,studentId:'test-a',...args});return h;}
test('opening reads one published revision, repeat is idempotent and newer revision stays unread',()=>{
 const h=fixture(),r=h.save();assert.equal(ok(h.read('recordReadStatus')).reads[0].readRevision,0);assert.equal(h.rows('lessonReadReceipts').length,0);
 ok(h.read('recordRead',{recordId:r.recordId,revision:1}));const before=JSON.stringify(h.rows('lessonReadReceipts'));ok(h.read('recordRead',{recordId:r.recordId,revision:1}));assert.equal(JSON.stringify(h.rows('lessonReadReceipts')),before);
 h.save(1);assert.equal(ok(h.read('recordReadStatus')).reads[0].readRevision,1);assert.equal(h.read('recordRead',{recordId:r.recordId,revision:1}).errorCode,'updated');assert.equal(h.read('recordRead',{recordId:r.recordId,revision:999}).errorCode,'updated');
 ok(h.read('recordRead',{recordId:r.recordId,revision:2}));assert.equal(ok(h.read('recordReadStatus')).reads[0].readRevision,2);assert.equal(h.rows('lessonReadReceipts').length,1);assert.equal(h.rows('approvalEvents').length,0);
});
test('student credentials, another child and unpublished records cannot mark parent reads',()=>{
 const h=fixture(),r=h.save();assert.ok(h.read('recordRead',{studentId:'test-b',recordId:r.recordId,revision:1}).error);
 assert.ok(h.request({action:'learningService',op:'recordRead',k:'synthetic-link-a',recordId:r.recordId,revision:1}).error);
 assert.ok(h.read('recordRead',{recordId:'missing',revision:1}).error);assert.equal(h.rows('lessonReadReceipts').length,0);
});
test('legacy parent account read state is separate from family account read state',()=>{
 const h=fixture(),r=h.save(),setup=ok(h.admin('parentIssueSetupCode',{studentId:'test-a'})),p=ok(h.request({action:'parentSetup',k:'synthetic-link-a',setupCode:setup.setupCode,pass:'Synthetic parent password!'}));
 const req={action:'learningService',op:'recordRead',k:'synthetic-link-a',ptoken:p.ptoken,recordId:r.recordId,revision:1};ok(h.request(req));assert.equal(ok(h.read('recordReadStatus')).reads[0].readRevision,0);
 assert.equal(ok(h.request({...req,op:'recordReadStatus'})).reads[0].readRevision,1);
});
const flush=()=>new Promise(r=>setImmediate(r));
function ui(){const label={textContent:''},el={dataset:{parentRecord:'r',recordRevision:'2'},open:false,matches:()=>true,querySelector:()=>label},calls=[];let listener;const host={addEventListener:(n,fn)=>listener=fn,removeEventListener:()=>listener=null,querySelectorAll:()=>[el]},c={window:{},console};vm.runInNewContext(fs.readFileSync('assets/lesson-read.js','utf8'),c);c.window.StepwiseLessonRead.mount(host,(op,payload)=>new Promise((resolve,reject)=>calls.push({op,payload,resolve,reject})),'parent');return {calls,label,el,api:c.window.StepwiseLessonRead,toggle:()=>listener({target:el})};}
test('UI listing and closing do not mark read; opening persists and stale load cannot undo result',async()=>{
 const u=ui();assert.equal(u.calls.length,1);assert.equal(u.calls[0].op,'recordReadStatus');u.toggle();assert.equal(u.calls.length,1);u.el.open=true;u.toggle();u.toggle();assert.equal(u.calls.length,2);
 u.calls[1].resolve({ok:true,reads:[{recordId:'r',readRevision:2}]});await flush();assert.equal(u.label.textContent,'既読');u.calls[0].resolve({ok:true,reads:[{recordId:'r',readRevision:0}]});await flush();assert.equal(u.label.textContent,'既読');
});
test('UI shows updates, keeps failed writes unconfirmed, retries and discards responses after clear',async()=>{
 const u=ui();u.calls[0].resolve({ok:true,reads:[{recordId:'r',readRevision:1}]});await flush();assert.equal(u.label.textContent,'更新あり');u.el.open=true;u.toggle();u.calls[1].reject(Error('offline'));await flush();assert.match(u.label.textContent,/未保存/);u.toggle();assert.equal(u.calls.length,3);u.api.clear();const before=u.label.textContent;u.calls[2].resolve({ok:true,reads:[{recordId:'r',readRevision:2}]});await flush();assert.equal(u.label.textContent,before);
});
