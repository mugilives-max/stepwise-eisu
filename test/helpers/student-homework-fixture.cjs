'use strict';
// Production portal and real GAS handlers, synthetic in-memory data only.
// Every external service is disabled or replaced by the existing test harness.
const {createLessonOutlineFixture}=require('./lesson-outline-fixture.cjs');
const ok=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};

function createStudentHomeworkFixture(){
  const fixture=createLessonOutlineFixture(),h=fixture.h,taskIds={};
  h.advance(Date.parse('2026-09-23T04:00:00Z')-h.now());
  h.setRow('students','id','test-a',{name:'【テスト】宿題確認A'});
  h.setRow('students','id','test-b',{name:'【テスト】宿題確認B'});

  const stableTask=(key,row)=>{
    if(!row)throw Error('Missing synthetic task '+key);
    const id='homework-ui-'+key;
    h.setRow('tasks','id',row.id,{id});taskIds[key]=id;return id;
  };
  const addTask=(key,studentId,fields,self=false)=>{
    const before=new Set(h.rows('tasks').map(t=>String(t.id)));
    const request={type:'宿題',title:'【テスト】宿題',dueMode:'none',due:'',...fields};
    if(self)ok(h.request({action:'taskAdd',k:studentId==='test-b'?'synthetic-link-b':'synthetic-link-a',...request}));
    else ok(h.admin('taskAdd',{studentId,...request}));
    return stableTask(key,h.rows('tasks').find(t=>!before.has(String(t.id))));
  };
  const slot=(id,studentId,date,subject,patch={})=>{
    const sheet=h.spreadsheet.getSheetByName('slots');
    const row={id,studentId,date,subject,start:'17:00',min:60,status:'booked',done:false,kind:'通常',deliveryMode:'in_person',...patch};
    sheet.appendRow(sheet.values[0].map(name=>row[name]??''));
  };

  // Freeze the original next-math deadline, then move that lesson. The completed
  // task must keep 9/14 while the remaining nextLesson task resolves to 9/24.
  const mathTasks=h.rows('tasks').filter(t=>String(t.sourceRecordId)===fixture.record.recordId);
  const frozen=stableTask('frozen',mathTasks.find(t=>t.sourceItemId==='preview-hw-0'));
  ok(h.request({action:'taskDone',k:'synthetic-link-a',taskId:frozen,done:true}));
  const withdrawn=stableTask('withdrawn',mathTasks.find(t=>t.sourceItemId==='preview-hw-1'));
  ok(h.admin('taskDel',{studentId:'test-a',taskId:withdrawn}));
  stableTask('next-math',mathTasks.find(t=>t.sourceItemId==='preview-hw-2'));
  h.setRow('slots','id','preview-next',{date:'2026-09-24',start:'16:00'});

  slot('homework-english-source','test-a','2026-09-22','英語',{done:true});
  slot('homework-english-today','test-a','2026-09-23','英語');
  slot('homework-english-later','test-a','2026-09-29','英語');
  slot('homework-b-next','test-b','2026-09-25','英語',{start:'18:00'});
  const english=ok(h.admin('lessonRecordSave',{studentId:'test-a',slotId:'homework-english-source',expectedRevision:0,requestId:'homework-ui-english-report',record:{
    content:'【テスト】疑問文と単語の確認を行いました。先生用メモは公開しません。',
    report:{actualUnit:'疑問文・単語の復習'},teacherNote:'PRIVATE_HOMEWORK_FIXTURE_NOTE',
    homework:[
      {itemId:'english-today',title:'英単語 Lesson 3 を5語ずつ確認する',type:'宿題',dueMode:'date',due:'2026-09-23'},
      {itemId:'english-next',title:'疑問文を声に出して3回読む',type:'宿題',dueMode:'nextLesson',due:''},
      {itemId:'english-future',title:'英語ワーク p30〜32',type:'宿題',dueMode:'date',due:'2026-09-27'},
      {itemId:'english-none',title:'覚えにくかった単語を質問できるようにする',type:'宿題',dueMode:'none',due:''}
    ]
  }}));
  ok(h.admin('lessonHomeworkApply',{studentId:'test-a',recordId:english.recordId,expectedRevision:english.revision,requestId:'homework-ui-english-apply'}));
  for(const item of ['english-today','english-next','english-future','english-none']){
    stableTask(item,h.rows('tasks').find(t=>String(t.sourceRecordId)===english.recordId&&t.sourceItemId===item));
  }

  addTask('overdue','test-a',{title:'計算プリントの解きなおし（期限を過ぎた課題）',dueMode:'date',due:'2026-09-20'});
  addTask('next-pending','test-a',{title:'理科の用語を確認する（次の授業はまだ未定）',dueMode:'nextLesson',dueSubject:'理科'});
  addTask('long','test-a',{title:'問題文を読み、条件に線を引いてから途中式と答えを書き、解きなおしまで取り組む長い宿題の内容をスマートフォンでも省略せずに確認する〈教材・範囲の確認〉',dueMode:'date',due:'2026-09-26'});
  addTask('self-memo','test-a',{type:'メモ',title:'次回、分数の計算で迷った問題を質問する',dueMode:'none'},true);
  addTask('self-bring','test-a',{type:'持ち物',title:'定規・コンパス・数学のノートを持っていく',dueMode:'date',due:'2026-09-23'},true);
  addTask('b-today','test-b',{title:'【テスト】B専用・英単語を10語覚える',dueMode:'date',due:'2026-09-23'});
  addTask('b-next','test-b',{title:'【テスト】B専用・音読を3回する',dueMode:'nextLesson',dueSubject:'英語'});
  addTask('b-self','test-b',{type:'メモ',title:'【テスト】B専用・学校のプリントを持参',dueMode:'none'},true);

  // Add B to the already-created synthetic family and renew the genuine test
  // session after membership invalidation. No real email or account is used.
  const family=h.rows('familyLinks').find(l=>l.studentId==='test-a');
  ok(h.admin('familySetChildren',{familyId:family.familyId,studentIds:['test-a','test-b']}));
  const session=ok(h.family('familyLogin',{email:'lesson-preview@example.invalid',pass:'Synthetic preview password!'}));
  h.enableTestGuard();
  return {...fixture,ftoken:session.ftoken,taskIds,englishRecordId:english.recordId,today:'2026-09-23',
    studentKeys:{a:'synthetic-link-a',b:'synthetic-link-b'}};
}

module.exports={createStudentHomeworkFixture};
