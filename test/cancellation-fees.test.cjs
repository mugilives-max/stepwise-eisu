const test=require('node:test'),assert=require('node:assert/strict');
const {createBillingHarness}=require('./helpers/billing-harness.cjs');
const ok=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
function fixture(){const h=createBillingHarness();h.seedSlot({id:'fee-slot',date:'2026-09-08',start:'13:00',status:'booked'});return h;}
function request(h){return ok(h.request({action:'cancelReq',k:'synthetic-link-a',slotId:'fee-slot',requestId:'cancel-fee-request',reason:'都合が悪いため'}));}
function quote(h,extra={}){return ok(h.admin('serviceCancelQuote',{studentId:'test-a',slotId:'fee-slot',...extra}));}
function decide(h,q,extra={}){return h.admin('resolveCancel',{studentId:'test-a',slotId:'fee-slot',approve:true,source:q.quote.source,receivedAt:q.quote.receivedAt,cancelSignature:q.signature,feeChoice:'charge',...extra});}
function bill(h,ym='2026-09'){return ok(h.admin('billingPreview',{studentId:'test-a',ym})).billing;}
test('23:00 JST inclusive is free, one millisecond later costs 1000; receipt wins over decision time',()=>{
 for(const [delta,amount] of [[10*3600000,0],[10*3600000+1,1000]]){const h=fixture();h.advance(delta);request(h);h.advance(3600000);const q=quote(h);assert.equal(q.quote.amount,amount);ok(decide(h,q));assert.equal(h.rows('slots').length,0);assert.equal(bill(h).amount,amount);assert.equal(bill(h).count,0);assert.equal(bill(h).minutes,0);}
});
test('fee-only invoice, retry, void and next-month billing never duplicate charges',()=>{
 const h=fixture();h.advance(10*3600000+1);request(h);const q=quote(h);ok(decide(h,q));ok(decide(h,q));assert.equal(h.rows('cancellationFees').length,1);
 const inv=ok(h.admin('kanriAddPayment',{studentId:'test-a',ym:'2026-09',requestId:'fee-invoice-0001',amount:1000,silent:true})).invoice;
 assert.equal(inv.lessons.length,0);assert.equal(inv.fees.length,1);assert.equal(bill(h,'2026-10').amount,0);
 assert.equal(h.rows('入金管理',h.ledger)[0]['実施回数'],0);
 ok(h.admin('kanriVoidInvoice',{studentId:'test-a',invoiceId:inv.id,reason:'テスト訂正'}));assert.equal(bill(h).amount,1000);
});
test('waiver requires reason; altered and unauthenticated decisions do not cancel',()=>{
 const h=fixture();h.advance(10*3600000+1);request(h);const q=quote(h);
 assert.ok(decide(h,q,{feeChoice:'waive'}).error);assert.equal(h.rows('slots').length,1);
 assert.ok(decide(h,q,{cancelSignature:'stale'}).error);
 assert.ok(h.request({action:'admin',op:'resolveCancel',studentId:'test-a',slotId:'fee-slot',approve:true}).error);
 assert.ok(h.admin('serviceCancelQuote',{studentId:'test-b',slotId:'fee-slot'}).error);
 ok(decide(h,q,{feeChoice:'waive',note:'急病のため免除'}));assert.equal(bill(h).amount,0);assert.equal(h.rows('cancellationFees')[0].status,'confirmed');
 assert.ok(decide(h,q).error);
});
test('external receipt changes classification only with recorded evidence; future timestamps refused',()=>{
 const h=fixture();h.advance(11*3600000);request(h);
 const q=quote(h,{source:'external',receivedAt:'2026-09-07T22:00:00+09:00'});assert.equal(q.quote.amount,0);
 assert.ok(decide(h,q).error);ok(decide(h,q,{note:'LINEで22時に連絡済み'}));
 const k=fixture();assert.ok(k.admin('serviceCancelQuote',{studentId:'test-a',slotId:'fee-slot',source:'external',receivedAt:'2030-01-01T00:00:00+09:00'}).error);
});
test('no-show uses approved lesson price, teacher cancellation is zero',()=>{
 const h=fixture();const l=ok(h.admin('planLineSave',{studentId:'test-a',subject:'数学',kind:'通常',count:2,startDate:'2026-09-01',endDate:'2026-09-30',lessonMin:60,lessonFee:3000,propose:true})).line;
 ok(h.admin('planLineApproveTeacher',{studentId:'test-a',lineId:l.id,expectedRevision:l.revision,via:'電話',consentDate:'2026-09-06',memo:'テスト合意'}));
 assert.ok(h.admin('serviceCancelQuote',{studentId:'test-a',slotId:'fee-slot',source:'noshow'}).error);
 h.advance(24*3600000);const q=quote(h,{source:'noshow'});assert.equal(q.quote.amount,3000);ok(decide(h,q,{note:'連絡なし'}));assert.equal(bill(h).amount,3000);assert.equal(bill(h).count,0);
 const k=fixture(),free=quote(k,{source:'teacher'});assert.equal(free.quote.amount,0);ok(decide(k,free,{note:'先生の都合'}));assert.equal(bill(k).amount,0);
});
test('failure after slot removal resumes the frozen fee once, and changed evidence is rejected',()=>{
 const h=fixture();h.advance(10*3600000+1);request(h);const q=quote(h),base=h.context;
 let fail=true;h.context=()=>{const c=base();const f=c.cancelFeeConfirm_;c.cancelFeeConfirm_=w=>{if(fail){fail=false;throw Error('synthetic failure');}return f(w);};return c;};
 // Harness request uses its original context closure; call the instrumented dispatch explicitly.
 const body={action:'admin',token:require('./gas-harness.cjs').TEACHER_TOKEN,op:'resolveCancel',studentId:'test-a',slotId:'fee-slot',approve:true,source:'request',cancelSignature:q.signature,feeChoice:'charge'};
 const r=JSON.parse(h.context().doPost({postData:{contents:JSON.stringify(body)}}).getContent());assert.equal(r.errorCode,'pending');
 assert.equal(h.rows('slots').length,0);assert.equal(h.rows('cancellationFees')[0].status,'pending');
 ok(decide(h,q));assert.equal(h.rows('cancellationFees')[0].status,'confirmed');assert.equal(bill(h).amount,1000);
});
test('Worker D1 persists the same cancellation charge and invoice snapshot',async()=>{
 await (await import('../scripts/build-gas-bundle.mjs')).generate();const h=fixture();h.advance(10*3600000+1);request(h);
 const {createParity}=require('./helpers/parity-harness.cjs'),p=await createParity(h),{runWrite}=await import('../cf/worker/write.mjs');
 try{const opts={now:h.now()},auth={action:'admin',token:require('./gas-harness.cjs').TEACHER_TOKEN,studentId:'test-a',slotId:'fee-slot'};
 const q=await runWrite({...auth,op:'serviceCancelQuote'},p.env,opts);const result=q.result||q;ok(result);
 const res=await runWrite({...auth,op:'resolveCancel',approve:true,source:'request',cancelSignature:result.signature,feeChoice:'charge'},p.env,opts);ok(res.result||res);
 const inv=await runWrite({...auth,op:'kanriAddPayment',ym:'2026-09',requestId:'worker-fee-bill-01',amount:1000,silent:true},p.env,opts);assert.equal(ok(inv.result).invoice.fees[0].amount,1000);assert.equal(inv.result.invoice.lessons.length,0);
 }finally{p.d1._sqlite.close();}
});

test('family monthly close issues a fee-only statement once and shows a separate fee',()=>{
 const h=fixture();h.advance(10*3600000+1);request(h);ok(decide(h,quote(h)));
 const c=h.context();c.ensureFamilySchema_();const a={id:'fee-family',email:'fee@example.invalid',label:'【テスト】家族',status:'active',revision:1,createdAt:'2026-09-01',passHash:'fixture'};c.familySave_(a);c.familySetChildren_(a,['test-a']);
 h.advance(Date.parse('2026-10-01T00:10:00+09:00')-h.now());assert.equal(h.context().familyCloseMonths_().issued,1);assert.equal(h.context().familyCloseMonths_().issued,0);
 const m=h.context().familyBilling_(a,false)[0];assert.equal(m.amount,1000);assert.equal(m.children[0].invoice.fees[0].amount,1000);assert.equal(m.children[0].invoice.lessons.length,0);
});

test('adjusted fees validate bounds, keep exact retry, bill actual amount and expose only student history',()=>{
 const h=fixture();h.advance(10*3600000+1);request(h);const q=quote(h);
 for(const amount of [-1,1001,0.5,'',null,'bad'])assert.ok(decide(h,q,{feeChoice:'adjust',feeAmount:amount,note:'減額'}).error);
 assert.ok(decide(h,q,{feeChoice:'adjust',feeAmount:500}).error);
 ok(decide(h,q,{feeChoice:'adjust',feeAmount:500,note:'初回のため減額'}));
 ok(decide(h,q,{feeChoice:'adjust',feeAmount:500,note:'初回のため減額'}));
 assert.ok(decide(h,q,{feeChoice:'adjust',feeAmount:400,note:'初回のため減額'}).error);
 assert.equal(bill(h).amount,500);
 h.seedSlot({id:'next-slot',date:'2026-09-09',start:'13:00',status:'booked'});
 const next=quote(h,{slotId:'next-slot'});assert.equal(next.history.count,1);assert.equal(next.history.items[0].amount,500);assert.equal(next.history.items[0].requestReason,'都合が悪いため');
 h.seedSlot({id:'other-slot',studentId:'test-b',date:'2026-09-09',start:'15:00',status:'booked'});const other=ok(h.admin('serviceCancelQuote',{studentId:'test-b',slotId:'other-slot'}));assert.equal(other.history.items.length,0);
});
test('zero adjustment is waiver and creates no invoice charge',()=>{const h=fixture();h.advance(10*3600000+1);request(h);const q=quote(h);ok(decide(h,q,{feeChoice:'adjust',feeAmount:0,note:'急病のため'}));assert.equal(bill(h).amount,0);});
