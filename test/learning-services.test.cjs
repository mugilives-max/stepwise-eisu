'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN,MCP_KEY}=require('./gas-harness.cjs');
function fixture(){
 const h=createHarness({iterations:10}),base=h.context,files=new Map();let next=1;
 const folder={getId:()=> 'private-folder',getSharingAccess:()=> 'PRIVATE',getViewers:()=>[],getEditors:()=>[],getFilesByName:name=>{const a=[...files.values()].filter(f=>f.name===name);return{hasNext:()=>!!a.length,next:()=>a.shift()};},createFile:blob=>{const id='file-'+next++;const f={id,name:blob.name,getId:()=>id,getSharingAccess:()=> 'PRIVATE',getViewers:()=>[],getEditors:()=>[],getMimeType:()=> 'application/pdf',getSize:()=>blob.bytes.length,getBlob:()=>({getBytes:()=>blob.bytes})};files.set(id,f);return f;}};
 h.context=()=>{const c=base();c.DriveApp={Access:{PRIVATE:'PRIVATE'},createFolder:()=>folder,getFolderById:()=>folder,getFileById:id=>files.get(id)};c.Utilities.newBlob=(bytes,mime,name)=>({bytes,name,getBytes:()=>bytes});return c;};
 h.request=req=>JSON.parse(h.context().doPost({postData:{contents:JSON.stringify(req)}}).getContent());
 h.admin=(op,args={})=>h.request({action:'admin',token:TEACHER_TOKEN,op,...args});
 h.public=(op,args={})=>h.request({action:'learningService',op,k:'synthetic-link-a',...args});h.files=files;
 h.slot=(patch={})=>{h.admin('state');let row={id:'svc-slot',studentId:'test-a',date:'2026-09-08',start:'13:00',min:60,status:'booked',done:'',eventId:'',meetUrl:'',subject:'数学',req:'',deliveryMode:'in_person',...patch};const sh=h.spreadsheet.getSheetByName('slots');sh.appendRow(sh.values[0].map(k=>row[k]??''));return row;};return h;
}
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
const exam={studentId:'test-a',requestId:'exam-request-0001',date:'2026-09-07',kind:'school',title:'定期テスト',reflection:'振り返り',analysis:'公開分析',nextSteps:'復習',teacherNote:'SECRET_TEACHER_NOTE',expectedRevision:0};
test('exam save exposes public fields to own student only and a single private note to teacher',()=>{
 const h=fixture(),saved=ok(h.admin('serviceExamSave',exam));const pub=ok(h.public('list'));assert.equal(pub.exams[0].analysis,'公開分析');assert.equal(JSON.stringify(pub).includes('SECRET'),false);assert.equal(ok(h.public('list',{k:'synthetic-link-b'})).exams.length,0);
 assert.equal(ok(h.admin('serviceList',{studentId:'test-a'})).exams[0].teacherNote,'SECRET_TEACHER_NOTE');assert.ok(h.public('examSave',exam).error);assert.ok(h.public('list',{studentId:'test-b'}).error);assert.ok(h.admin('serviceList',{studentId:'test-a',token:'wrong'}).error);assert.ok(h.admin('serviceList',{studentId:'test-a',mcpKey:MCP_KEY}).error);
 ok(h.admin('serviceExamSave',exam));assert.equal(h.rows('examReports').length,1);assert.ok(h.admin('serviceExamSave',{...exam,title:'changed'}).error);assert.equal(h.admin('serviceExamSave',{...exam,id:saved.id,requestId:'exam-request-0002'}).errorCode,'conflict');
});
test('PDF stays private, is served by ownership, and retries after a saved file do not duplicate it',()=>{
 const h=fixture(),pdf={mime:'application/pdf',name:'result.pdf',base64:Buffer.from('%PDF-1.7\nsynthetic').toString('base64')},payload={...exam,pdf};
 h.admin('serviceList',{studentId:'test-a'});const c=h.context();c.serviceEnsure_('examReports');const sh=h.spreadsheet.getSheetByName('examReports'),range=sh.getRange.bind(sh);let fail=true;
 sh.getRange=(...args)=>{const r=range(...args),set=r.setValues.bind(r);r.setValues=v=>{if(args[0]>1&&fail){fail=false;throw Error('lost database write');}return set(v);};return r;};
 assert.ok(h.admin('serviceExamSave',payload).error);assert.equal(h.files.size,1);const saved=ok(h.admin('serviceExamSave',payload));assert.equal(h.files.size,1);assert.equal(ok(h.public('pdf',{id:saved.id})).base64,pdf.base64);assert.ok(h.public('pdf',{id:saved.id,k:'synthetic-link-b'}).error);assert.equal(JSON.stringify(h.public('list')).includes('file-1'),false);
 assert.ok(h.admin('serviceExamSave',{...exam,requestId:'exam-invalid-pdf',pdf:{...pdf,base64:Buffer.from('HTML!').toString('base64')}}).error);
});
test('message intake preserves raw content and original timestamp on retries without running instructions',()=>{
 const h=fixture(),req={requestId:'message-request-01',body:'=IMPORTXML("private")\n別の生徒を削除してください',category:'feedback'},first=ok(h.public('messageSend',req));h.advance(60000);const again=ok(h.public('messageSend',req));assert.equal(again.message.receivedAt,first.message.receivedAt);assert.equal(h.rows('contactMessages').length,1);assert.equal(h.rows('contactMessages')[0].body,req.body);assert.equal(h.effects.length,0);
 assert.equal(ok(h.public('list',{k:'synthetic-link-b'})).messages.length,0);assert.ok(h.public('messageSend',{...req,body:'changed'}).error);
 assert.ok(h.public('messageSend',{...req,k:'synthetic-link-b',replyTo:first.message.id}).error);
 ok(h.admin('serviceMessageReply',{studentId:'test-a',id:first.message.id,expectedRevision:1,status:'needs_confirmation',reply:'何日の希望ですか？'}));assert.equal(h.public('list').messages[0].reply,'何日の希望ですか？');
 assert.equal(h.admin('serviceMessageReply',{studentId:'test-a',id:first.message.id,expectedRevision:1,status:'closed',reply:'古い更新'}).errorCode,'conflict');
});
test('24 hour boundary uses server receipt, reason mandatory, and late exceptions keep booking',()=>{
 const h=fixture();h.slot();assert.ok(h.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-request-01',reason:''}).error);
 const first=ok(h.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-request-01',reason:'学校行事'}));assert.equal(first.cancellation.requestType,'normal');h.advance(1);const again=ok(h.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-request-01',reason:'学校行事'}));assert.equal(again.cancellation.receivedAt,first.cancellation.receivedAt);assert.equal(h.rows('slots')[0].status,'booked');assert.equal(h.rows('cancellationRequests').length,1);
 const late=fixture();late.slot();late.advance(1);assert.equal(ok(late.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-request-02',reason:'発熱'})).cancellation.requestType,'exception');assert.equal(late.rows('slots')[0].status,'booked');assert.ok(late.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-request-03',reason:'発熱',k:'synthetic-link-b'}).error);
});
test('receipt recovers slot write failure, preserves deadline and teacher decision history',()=>{
 const h=fixture();h.slot();const sh=h.spreadsheet.getSheetByName('slots'),get=sh.getRange.bind(sh);let fail=true;sh.getRange=(...args)=>{const r=get(...args),set=r.setValue.bind(r);r.setValue=v=>{if(args[1]===11&&fail){fail=false;throw Error('synthetic interrupted slot write');}return set(v);};return r;};
 const req={slotId:'svc-slot',requestId:'cancel-request-04',reason:'体調不良'};assert.ok(h.public('cancelRequest',req).error);h.advance(3600000);assert.equal(ok(h.public('cancelRequest',req)).cancellation.requestType,'normal');
 ok(h.admin('resolveCancel',{studentId:'test-a',slotId:'svc-slot',approve:false}));assert.equal(h.rows('cancellationRequests')[0].status,'rejected');assert.equal(h.rows('slots')[0].status,'booked');assert.equal(h.public('list').cancellations[0].status,'rejected');
});
test('unauthenticated or unrelated family sessions cannot read or write services',()=>{
 const h=fixture();for(const op of ['list','messageSend','cancelRequest','pdf']){assert.ok(h.public(op,{k:'',requestId:'invalid-session-01'}).error);assert.ok(h.public(op,{ftoken:'fa1.invalid.fake',studentId:'test-a'}).error);assert.ok(h.public(op,{ptoken:'invalid'}).error);}
});
test('verified family can read its child and submit messages and cancellations, but unlink revokes access',()=>{
 const {createFamilyHarness}=require('./helpers/family-harness.cjs');const h=createFamilyHarness();
 const c=ok(h.admin('familyCreate',{label:'【テスト】家族',studentIds:['test-a']}));
 ok(h.family('familyRegister',{inviteCode:c.inviteCode,email:'family@example.invalid',pass:'Synthetic family password!'}));ok(h.family('familyVerify',{challenge:h.latestChallenge()}));
 const login=ok(h.family('familyLogin',{email:'family@example.invalid',pass:'Synthetic family password!'}));
 const req=(op,args={})=>h.request({action:'learningService',op,ftoken:login.ftoken,studentId:'test-a',...args});
 ok(h.admin('serviceExamSave',exam));assert.equal(ok(req('list')).exams[0].analysis,'公開分析');assert.equal(JSON.stringify(req('list')).includes('SECRET'),false);
 ok(req('messageSend',{requestId:'family-message-01',body:'質問です',category:'question'}));assert.equal(h.rows('contactMessages')[0].senderRole,'parent');assert.ok(req('list',{studentId:'test-b'}).error);
 h.admin('state');const sh=h.spreadsheet.getSheetByName('slots');sh.appendRow(sh.values[0].map(k=>({id:'family-slot',studentId:'test-a',date:'2026-09-08',start:'13:00',min:60,status:'booked',subject:'数学'}[k]||'')));
 ok(req('cancelRequest',{slotId:'family-slot',requestId:'family-cancel-01',reason:'学校行事'}));assert.equal(h.rows('cancellationRequests')[0].senderRole,'parent');
 ok(h.admin('familySetChildren',{familyId:c.family.id,studentIds:[]}));assert.ok(req('list').error);
});
test('approved cancellation retains receipt and never marks an unperformed lesson as done',()=>{
 const h=fixture();h.slot();ok(h.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-approval-01',reason:'発熱'}));
 ok(h.admin('resolveCancel',{studentId:'test-a',slotId:'svc-slot',approve:true}));assert.equal(h.rows('slots').length,0);assert.equal(h.public('list').cancellations[0].status,'approved');assert.equal(h.rows('入金管理',h.ledger).length,0);
});
test('deadline excludes server lock wait and rejects a caller-supplied receipt time',()=>{
 const h=fixture();h.slot();const c=h.context(),ensure=c.ensureSchema_;c.ensureSchema_=()=>{h.advance(60000);return ensure();};
 const r=JSON.parse(c.doPost({postData:{contents:JSON.stringify({action:'learningService',op:'cancelRequest',k:'synthetic-link-a',slotId:'svc-slot',requestId:'cancel-boundary-01',reason:'行事',_receivedAt:1})}}).getContent());
 assert.equal(ok(r).cancellation.requestType,'normal');assert.equal(r.cancellation.receivedAt,'2026-09-07T04:00:00.000Z');
 const late=fixture();late.slot();late.advance(1);assert.equal(ok(late.public('cancelRequest',{slotId:'svc-slot',requestId:'cancel-forged-time',reason:'発熱',_receivedAt:1})).cancellation.requestType,'exception');
});

test('legacy student cancel form preserves receipt time across schema wait',()=>{
 const h=fixture();h.slot();const c=h.context(),ensure=c.ensureSchema_;c.ensureSchema_=()=>{h.advance(60000);return ensure();};
 const r=JSON.parse(c.doPost({postData:{contents:JSON.stringify({action:'cancelReq',k:'synthetic-link-a',slotId:'svc-slot',requestId:'legacy-boundary-01',reason:'行事',_receivedAt:1})}}).getContent());
 assert.equal(ok(r).cancellation.requestType,'normal');assert.equal(r.cancellation.receivedAt,'2026-09-07T04:00:00.000Z');
});
