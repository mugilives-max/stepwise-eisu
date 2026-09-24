'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const json = v => JSON.parse(JSON.stringify(v));
const save = (h, args) => h.admin('planLineSave', { studentId: 'test-a', subject: '英語', kind: '通常', count: 4, startDate: '2026-09-01', endDate: '2026-09-30', lessonMin: 90, lessonFee: 4500, comment: '', ...args });

test('student state lists proposed and approved lines whose period reaches this month, newest first, with comments', () => {
  const h = createSchedulingHarness();
  assert.deepEqual(json(h.context().studentState_('synthetic-link-a').planLines), []);
  h.approve({ ym: '2026-09', count: 4, subject: '英語', comment: '定期テスト対策で\r\n文法を固めます' });
  const r = save(h, { subject: '数学', startDate: '2026-09-22', endDate: '2026-10-05', count: 3, propose: true, comment: '入試の過去問' }); assert.equal(r.ok, true, JSON.stringify(r));
  const d = save(h, { subject: '国語', startDate: '2026-10-01', endDate: '2026-10-31', count: 2 }); assert.equal(d.ok, true, JSON.stringify(d));
  const old = save(h, { subject: '英語', startDate: '2026-08-01', endDate: '2026-08-31', count: 2, propose: true }); assert.equal(old.ok, true, JSON.stringify(old));
  const state = json(h.context().studentState_('synthetic-link-a'));
  assert.deepEqual(state.planLines.map(l => [l.subject, l.kind, l.count, l.period, l.status, l.lessonMin, l.lessonFee, l.comment]), [
    ['数学', '', 3, '2026/9/22〜10/5', 'proposed', 90, undefined, '入試の過去問'],
    ['英語', '', 4, '2026年9月', 'approved', 90, undefined, '定期テスト対策で\n文法を固めます']
  ]);
  assert.equal(state.planLines[1].approvedCount, 4);
  assert.deepEqual(state.plan, { '英語': 4, '数学': 3 }); assert.equal(state.planStatus, 'proposed');
  assert.deepEqual(json(h.context().studentState_('synthetic-link-b').planLines), []);
  const c = h.context(); const parent = json(c.parentDataForStudent_(c.findStudent_('test-a')));
  assert.deepEqual(parent.data.planLines.map(l => l.subject), ['数学', '英語']);
});

const {studentReady,state,line}=require('./helpers/operations-ui-harness.cjs');
test('student UI never renders plan prices even from an old response',async()=>{
 const ui=await studentReady({...state([]),planLines:[line({lessonFee:987654,rate30:329218,comment:'学習内容'})]});
 assert.ok(ui.html().includes('学習内容'));
 assert.ok(ui.html().includes('90分'));
 assert.match(ui.html(),/portal-plan-table/);
 assert.ok(ui.html().includes('<th>種類</th><th>回数</th><th>時間</th>'));
 assert.ok(ui.html().includes('9/1〜9/30'));
 assert.match(ui.html(),/colspan="6"/);
 assert.match(ui.html(),/portal-plan-comment/);
 assert.doesNotMatch(ui.html(),/987,?654|329,?218|1回 |料金|授業料/);
});
test('student API exposes learning fields only including the teacher student preview',()=>{
 const h=createSchedulingHarness();save(h,{propose:true});const c=h.context();
 const st=json(c.studentState_('synthetic-link-a'));
 assert.doesNotMatch(JSON.stringify(st),/"(?:lessonFee|rate30|monthly|amount|billing|memo|parentAckMemo)"/);
 assert.equal(c.parentDataForStudent_(c.findStudent_('test-a')).data.planLines[0].lessonFee,4500);
});

test('approved plan progress is a sibling section showing completed versus planned lessons',async()=>{
 const ui=await studentReady({...state([]),history:[{date:'2026-09-01',subject:'英語',kind:'',done:true},{date:'2026-09-02',subject:'英語',kind:'',done:true}],planLines:[line({status:'approved',approvedCount:4})]});
 const html=ui.html(),boundary=html.indexOf('data-fold="progress"');
 assert.ok(boundary>0);
 assert.ok(html.slice(0,boundary).includes('</details>'));
 assert.ok(html.slice(boundary).includes('実施状況'));
 assert.ok(html.slice(boundary).includes('<th>計画回数</th><th>予定回数</th><th>実施回数</th>'));
 assert.ok(html.slice(boundary).includes('<td>4回</td><td>0回</td><td>2回</td>'));
 assert.ok(!html.slice(boundary).includes('<th>時間</th>'));
 assert.ok(!html.includes('実施計画'));
});

test('progress separates lessons covered by a proposed plan from genuinely outside lessons',async()=>{
 const ui=await studentReady({...state([]),history:[{date:'2026-09-02',subject:'英語',kind:'',done:true},{date:'2026-09-20',subject:'英語',kind:'',done:true},{date:'2026-09-02',subject:'英語',kind:'演習',done:true}],planLines:[line({endDate:'2026-09-10'})]});
 const progress=ui.html().split('data-fold="progress"')[1];
 assert.ok(progress.includes('<td>未承認</td>'));
 assert.equal((progress.match(/<td>計画外<\/td>/g)||[]).length,2);
 assert.ok(progress.includes('<td>通常</td><td>4回<button'));
 assert.ok(progress.includes('<td>0回</td><td>1回</td><td>未承認</td>'));
 assert.equal((progress.match(/class="plan-count-warning"/g)||[]).length,1);
 assert.ok(progress.includes('この授業計画は未承認です。保護者の方に確認し、承認していただくようにお願いします。'));
 const id=/aria-controls="(progress-approval-[^"]+)"/.exec(progress)[1];
 assert.ok(progress.includes('id="'+id+'" hidden'));
});
