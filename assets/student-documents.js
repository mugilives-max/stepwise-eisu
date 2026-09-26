/* Private PDFs. Opening an attachment never invokes AI. */
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
          (!loaded ? '<p role="status">読み込んでいます…</p>' : rows.length ? '<ul style="padding-left:1.3em">'+rows.map(function(d){return '<li style="margin:12px 0;overflow-wrap:anywhere"><button type="button" class="btn-quiet btn-sm" data-doc-open="'+esc(d.id)+'"'+(busy?' disabled':'')+'>'+esc(d.name)+'</button> <span class="note">'+esc(d.createdAt.slice(0,10).replace(/-/g,'/'))+'</span>'+(options.teacher?' <button type="button" class="btn-quiet btn-sm" data-doc-remove="'+esc(d.id)+'"'+(busy?' disabled':'')+'>削除</button>':'')+'</li>';}).join('')+'</ul>' : '<p>資料はまだありません。</p>') +
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
        } else if(el.hasAttribute('data-doc-remove')) {
          if(!window.confirm('この資料を一覧から削除しますか？生徒・保護者からも見えなくなります。'))return;
          busy=true;error='';var id=el.getAttribute('data-doc-remove');draw();
          call('documentRemove',{id:id}).then(load).then(function(){finish();},finish);
        } else if(el.hasAttribute('data-doc-refresh')) {busy=true;error='';draw();load().then(function(){finish();},finish);}
      });
      draw();load().then(function(){draw();},function(e){loaded=true;finish(e);});
    });
  }
  window.StepwiseDocuments={mount:mount};
}());
