const {test}=require('node:test'),assert=require('node:assert/strict');
const {createHarness,TEACHER_TOKEN}=require('./gas-harness.cjs');
const {createBillingHarness}=require('./helpers/billing-harness.cjs');
const render=require('../assets/lesson-report.js');
function fixture(){const h=createHarness({iterations:10});h.context().ensureLessonSchema_();
 const add=(id,date,subject='英語',studentId='test-a',status='booked')=>{const s=h.spreadsheet.getSheetByName('slots'),o={id,date,start:'10:00',min:60,status,studentId,subject};s.appendRow(s.values[0].map(k=>o[k]??''));};
 add('source','2026-09-06');add('other-subject','2026-09-07','数学');add('other-student','2026-09-07','英語','test-b');add('offer','2026-09-07','英語','test-a','offered');add('next','2026-09-09');
 h.save=(report,revision=0,requestId='workspace-save')=>h.context().lessonAdmin_({action:'admin',op:'lessonRecordSave',token:TEACHER_TOKEN,studentId:'test-a',slotId:'source',expectedRevision:revision,requestId,record:{content:'短い報告本文',teacherNote:'PRIVATE_NOTE',...(report===undefined?{}:{report})}});return h;}
test('report details use committed public revision and omitted legacy input preserves them',()=>{
 const h=fixture(),r=h.save({teacher:'先生',actualUnit:'消化',homeworkAccuracy:'0',parentMessage:'復習をお願いします',testDate:'2026-09-10'});assert.equal(r.ok,true,JSON.stringify(r));
 const pub=h.context().lessonPublishedForStudent_('test-a')[0];assert.equal(pub.report.actualUnit,'消化');assert.equal(pub.report.homeworkAccuracy,'0');assert.equal(pub.workspace.next.date,'2026-09-09');assert.equal(pub.workspace.scheduledCount,2);assert.equal(pub.workspace.ordinal,1);assert.equal(pub.workspace.beforeTest,1);assert.equal(JSON.stringify(pub).includes('PRIVATE'),false);
 assert.equal(h.save(undefined,1,'legacy-edit').ok,true);assert.equal(h.context().lessonPublishedForStudent_('test-a')[0].report.actualUnit,'消化');
 assert.equal(h.context().lessonPublishedForStudent_('test-b').length,0);
});
test('invalid rates, dates and private/unknown report fields cannot be saved or published',()=>{
 for(const report of [{homeworkAccuracy:'101'},{homeworkAccuracy:'-1'},{testDate:'2026-02-30'},{teacherNote:'secret'},{actualUnit:'x'.repeat(201)}]){const h=fixture();assert.equal(h.save(report).errorCode,'validation');assert.equal(h.rows('lessonRecords').length,0);}
});
test('shared report renderer escapes content and never truncates body fields',()=>{
 assert.ok(render.view({actualUnit:'<script>x</script>',parentMessage:'a\nb\nc\nd'}).includes('&lt;script&gt;'));assert.ok(render.view({parentMessage:'a\nb\nc\nd'}).includes('a\nb\nc\nd'));
 assert.ok(render.fields({teacher:'" onfocus="bad'},false).includes('&quot;'));assert.ok(render.context({ordinal:null,scheduledCount:0,next:null,beforeTest:null}).includes('予定未定'));
});
test('a recorded invoice keeps its exact amount even when the current lines would price the month differently',()=>{
 const h=createBillingHarness();
 h.seedPayment({'請求額':12000,'料金方式':'monthly','確定月謝':12000});
 const preview=h.context().billingPreview_('test-a','2026-09');assert.equal(preview.canBill,false);assert.equal(preview.invoice.amount,12000);assert.equal(preview.amount,12000);
});
test('family statement sums only linked child invoices and detects duplicate child-months',()=>{
 const h=createBillingHarness(),c=h.context();c.familyChildren_=()=>[{studentId:'test-a',name:'A'},{studentId:'test-b',name:'B'}];
 h.seedPayment({'請求額':3000});h.seedPayment({'生徒ID':'test-b','請求額':4500,'入金日':'2026-09-08'});h.seedPayment({'生徒ID':'unlinked','請求額':99999});
 const before=JSON.stringify(h.payments());let v=c.familyBilling_({},false);assert.equal(v[0].amount,7500);assert.equal(v[0].unpaid,3000);assert.equal(v[0].children.length,2);assert.equal(JSON.stringify(h.payments()),before);
 h.seedPayment({'請求額':2000});c.memoClear_();v=c.familyBilling_({},false);assert.equal(v[0].conflict,true);assert.equal(v[0].amount,null);
});
