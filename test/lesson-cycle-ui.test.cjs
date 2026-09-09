'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const clone=value=>JSON.parse(JSON.stringify(value));
const href=(student='test-a',slot='slot-a')=>'#lesson?student='+student+'&slot='+slot;
const privateSentinel='PRIVATE_UI_SENTINEL';
function lessonContext(student='test-a',slot='slot-a',record=null,extra={}) {
  return {student:{id:student,name:'【テスト】'+student,active:true},slot:{id:slot,date:'2026-09-08',start:'13:00',min:60,subject:'英語',status:'booked',done:false},record,previous:null,otherPrevious:[],openTasks:[],homeworkState:[],draft:null,pending:null,slotChanged:false,lessonChoices:[{id:slot,date:'2026-09-08',start:'13:00',min:60,subject:'英語',status:'booked',recordStatus:record?'active':'none'}],...extra};
}
function savedRecord(input={},revision=1,student='test-a',slot='slot-a') {
  return {id:'record-'+student,studentId:student,slotId:slot,revision,status:'active',content:'保存された本文',progress:'',nextFocus:'',teacherNote:privateSentinel,homework:[],updatedAt:'2026-09-08T04:00:00Z',...input};
}
function createUI(hash=href()) {
  const elements=new Map(),events=new Map(),requests=[],local=new Map([['sw_admt','test-teacher-token']]),session=new Map(),storageWrites=[];
  const decode=s=>String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  function on(key,handler) { if (!events.has(key)) events.set(key,[]); events.get(key).push(handler); }
  function emit(key,event={}) { for (const fn of events.get(key)||[]) fn(event); }
  function element(id,attrs={}) {
    let html=''; const childIds=new Set();
    const e={id,value:'',textContent:'',disabled:Object.hasOwn(attrs,'disabled'),attrs,
      getAttribute:k=>Object.hasOwn(attrs,k)?attrs[k]:null,hasAttribute:k=>Object.hasOwn(attrs,k),focus(){},scrollIntoView(){},classList:{add(){},remove(){}},
      addEventListener:(name,fn)=>on(id+':'+name,fn),
      clear(){for (const child of childIds) {elements.get(child)?.clear();elements.delete(child);}childIds.clear();}};
    Object.defineProperty(e,'innerHTML',{get:()=>html,set(value){
      e.clear();html=String(value);
      for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const properties={}; for (const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) properties[a[1]]=decode(a[2]||'');
        const child=element(match[3],properties); child.value=properties.value||'';
        if(match[1]==='textarea') {const start=match.index+match[0].length,end=html.indexOf('</textarea>',start);child.value=decode(html.slice(start,end));}
        elements.set(child.id,child);childIds.add(child.id);
      }
    }}); return e;
  }
  for (const id of ['app','nav','toast']) elements.set(id,element(id));
  const storage=map=>({getItem:key=>map.get(key)??null,setItem(key,value){storageWrites.push([key,String(value)]);map.set(key,String(value));},removeItem:key=>map.delete(key)});
  let nextId=0;
  const context={document:{getElementById:id=>elements.get(id)||null,addEventListener:(name,fn)=>on('document:'+name,fn),querySelectorAll:()=>[]},window:{scrollTo(){},addEventListener:(name,fn)=>on('window:'+name,fn),crypto:{randomUUID:()=> 'test-ui-request-'+(++nextId)}},location:{hash,search:'',href:'https://example.invalid/kanri/',pathname:'/kanri/'},history:{replaceState(){}},URL,URLSearchParams,navigator:{},localStorage:storage(local),sessionStorage:storage(session),console:{log(){}},confirm:()=>true,setTimeout:()=>0,clearTimeout(){},fetch(url,options){
    const body=options?JSON.parse(options.body):Object.fromEntries(new URL(url).searchParams);
    return new Promise((resolve,reject)=>requests.push({body,reply:value=>resolve({json:()=>Promise.resolve(value)}),fail:()=>reject(new Error('network failed'))}));
  }};
  const source=fs.readFileSync(path.resolve(__dirname,'../kanri/index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  context.window.StepwiseBoard=require('../assets/schedule-board.js');
  context.window.StepwiseReport=require('../assets/lesson-report.js');
  vm.runInNewContext(source,context,{filename:'kanri/index.html'});
  const ui={requests,local,session,storageWrites,el:id=>elements.get(id),html:()=>elements.get('app').innerHTML,
    async ready(c=lessonContext()){assert.equal(requests[0].body.op,'lessonContext');requests[0].reply({ok:true,context:c});await flush();return ui;},
    input(id,value){const el=elements.get(id);assert.ok(el,'input visible: '+id);el.value=value;emit('document:input',{target:el});},
    click(action,attrs={}){const combined=ui.html()+elements.get('nav').innerHTML;const match=[...combined.matchAll(/<[^>]+\bdata-action="([^"]+)"[^>]*>/g)].find(x=>x[1]===action);assert.ok(match,'action visible: '+action);const btn={disabled:/\sdisabled(?:\s|>)/.test(match[0]),getAttribute:key=>key==='data-action'?action:attrs[key]??null};emit('document:click',{target:{closest:()=>btn},preventDefault(){}});},
    navigate(nextHash){context.location.hash=nextHash;emit('window:hashchange');},
    beforeUnload(){let prevented=false;const event={preventDefault(){prevented=true;}};emit('window:beforeunload',event);return prevented;},
    noPrivateStorage(){assert.equal(JSON.stringify(storageWrites).includes(privateSentinel),false);assert.equal(JSON.stringify([...local,...session]).includes(privateSentinel),false);}
  };return ui;
}

test('public report fields retain typed values in the record save and retry',async()=>{
  const ui=await createUI().ready();ui.input('lc-content','短い報告');ui.input('lc-report-actualUnit','消化');ui.input('lc-report-homeworkAccuracy','0');ui.input('lc-report-parentMessage','次回も復習します');
  ui.click('lc-save');const first=ui.requests.at(-1),body=clone(first.body);assert.equal(body.record.report.actualUnit,'消化');assert.equal(body.record.report.homeworkAccuracy,'0');
  first.fail();await flush();assert.equal(ui.el('lc-report-parentMessage').value,'次回も復習します');ui.click('lc-retry');assert.deepEqual(clone(ui.requests.at(-1).body),body);
});

test('lesson save keeps input after network failure and retries the identical mutation once',async()=>{
  const ui=await createUI().ready(); ui.input('lc-content','手元の授業内容'); ui.input('lc-teacherNote',privateSentinel);
  assert.equal(ui.beforeUnload(),true); ui.click('lc-save'); const first=ui.requests.at(-1), body=clone(first.body);
  ui.click('lc-save');assert.equal(ui.requests.length,2,'busy blocks a second save');first.fail();await flush();
  assert.equal(ui.el('lc-content').value,'手元の授業内容');assert.equal(ui.el('lc-teacherNote').value,privateSentinel);assert.match(ui.html(),/同じ処理を再試行/);
  ui.click('lc-retry');assert.deepEqual(ui.requests.at(-1).body,body);
  ui.requests.at(-1).reply({ok:true,context:lessonContext('test-a','slot-a',savedRecord(body.record))});await flush();
  assert.equal(ui.beforeUnload(),false);assert.equal(ui.html().includes('同じ処理を再試行'),false);ui.noPrivateStorage();
});

test('teacher re-login preserves unsaved private input and request ID while replacing only token',async()=>{
  const ui=await createUI().ready();ui.input('lc-content','認証切れでも残す本文');ui.input('lc-teacherNote',privateSentinel);ui.click('lc-save');const pending=clone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({error:'ログイン期限切れ',badAuth:true});await flush();
  if(ui.requests.at(-1).body.action==='authmode'){ui.requests.at(-1).reply({mode:'account'});await flush();}
  assert.equal(ui.local.has('sw_admt'),false);assert.ok(ui.el('a-email'));ui.el('a-email').value='teacher@example.invalid';ui.el('a-pass').value='test-only-password';ui.click('login');
  ui.requests.at(-1).reply({ok:true,token:'new-test-token'});await flush();
  assert.equal(ui.el('lc-content').value,'認証切れでも残す本文');assert.equal(ui.el('lc-teacherNote').value,privateSentinel);
  ui.click('lc-retry');assert.deepEqual(ui.requests.at(-1).body,{...pending,token:'new-test-token'});ui.noPrivateStorage();
});

test('revision conflict retains local input, compares latest, and requires explicit rebase before saving',async()=>{
  const ui=await createUI().ready(lessonContext('test-a','slot-a',savedRecord({},1)));ui.input('lc-content','手元で編集');ui.input('lc-teacherNote',privateSentinel);ui.click('lc-save');const first=ui.requests.at(-1).body;
  ui.requests.at(-1).reply({error:'別端末で更新されました',errorCode:'conflict'});await flush();assert.equal(ui.el('lc-content').value,'手元で編集');
  ui.click('lc-refresh');const latest=savedRecord({content:'別端末の本文',teacherNote:'別端末のメモ'},3);ui.requests.at(-1).reply({ok:true,context:lessonContext('test-a','slot-a',latest)});await flush();
  assert.equal(ui.el('lc-content').value,'手元で編集');assert.match(ui.html(),/別端末の本文/);const before=ui.requests.length;
  ui.click('lc-rebase');assert.equal(ui.requests.length,before,'comparison choice alone never saves');ui.click('lc-save');
  assert.equal(ui.requests.at(-1).body.expectedRevision,3);assert.equal(ui.requests.at(-1).body.record.content,'手元で編集');assert.notEqual(ui.requests.at(-1).body.requestId,first.requestId);ui.noPrivateStorage();
});

test('late lesson load or save responses cannot redraw another student route',async()=>{
  const ui=createUI(), oldLoad=ui.requests[0];ui.navigate(href('test-b','slot-b'));
  ui.requests.at(-1).reply({ok:true,context:lessonContext('test-b','slot-b',savedRecord({content:'Bの本文'},1,'test-b','slot-b'))});await flush();
  oldLoad.reply({ok:true,context:lessonContext('test-a','slot-a',savedRecord({content:'Aの古い応答'}))});await flush();
  assert.match(ui.html(),/Bの本文/);assert.equal(ui.html().includes('Aの古い応答'),false);
  ui.navigate(href());await flush();ui.input('lc-content','Aで保存中');ui.click('lc-save');const oldSave=ui.requests.at(-1);
  ui.navigate(href('test-b','slot-b'));await flush();oldSave.reply({ok:true,context:lessonContext('test-a','slot-a',savedRecord({content:'Aの遅れた保存'},2))});await flush();
  assert.match(ui.html(),/Bの本文/);assert.equal(ui.html().includes('Aの遅れた保存'),false);ui.noPrivateStorage();
});

test('an old-token lesson rejection cannot clear a newer teacher login from another tab',async()=>{
  const ui=createUI(), old=ui.requests[0];
  ui.local.set('sw_admt','replacement-teacher-token');ui.navigate(href('test-b','slot-b'));
  ui.requests.at(-1).reply({ok:true,context:lessonContext('test-b','slot-b',savedRecord({content:'新ログインのB本文'},1,'test-b','slot-b'))});await flush();
  old.reply({error:'以前のログインは失効しました',badAuth:true});await flush();
  assert.equal(ui.local.get('sw_admt'),'replacement-teacher-token');assert.match(ui.html(),/新ログインのB本文/);
});

test('resuming another tab pending save populates the recovered record and revision',async()=>{
  const ui=await createUI().ready(lessonContext('test-a','slot-a',null,{pending:{requestId:'another-tab-save',operation:'lessonRecordSave'}}));
  ui.click('lc-resume');assert.equal(ui.requests.at(-1).body.op,'lessonWriteResume');
  ui.requests.at(-1).reply({ok:true,operation:'lessonRecordSave',context:lessonContext('test-a','slot-a',savedRecord({content:'復旧した本文'},4))});await flush();
  assert.equal(ui.el('lc-content').value,'復旧した本文');ui.input('lc-progress','追加');ui.click('lc-save');assert.equal(ui.requests.at(-1).body.expectedRevision,4);ui.noPrivateStorage();
});

test('partial homework recovery displays the final context and stops retrying a terminal journal',async()=>{
  const r=savedRecord({homework:[{itemId:'item-a',title:'問題',due:'',type:'宿題'}]});
  const ui=await createUI().ready(lessonContext('test-a','slot-a',r,{pending:{requestId:'partial-apply',operation:'lessonHomeworkApply'}}));
  ui.click('lc-resume');ui.requests.at(-1).reply({error:'未反映の宿題を停止しました',errorCode:'conflict',partial:true,retryRequired:false,failed:['item-a'],context:lessonContext('test-a','slot-a',r,{slotChanged:true})});await flush();
  assert.equal(ui.html().includes('同じ処理を再試行'),false);assert.equal(ui.html().includes('data-action="lc-resume"'),false);assert.match(ui.html(),/未反映の宿題を停止/);ui.noPrivateStorage();
});

test('generated report excludes private notes and escaping preserves literal HTML',async()=>{
  const r=savedRecord({content:'<img src=x onerror=bad()>\n本文',teacherNote:privateSentinel});
  const ui=await createUI().ready(lessonContext('test-a','slot-a',r));assert.equal(ui.html().includes('<img src=x'),false);
  ui.click('lc-generate');assert.equal(ui.el('lc-body').value.includes(privateSentinel),false);assert.ok(ui.el('lc-body').value.includes('<img src=x'));
  ui.click('lc-report');const req=ui.requests.at(-1).body;assert.equal(req.op,'lessonReportDraftSave');assert.equal(req.body.includes(privateSentinel),false);ui.noPrivateStorage();
});
