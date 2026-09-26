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
 const file={name:'【テスト】予定表.pdf',size:20,type:'application/pdf'},host={innerHTML:'',getAttribute:()=> 'test-a',addEventListener:(t,f)=>{click=f;},querySelector:()=>({files:[file]})};
 const window={open:()=>popup,confirm:()=>true};
 const ctx={window,Uint8Array,Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout(){},FileReader:class{readAsDataURL(){this.result='data:application/pdf;base64,JVBERi0x';this.onload();}},fetch:async(_u,c)=>{const b=JSON.parse(c.body);requests.push(b);return {json:async()=> b.action==='documentList'?{documents:[{id:'doc',name:file.name,createdAt:'2026-09-26T00:00:00Z'}]}:b.action==='documentRead'?{name:file.name,base64:'JVBERi0x'}:{ok:true}};}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('assets/student-documents.js','utf8'),ctx);
 window.StepwiseDocuments.mount({querySelectorAll:()=>[host]},{teacher:true,auth:{token:'test-token'}});
 const wait=()=>new Promise(r=>setImmediate(r));await wait();assert.match(host.innerHTML,/予定表.pdf/);
 const press=(key,val='')=>click({target:{closest:()=>({hasAttribute:k=>k===key,getAttribute:()=>val})}});
 press('data-doc-upload');await wait();assert.equal(requests[1].action,'documentUpload');assert.equal(requests[1].studentId,'test-a');assert.equal(requests[2].action,'documentList');
 press('data-doc-open','doc');await wait();assert.equal(popup.location.href,'blob:synthetic');assert.equal(requests[3].action,'documentRead');
 assert.ok(requests.every(r=>r.action.startsWith('document')));
});
