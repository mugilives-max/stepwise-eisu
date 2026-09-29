const test=require('node:test'),assert=require('node:assert/strict');
const {adminReady,card,studentReady,state}=require('./helpers/operations-ui-harness.cjs');
test('document entry appears in student settings, not the schedule overview',async()=>{
 const ui=await adminReady(card(),'settings');assert.match(ui.html(),/data-student-documents="test-a"/);
 const overview=await adminReady(card());assert.doesNotMatch(overview.html(),/data-student-documents/);
});
test('student settings provide document entry without relying on a public student id',async()=>{
 const ui=await studentReady(state());ui.navigate('#student-email');assert.match(ui.html(),/data-student-documents=""/);
});

test('PDF component uploads, reloads and opens without an AI request',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');let click,requests=[],popup={opener:null,location:{},close(){}};
 const file={name:'【テスト】予定表.pdf',size:20,type:'application/pdf'},host={innerHTML:'',getAttribute:()=> 'test-a',addEventListener:(t,f)=>{click=f;},querySelector:q=>q==='[data-doc-file]'?{files:[file]}:{value:({'[data-doc-category]':'mock','[data-doc-title]':'模試結果','[data-doc-date]':'2026-09-27','[data-doc-subject]':'数学','[data-doc-note]':'復習用'})[q]||''}};
 const window={open:()=>popup,confirm:()=>true};
 const ctx={window,Uint8Array,Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout(){},FileReader:class{readAsDataURL(){this.result='data:application/pdf;base64,JVBERi0x';this.onload();}},fetch:async(_u,c)=>{const b=JSON.parse(c.body);requests.push(b);return {json:async()=> b.action==='documentList'?{documents:[{id:'doc',name:file.name,createdAt:'2026-09-26T00:00:00Z'}]}:b.action==='documentRead'?{name:file.name,base64:'JVBERi0x'}:{ok:true}};}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('assets/student-documents.js','utf8'),ctx);
 window.StepwiseDocuments.mount({querySelectorAll:()=>[host]},{teacher:true,auth:{token:'test-token'}});
 const wait=()=>new Promise(r=>setImmediate(r));await wait();assert.match(host.innerHTML,/予定表.pdf/);
 const press=(key,val='')=>click({target:{closest:()=>({hasAttribute:k=>k===key,getAttribute:()=>val})}});
 press('data-doc-upload');await wait();assert.equal(requests[1].action,'documentUpload');assert.equal(requests[1].studentId,'test-a');assert.equal(requests[1].details.category,'mock');assert.equal(requests[1].details.examDate,'2026-09-27');assert.equal(requests[1].details.title,'模試結果');assert.equal(requests[2].action,'documentList');
 press('data-doc-open','doc');await wait();assert.equal(popup.location.href,'blob:synthetic');assert.equal(requests[3].action,'documentRead');
 assert.ok(requests.every(r=>r.action.startsWith('document')));
});

test('progress page mounts results-only documents',async()=>{
 const ui=await adminReady(card(),'progress');assert.match(ui.html(),/data-student-documents="test-a" data-document-scope="results"/);
});
test('results documents exclude schedules and legacy files and disable extraction',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');let click,requests=[];
 const host={innerHTML:'',getAttribute:k=>k==='data-document-scope'?'results':'test-a',addEventListener:(_,f)=>click=f};
 const docs=['schedule','mock','test','other',''].map((category,i)=>({id:String(i),name:'FILE_'+i,details:{category},createdAt:'2026-09-29'}));
 const window={};const ctx={window,fetch:async(_,options)=>{requests.push(JSON.parse(options.body));return {json:async()=>({documents:docs})};}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('assets/student-documents.js','utf8'),ctx);
 window.StepwiseDocuments.mount({querySelectorAll:()=>[host]},{teacher:true,auth:{token:'test-token'}});await new Promise(r=>setImmediate(r));
 assert.doesNotMatch(host.innerHTML,/FILE_0|FILE_4|value="schedule"|data-doc-parse|イベントを読み取る/);assert.match(host.innerHTML,/FILE_1/);assert.match(host.innerHTML,/FILE_2/);assert.match(host.innerHTML,/FILE_3/);assert.match(host.innerHTML,/data-doc-upload/);
 click({target:{closest:()=>({hasAttribute:k=>k==='data-doc-parse',getAttribute:()=> '0'})}});assert.equal(requests.length,1);
});
