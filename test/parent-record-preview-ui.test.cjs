'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createUI,flush} = require('./helpers/operations-ui-harness.cjs');
const record = {recordId:'report-a',revision:1,date:'2026-09-07',start:'15:00',subject:'数学',content:'【テスト】報告',report:{actualUnit:'方程式',parentMessage:'保護者への連絡'},homework:[],outline:{title:'方程式',ordinal:1,plannedCount:2,total:10}};
async function ready(preview) {
  const mounts = [];
  const services = {clear(){},mount(){}};
  const reads = {clear(){},mount(host,call,scope){mounts.push({host,call,scope});}};
  const ui = createUI('student',{hash:'#family/records',search:preview?'?preview=parent:test-a':'',session:new Map([['sw_ft_v1','synthetic-family-session']]),window:{StepwiseServices:{...services,create:()=>services},StepwiseLessonRead:{...reads,create:()=>reads}}});
  let answered = 0;
  for (let round=0; round<10; round++) {
    const pending=ui.requests.slice(answered); if(!pending.length)break;
    answered=ui.requests.length;
    for (const req of pending) {
      const a=req.body.action, view=req.body.view;
      if(a==='familyHome'||view==='home')req.reply({ok:true,children:[{studentId:'test-a',name:'【テスト】生徒'}]});
      else if(a==='familyStudentState'||view==='student')req.reply({me:{name:'【テスト】生徒'},today:'2026-09-07',slots:[],history:[{id:'slot-a',date:record.date,start:record.start,min:60,subject:'数学',done:true}],lessonRecords:[record]});
      else if(a==='familyData'||view==='parent')req.reply({ok:true,data:{name:'【テスト】生徒',month:'2026-09',thisMonth:{},payments:[],upcoming:[],planLines:[]}});
      else if(a==='familyNotices')req.reply({ok:true,notices:[]});
      else assert.fail('Unexpected request '+JSON.stringify(req.body));
    }
    await flush();
  }
  ui.click('histopen',{'data-folder':'数学'});
  return {ui,mounts};
}
test('teacher parent preview shows the report but never mounts or claims family read receipts',async()=>{
  const {ui,mounts}=await ready(true);
  assert.match(ui.html(),/プレビューでは既読を付けません/);
  assert.match(ui.html(),/【テスト】報告/); assert.match(ui.html(),/保護者への連絡/); assert.match(ui.html(),/今回 1 \/ 2/);
  assert.doesNotMatch(ui.html(),/data-parent-record|data-read-label|開くと既読になります|状態を取得できませんでした/);
  assert.equal(mounts.length,0);
  assert.ok(ui.requests.every(r=>r.body.action==='preview'),'no family write/read request in teacher preview');
  assert.ok(ui.requests.every(r=>r.url==='https://stepwise-api.stepwise-edu.workers.dev'),'preview uses current API');
});
test('real family page retains read receipts with the matching child and family session',async()=>{
  const {ui,mounts}=await ready(false);
  assert.match(ui.html(),/開くと既読になります/);
  assert.match(ui.html(),/data-parent-record="report-a" data-record-revision="1"/);
  assert.ok(mounts.length>0);
  const request=mounts.at(-1).call('recordRead',{recordId:'report-a',revision:1});
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests.at(-1).body)),{recordId:'report-a',revision:1,ftoken:'synthetic-family-session',studentId:'test-a',action:'learningService',op:'recordRead'});
  ui.requests.at(-1).reply({ok:true});await request;
});

test('parent preview displays API errors and permits retry without a family login',async()=>{
 const ui=createUI('student',{hash:'#family/home',search:'?preview=parent:test-a'});
 assert.match(ui.html(),/保護者ページを読み込んでいます/);
 ui.requests[0].reply({error:'先生アカウントでログインし直してください',badAuth:true});await flush();
 assert.match(ui.html(),/先生アカウントでログインし直してください/);assert.doesNotMatch(ui.html(),/家族ページを開く/);
 ui.click('fa-home');assert.equal(ui.requests.length,2);assert.equal(ui.requests[1].body.action,'preview');
});

test('parent preview reads each sibling with its own ID and the original family anchor',async()=>{
 const ui=createUI('student',{hash:'#family/home',search:'?preview=parent:test-a',local:new Map([['sw_admt','synthetic-teacher']])});
 let answered=0;
 for(let round=0;round<10;round++){
  const pending=ui.requests.slice(answered);if(!pending.length)break;answered=ui.requests.length;
  for(const req of pending){
   assert.equal(req.body.action,'preview');assert.equal(req.body.familyStudentId,'test-a');
   if(req.body.view==='home')req.reply({ok:true,family:{id:'family-test',label:'【テスト】保護者'},children:[{studentId:'test-a',name:'【テスト】兄'},{studentId:'test-b',name:'【テスト】弟'}]});
   else if(req.body.view==='student')req.reply({me:{name:req.body.studentId},today:'2026-09-24',slots:[],history:[],planLines:[]});
   else req.reply({ok:true,data:{month:'2026-09',thisMonth:{},planLines:[],payments:[]}});
  }await flush();
 }
 for(const view of ['student','parent'])assert.deepEqual([...new Set(ui.requests.filter(r=>r.body.view===view).map(r=>r.body.studentId))].sort(),['test-a','test-b']);
 assert.match(ui.html(),/【テスト】兄さん/);assert.match(ui.html(),/【テスト】弟さん/);
 assert.equal(ui.session.has('sw_ft_v1'),false);
});
