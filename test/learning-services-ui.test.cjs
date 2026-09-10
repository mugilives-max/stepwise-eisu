'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function ui(){
 const handlers={},host=()=>({innerHTML:'',style:{},querySelectorAll:()=>[]}),app={appendChild(x){this.host=x;}},requests=[];
 const sandbox={window:{addEventListener:(name,fn)=>handlers[name]=fn},document:{createElement:host,addEventListener:(name,fn)=>handlers[name]=fn},crypto:{randomUUID:()=> 'synthetic-id-0001'},confirm:()=>true,Date,console,setTimeout,clearTimeout};vm.createContext(sandbox);
 const source=fs.readFileSync('assets/learning-services.js','utf8').replace('return {mount:mount,clear:', 'window._test={state:function(){return current;},paint:paint,run:run};return {mount:mount,clear:');vm.runInContext(source,sandbox);
 const mount=(key='student-a',teacher=false)=>sandbox.window.StepwiseServices.mount(app,{key,teacher,call:(op,payload)=>new Promise((resolve,reject)=>requests.push({op,payload,resolve,reject}))});
 return {mount,app,requests,api:sandbox.window.StepwiseServices,t:sandbox.window._test,handlers};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('public panel escapes raw text and never paints the teacher note even if supplied accidentally',()=>{
 const h=ui();h.mount();const s=h.t.state();s.open=true;s.data={exams:[{id:'sample',title:'<script>attack</script>',analysis:'<img src=x>',teacherNote:'PRIVATE_NOTE'}]};h.t.paint(s);assert.equal(h.app.host.innerHTML.includes('PRIVATE_NOTE'),false);assert.ok(h.app.host.innerHTML.includes('&lt;script&gt;'));assert.ok(h.app.host.innerHTML.includes('取消未確定')||h.app.host.innerHTML.includes('承認までは'));
});
test('failed exam save retains the same draft and request ID for retry',async()=>{
 const h=ui();h.mount('teacher-a',true);const s=h.t.state();s.open=true;s.draft={requestId:'stable-request',analysis:'retain me'};
 h.t.run(s,'examSave',s.draft,()=>{s.draft=null;});h.requests[0].reject(Error('network'));await tick();assert.equal(s.draft.analysis,'retain me');assert.equal(s.busy,false);assert.equal(s.error,'network');
 h.t.run(s,'examSave',s.draft,()=>{});assert.equal(h.requests[1].payload.requestId,h.requests[0].payload.requestId);
});
test('switching the authenticated child discards the old response and private view state',async()=>{
 const h=ui();h.mount('teacher-a',true);const old=h.t.state();old.draft={teacherNote:'PRIVATE_NOTE'};let applied=false;h.t.run(old,'examSave',{requestId:'old-save'},()=>{applied=true;});
 h.mount('student-b',false);h.requests[0].resolve({ok:true});await tick();assert.equal(applied,false);assert.equal(h.t.state().draft,null);assert.equal(h.app.host.innerHTML.includes('PRIVATE_NOTE'),false);
});
test('unsent content triggers page-leave protection and teacher inbox shows pending count',()=>{
 const h=ui();h.api.mount(h.app,{key:'teacher',teacher:true,inbox:true,pendingCount:3,call:()=>Promise.resolve({ok:true})});assert.ok(h.app.host.innerHTML.includes('要対応 3件'));
 h.t.state().message.body='unsent';let prevented=false;h.handlers.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
});
