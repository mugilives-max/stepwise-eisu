(function(root){
 'use strict';
 function create(){
 var current=null;
 function clear(){if(current){current.host.removeEventListener('toggle',current.listener,true);current=null;}}
 function mount(host,call,scope){
  clear();var state={host:host,call:call,scope:scope,reads:{},pending:{}};current=state;
  function label(el,text){var span=el.querySelector('[data-read-label]');if(span)span.textContent=text;}
  function paint(){if(current!==state)return;host.querySelectorAll('[data-parent-record]').forEach(function(el){var read=state.reads[el.dataset.parentRecord]||0;label(el,read>=Number(el.dataset.recordRevision)?'既読':read?'更新あり':'未読');});}
  function adopt(res){if(!res||!res.ok){var error=Error(res&&res.error||'既読状態を保存できませんでした');error.code=res&&res.errorCode;throw error;}(res.reads||[]).forEach(function(r){state.reads[r.recordId]=Math.max(state.reads[r.recordId]||0,r.readRevision);});paint();}
  state.listener=function(ev){var el=ev.target;if(current!==state||!el.matches||!el.matches('[data-parent-record]')||!el.open)return;
    var id=el.dataset.parentRecord,revision=Number(el.dataset.recordRevision);if(state.pending[id]||state.reads[id]>=revision)return;
    state.pending[id]=true;label(el,'既読を保存中…');
    call('recordRead',{recordId:id,revision:revision}).then(function(res){if(current===state)adopt(res);}).catch(function(e){if(current===state)label(el,e.code==='updated'?'更新あり・ページを再読み込みしてください':'未保存・閉じて再度開くと再試行');}).finally(function(){delete state.pending[id];});
  };
  host.addEventListener('toggle',state.listener,true);
  call('recordReadStatus',{}).then(function(res){if(current===state)adopt(res);}).catch(function(){if(current===state)host.querySelectorAll('[data-parent-record]').forEach(function(el){label(el,'状態を取得できませんでした');});});
 }
 return {mount:mount,clear:clear};
 }
 root.StepwiseLessonRead=create();root.StepwiseLessonRead.create=create;
})(window);
