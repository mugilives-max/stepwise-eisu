const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../assets/portal.js'),'utf8');
const code=source.slice(source.indexOf('function renderFamilyTuition()'),source.indexOf('function renderFamilyPlans()'));
test('family tuition sums current cancellation amounts for the displayed month including pending relief',()=>{
 const ctx={F:{home:{children:[{studentId:'a'},{studentId:'b'}]},childrenData:{a:{month:'2026-09'},b:{month:'2026-09'}},childState:{a:{cancellations:[{date:'2026-09-01',amount:1000},{date:'2026-09-02',amount:0},{date:'2026-08-31',amount:9000}]},b:{cancellations:[{date:'2026-09-03',amount:4500,relief:{status:'pending'}}]}}},esc:String,familyChildName:c=>c.studentId,yen:n=>n+'円'};
 ctx.F.childrenData.a.planLines=[{status:'approved',startDate:'2026-09-01',endDate:'2026-09-30',rate30:1000,lessonMin:90}];
 ctx.F.childState.a.history=[{id:'lesson-a',done:true,date:'2026-09-01',min:90}];
 ctx.lessonLabel=()=>'';ctx.planCovers=()=>true;ctx.planLimit=()=>2;
 vm.createContext(ctx);vm.runInContext(code,ctx);const html=ctx.renderFamilyTuition();
 assert.match(html,new RegExp('<th scope="row">キャンセル料</th>'));assert.ok(html.includes('<td>1000円</td>'));assert.ok(html.includes('<td>4500円</td>'));assert.ok(!html.includes('小計'));assert.ok(!html.includes('<th>月</th>'));assert.ok(html.includes('2026年9月'));assert.ok(html.includes('rowspan="2"'));assert.ok(html.includes('<td>8500円</td>'));assert.ok(html.includes('<td>11500円</td>'));assert.ok(!html.includes('9000円'));assert.ok(html.includes('審査前の金額'));
});
