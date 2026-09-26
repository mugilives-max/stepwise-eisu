/* Private PDFs. Viewing is free of AI calls; teachers explicitly request extraction. */
(function () {
  'use strict';
  var endpoint = 'https://stepwise-api.stepwise-edu.workers.dev';
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function mount(root, options) {
    root.querySelectorAll('[data-student-documents]').forEach(function(host) {
      if (host._documents) return;
      host._documents = true;
      var sid = host.getAttribute('data-student-documents'), rows = [], busy = false, error = '', loaded = false;
      var auth = Object.assign({}, options.auth, {studentId:sid});
      function call(action, payload) {
        return fetch(endpoint,{method:'POST',body:JSON.stringify(Object.assign({},payload,auth,{action:action}))}).then(function(r){return r.json();}).then(function(r){if(r.error)throw Error(r.error);return r;});
      }
      function draw() {
        host.innerHTML = '<div class="card"><p class="note">学校の予定表など、先生が登録した資料です。</p>' + (error ? '<p role="alert">'+esc(error)+'</p>' : '') +
          (options.teacher ? '<label>PDF（5MBまで） <input type="file" accept="application/pdf,.pdf" data-doc-file'+(busy?' disabled':'')+'></label> <button type="button" class="btn-primary btn-sm" data-doc-upload'+(busy?' disabled':'')+'>アップロード</button><p class="note">この生徒と保護者も閲覧できます。</p>' : '') +
          (!loaded ? '<p role="status">読み込んでいます…</p>' : rows.length ? '<ul style="padding-left:1.3em">'+rows.map(function(d){return '<li style="margin:12px 0;overflow-wrap:anywhere"><button type="button" class="btn-quiet btn-sm" data-doc-open="'+esc(d.id)+'"'+(busy?' disabled':'')+'>'+esc(d.name)+'</button> <span class="note">'+esc(d.createdAt.slice(0,10).replace(/-/g,'/'))+'</span>'+(options.teacher?' <button type="button" class="btn-quiet btn-sm" data-doc-parse="'+esc(d.id)+'"'+(busy?' disabled':'')+'>イベントを読み取る</button> <button type="button" class="btn-quiet btn-sm" data-doc-remove="'+esc(d.id)+'"'+(busy?' disabled':'')+'>削除</button>':'')+'</li>';}).join('')+'</ul>' : '<p>資料はまだありません。</p>') +
          (busy?'<p role="status">処理中です…</p>':'<button type="button" class="btn-quiet btn-sm" data-doc-refresh>再読み込み</button>')+'</div>';
      }
      function load() { return call('documentList').then(function(r){rows=r.documents;loaded=true;}); }
      function finish(e) { busy=false;if(e)error=e.message || '処理に失敗しました';draw(); }
      host.addEventListener('click',function(event) {
        var el=event.target.closest('button');if(!el||busy)return;
        if(el.hasAttribute('data-doc-upload')) {
          var file=host.querySelector('[data-doc-file]').files[0];
          if(!file||file.size>5*1024*1024||!file.size||!(/\.pdf$/i.test(file.name)||file.type==='application/pdf')){error='5MB以下のPDFを選んでください';draw();return;}
          busy=true;error='';draw();
          var reader=new FileReader();reader.onerror=function(){finish(Error('ファイルを読み込めませんでした'));};
          reader.onload=function(){call('documentUpload',{pdf:{name:file.name,mime:'application/pdf',base64:String(reader.result).split(',')[1]}}).then(load).then(function(){finish();},finish);};reader.readAsDataURL(file);
        } else if(el.hasAttribute('data-doc-open')) {
          var popup=window.open('','_blank');if(popup)popup.opener=null;
          busy=true;error='';draw();
          call('documentRead',{id:el.getAttribute('data-doc-open')}).then(function(r){
            var bytes=Uint8Array.from(atob(r.base64),function(c){return c.charCodeAt(0);}), url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
            if(popup)popup.location.href=url;
            else {var a=document.createElement('a');a.href=url;a.download=r.name;document.body.appendChild(a);a.click();a.remove();}
            setTimeout(function(){URL.revokeObjectURL(url);},300000);finish();
          },function(e){if(popup)popup.close();finish(e);});
        } else if(el.hasAttribute('data-doc-parse')) {
          openCandidates(el.getAttribute('data-doc-parse'),call);
        } else if(el.hasAttribute('data-doc-remove')) {
          if(!window.confirm('この資料を一覧から削除しますか？生徒・保護者からも見えなくなります。'))return;
          busy=true;error='';var id=el.getAttribute('data-doc-remove');draw();
          call('documentRemove',{id:id}).then(load).then(function(){finish();},finish);
        } else if(el.hasAttribute('data-doc-refresh')) {busy=true;error='';draw();load().then(function(){finish();},finish);}
      });
      draw();load().then(function(){draw();},function(e){loaded=true;finish(e);});
    });
  }
  function openCandidates(id,call) {
    var dialog=document.createElement('dialog'), now=new Date(),year=now.getFullYear()-(now.getMonth()<3?1:0), candidates=[],busy=false;
    dialog.style.cssText='width:min(960px,92vw);max-height:85vh;overflow:auto;padding:24px;border:2px solid #1010aa;border-radius:16px;';
    dialog.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center"><h3>予定表からイベントを登録</h3><button type="button" data-close>閉じる</button></div><p>PDFをClaudeに送って読み取ります。登録学年に合う行事と共通の行事を候補にします。内容を確認して選択してください。</p><label>予定表の年度 <input data-year type="number" min="2020" max="2100" value="'+year+'" style="width:7em"> 年度（4月〜翌3月）</label> <button type="button" data-read>読み取る</button><p class="note">同じ年度・学年の読み取り結果は再利用します。イベントを登録しても授業不可日にはしません。</p><p data-status role="status"></p><div data-candidates></div>';
    document.body.appendChild(dialog);dialog.showModal();
    var status=dialog.querySelector('[data-status]'),area=dialog.querySelector('[data-candidates]');
    function toggle(value){busy=value;dialog.querySelectorAll('button,input').forEach(function(el){el.disabled=value;});}
    dialog.addEventListener('cancel',function(e){if(busy)e.preventDefault();});
    dialog.addEventListener('close',function(){dialog.remove();});
    function render(){
      area.innerHTML=candidates.length?'<p>対象が曖昧な候補は未選択です。必要なものを選んでください。</p>'+candidates.map(function(e,i){return '<fieldset data-item="'+i+'" style="margin:12px 0;padding:12px"><legend><label><input type="checkbox" data-select '+(e.review?'':'checked')+'> '+(e.review?'要確認':'候補')+'</label></legend><label>開始 <input type="date" data-date value="'+esc(e.date)+'"></label> <label>終了 <input type="date" data-end value="'+esc(e.dateTo)+'"></label><p><label>内容 <input type="text" data-title maxlength="40" value="'+esc(e.title)+'" style="width:min(100%,30em)"></label> <label><input type="checkbox" data-test '+(e.test?'checked':'')+'>テスト・模試</label></p><p>'+esc(e.note)+'</p><span data-result></span></fieldset>';}).join('')+'<button type="button" class="btn-primary" data-apply>選択したイベントを登録</button>':'<p>登録できる候補はありません。年度とPDFの内容を確認してください。</p>';
    }
    dialog.addEventListener('click',async function(event){
      var button=event.target.closest('button');if(!button||busy)return;
      if(button.hasAttribute('data-close')){dialog.close();return;}
      if(button.hasAttribute('data-read')){
        var selectedYear=Number(dialog.querySelector('[data-year]').value);toggle(true);area.innerHTML='';candidates=[];status.textContent='読み取り中です…';
        try{var result=await call('documentParse',{id:id,year:selectedYear});candidates=result.events;status.textContent='登録学年：'+(result.grade||'未登録')+'。'+result.summary+(result.cached?'（保存済みの読み取り結果）':'');render();}catch(e){status.textContent=e.message;}finally{toggle(false);}
      }
      if(button.hasAttribute('data-apply')){
        var items=Array.from(area.querySelectorAll('[data-item]')).filter(function(row){return row.querySelector('[data-select]').checked && !row.dataset.saved;});
        if(!items.length){status.textContent='登録する候補を選択してください';return;}
        toggle(true);status.textContent='登録中です…';var added=0,failed=0;
        for(var row of items){
          try{var r=await call('admin',{op:'documentEventAdd',date:row.querySelector('[data-date]').value,dateTo:row.querySelector('[data-end]').value,title:row.querySelector('[data-title]').value,test:row.querySelector('[data-test]').checked});row.dataset.saved='1';row.querySelector('[data-select]').checked=false;row.querySelector('[data-result]').textContent=r.existing?'登録済み':'登録しました';added++;}
          catch(e){row.querySelector('[data-result]').textContent=e.message;failed++;}
        }
        toggle(false);area.querySelectorAll('[data-saved] input').forEach(function(el){el.disabled=true;});status.textContent=added+'件を登録しました。'+(failed?failed+'件は登録できませんでした。内容を確認して再試行してください。':'');
      }
    });
  }
  window.StepwiseDocuments={mount:mount};
}());
