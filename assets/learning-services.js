(function () {
  'use strict';
  function create(){
  var current=null;
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  var stamp=function(v){return v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'';};
  var uid=function(){return crypto.randomUUID();};
  var statuses={received:'受付済み・確認待ち',needs_confirmation:'確認事項があります',registered:'登録済み',failed:'処理できませんでした',closed:'対応済み'};
  function mount(app,cfg){
    if(current&&current.key!==cfg.key){current=null;}
    if(!current)current={key:cfg.key,open:false,data:null,busy:false,error:'',notice:'',draft:null,replyDrafts:{},message:{body:'',category:'schedule',replyTo:'',requestId:uid()},cancel:{slotId:'',reason:'',requestId:uid()}};
    var s=current;s.cfg=cfg;var host=document.createElement('section');host.className='learning-services';host.style.marginTop='24px';app.appendChild(host);s.host=host;paint(s);
  }
  function call(s,op,data){return s.cfg.call(op,data||{}).then(function(r){if(!r||r.error||r.ok!==true)throw Error(r&&r.error||'処理結果を確認できません。再試行してください');return r;});}
  function load(s){if(s.busy)return;s.busy=true;s.error='';paint(s);call(s,s.cfg.inbox?'inbox':'list').then(function(r){if(current!==s)return;s.data=r;s.busy=false;paint(s);}).catch(function(e){if(current!==s)return;s.busy=false;s.error=e.message;paint(s);});}
  function area(key,label,value,max){return '<label style="display:block;margin:12px 0">'+esc(label)+'<textarea style="display:block;width:100%;min-height:90px" data-field="'+key+'" maxlength="'+(max||4000)+'">'+esc(value)+'</textarea></label>';}
  function btn(action,label){return '<button type="button" class="btn-quiet" data-svc="'+action+'">'+label+'</button>';}
  function paint(s){
    if(current!==s||!s.host)return;var teacher=s.cfg.teacher,d=s.data||{},count=s.data?(d.messages||[]).filter(function(m){return m.status==='received'||m.status==='failed';}).length:s.cfg.pendingCount||0,h='<h2>'+(s.cfg.inbox?'連絡の受信箱（要対応 '+count+'件）':(s.cfg.panel==='exams'?'成績票・振り返り':s.cfg.panel==='cancel'?'授業の取消申請':s.cfg.panel==='messages'?'先生への連絡':'成績票・振り返り／先生への連絡'))+'</h2>';
    if(!s.open)h+=btn('open','開く');else{
      h+=btn('reload','最新の情報を確認')+' '+btn('close','閉じる');
      if(s.error)h+='<p role="alert">'+esc(s.error)+'</p>';if(s.notice)h+='<p role="status">'+esc(s.notice)+'</p>';
      if(s.busy)h+='<p role="status">処理中です…</p>';
      if(!s.cfg.inbox && (!s.cfg.panel||s.cfg.panel==='all'||s.cfg.panel==='exams')){
        h+='<h3>成績票と振り返り</h3>'+(teacher?btn('new','試験結果を追加'):'');
        (d.exams||[]).forEach(function(e){h+='<article class="card"><h3>'+esc(e.date)+' '+esc(e.title)+'</h3><p>'+ (e.kind==='school'?'定期テスト':'模試')+'</p>';
          ['reflection','analysis','nextSteps'].forEach(function(k,i){h+='<h4>'+['振り返り','分析','次回の対策'][i]+'</h4><p style="white-space:pre-wrap">'+esc(e[k]||'未記入')+'</p>';});
          if(teacher)h+='<details><summary>先生用メモ（非公開）</summary><p style="white-space:pre-wrap">'+esc(e.teacherNote||'未記入')+'</p></details>';
          if(e.hasPdf)h+='<button type="button" data-svc="pdf" data-id="'+esc(e.id)+'">PDFを開く：'+esc(e.fileName)+'</button> ';
          if(teacher)h+='<button type="button" data-svc="edit" data-id="'+esc(e.id)+'">編集する</button>';h+='</article>';});
        if(s.draft){var e=s.draft;h+='<form data-form="exam" class="card"><h3>試験結果を保存</h3><p>本文はこの生徒・保護者にも公開されます。先生用メモだけ非公開です。</p><label>試験日 <input type="date" data-field="date" value="'+esc(e.date)+'" required></label> <label>種類 <select data-field="kind"><option value="mock"'+(e.kind==='mock'?' selected':'')+'>模試</option><option value="school"'+(e.kind==='school'?' selected':'')+'>定期テスト</option></select></label><label style="display:block">試験名 <input data-field="title" maxlength="100" value="'+esc(e.title)+'" required></label><label>成績票PDF（5MBまで・任意） <input type="file" accept="application/pdf,.pdf" data-pdf></label><p>'+esc(e.pdf?e.pdf.name:e.fileName||'未添付')+'</p>'+area('reflection','振り返り',e.reflection)+area('analysis','分析',e.analysis)+area('nextSteps','次回の対策',e.nextSteps)+area('teacherNote','先生用メモ（非公開・この1欄にまとめる）',e.teacherNote)+'<button type="submit">保存して公開</button> '+btn('discard','編集をやめる')+'</form>';}
      }
      if(!s.cfg.panel||s.cfg.panel==='all'||s.cfg.panel==='messages'){
      h+='<h3>連絡</h3>';
      if(!teacher){h+='<p>送信だけでは予定の登録・取消は完了しません。先生が確認し、結果をここに返信します。AIの自動処理はまだ開始していません。</p><form data-form="message" class="card"><label>用件 <select data-message="category">'+[['schedule','予定の希望・授業不可'],['question','質問'],['feedback','使いづらさ・改善要望'],['other','その他']].map(function(x){return '<option value="'+x[0]+'"'+(s.message.category===x[0]?' selected':'')+'>'+x[1]+'</option>';}).join('')+'</select></label>'+(s.message.replyTo?'<p>前の連絡への補足・訂正です。</p>':'')+'<label style="display:block">メッセージ<textarea style="width:100%;min-height:100px" data-message="body" maxlength="4000" required>'+esc(s.message.body)+'</textarea></label><button type="submit">先生へ送る</button></form>';}
      (d.messages||[]).forEach(function(m){h+='<article class="card"><p>'+esc(m.studentName||'')+' '+esc(stamp(m.receivedAt))+' '+esc(statuses[m.status]||m.status)+'</p><p style="white-space:pre-wrap">'+esc(m.body)+'</p>'+(m.reply?'<p style="white-space:pre-wrap"><strong>先生から：</strong>'+esc(m.reply)+'</p>':'');
        if(teacher){var rd=s.replyDrafts[m.id]||m;h+='<form data-form="reply" data-id="'+esc(m.id)+'"><label>処理状況 <select name="status">'+Object.keys(statuses).map(function(k){return '<option value="'+k+'"'+(rd.status===k?' selected':'')+'>'+statuses[k]+'</option>';}).join('')+'</select></label><label style="display:block">返信・具体的な登録結果<textarea style="width:100%" name="reply" maxlength="4000">'+esc(rd.reply)+'</textarea></label><p>「登録済み」は実際の登録を確認した場合だけ選んでください。</p><button type="submit">返信と状態を保存</button></form>';} 
        else h+='<button type="button" data-svc="replyTo" data-id="'+esc(m.id)+'">補足・訂正を送る</button>';h+='</article>';});
      }
      if(!s.cfg.panel||s.cfg.panel==='all'||s.cfg.panel==='cancel'){
      if(!teacher){h+='<h3>授業の取消申請</h3><p>24時間前までは通常申請、それ以降は原則取消不可のため病気・大幅な電車遅延などの例外申請です。いずれも理由と先生の承認が必要です。承認までは予定を保持します。</p><form data-form="cancel" class="card"><label>対象授業 <select data-cancel="slotId" required><option value="">選んでください</option>'+(d.slots||[]).filter(function(x){return !x.req;}).map(function(x){return '<option value="'+esc(x.id)+'"'+(s.cancel.slotId===x.id?' selected':'')+'>'+esc(x.date+' '+x.start+' '+(x.subject||''))+'</option>';}).join('')+'</select></label><label style="display:block">理由（必須）<textarea style="width:100%" data-cancel="reason" maxlength="1000" required>'+esc(s.cancel.reason)+'</textarea></label><button type="submit">取消を申請する</button></form>';}
      (d.cancellations||[]).forEach(function(c){h+='<p>'+esc(c.date+' '+c.start)+'：'+esc(c.requestType==='exception'?'期限後の例外申請':'通常申請')+'／'+esc({received:'取消未確定・先生の確認待ち',approved:'取消承認済み',rejected:'却下・予定どおり',withdrawn:'申請取り下げ'}[c.status]||c.status)+'<br>受付：'+esc(stamp(c.receivedAt))+'<br>'+esc(c.reason)+'</p>';});
    }
    }
    s.host.innerHTML=h;s.host.querySelectorAll('button,input,textarea,select').forEach(function(el){el.disabled=!!s.busy;});
    s.host.onclick=function(ev){var b=ev.target.closest('[data-svc]');if(!b||s.busy)return;var a=b.dataset.svc,id=b.dataset.id;
      if(a==='open'){s.open=true;load(s);}if(a==='reload')load(s);if(a==='close'){if(s.draft||s.message.body){if(!confirm('未送信・編集中の内容はこのページを開いている間だけ保持されます。閉じますか？'))return;}s.open=false;paint(s);}
      if(a==='new'){s.draft={date:'',kind:'mock',title:'',reflection:'',analysis:'',nextSteps:'',teacherNote:'',expectedRevision:0,requestId:uid()};paint(s);}
      if(a==='edit'){var e=(d.exams||[]).find(function(x){return x.id===id;});s.draft=Object.assign({},e,{expectedRevision:e.revision,requestId:uid()});paint(s);}
      if(a==='discard'){if(confirm('編集内容を破棄しますか？')){s.draft=null;paint(s);}}
      if(a==='replyTo'){s.message.replyTo=id;paint(s);s.host.querySelector('[data-message="body"]').focus();}
      if(a==='pdf')run(s,'pdf',{id:id},function(r){var bytes=Uint8Array.from(atob(r.base64),function(c){return c.charCodeAt(0);}),url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=r.name||'成績票.pdf';link.click();setTimeout(function(){URL.revokeObjectURL(url);},60000);},false);
    };
    s.host.oninput=function(ev){var el=ev.target;var rf=el.closest('[data-form="reply"]');if(rf){s.replyDrafts[rf.dataset.id]={status:rf.elements.status.value,reply:rf.elements.reply.value};}if(el.dataset.field&&s.draft){s.draft[el.dataset.field]=el.value;s.draft.requestId=uid();}if(el.dataset.message){s.message[el.dataset.message]=el.value;s.message.requestId=uid();}if(el.dataset.cancel){s.cancel[el.dataset.cancel]=el.value;s.cancel.requestId=uid();}};
    s.host.onchange=function(ev){if(!ev.target.hasAttribute('data-pdf'))return;var file=ev.target.files[0];if(!file)return;if(file.size>5*1024*1024){s.error='5MB以下のPDFを選んでください';paint(s);return;}var draft=s.draft,reader=new FileReader();s.busy=true;reader.onload=function(){if(current!==s||s.draft!==draft)return;s.busy=false;draft.pdf={name:file.name,mime:'application/pdf',base64:String(reader.result).split(',')[1]};draft.requestId=uid();paint(s);};reader.onerror=function(){s.busy=false;s.error='PDFを読み込めませんでした';paint(s);};reader.readAsDataURL(file);};
    s.host.onsubmit=function(ev){ev.preventDefault();if(s.busy)return;var f=ev.target,kind=f.dataset.form;
      if(kind==='exam')run(s,'examSave',s.draft,function(){s.draft=null;s.notice='保存し、生徒・保護者へ公開しました。';});
      if(kind==='message')run(s,'messageSend',s.message,function(){s.message={body:'',category:'schedule',replyTo:'',requestId:uid()};s.notice='受け付けました。予定変更・取消はまだ確定していません。';});
      if(kind==='cancel')run(s,'cancelRequest',s.cancel,function(){s.cancel={slotId:'',reason:'',requestId:uid()};s.notice='取消を申請しました。先生の承認までは取消未確定です。';});
      if(kind==='reply'){var m=(d.messages||[]).find(function(x){return x.id===f.dataset.id;});run(s,'messageReply',{id:m.id,studentId:m.studentId||s.cfg.studentId,expectedRevision:m.revision,status:f.elements.status.value,reply:f.elements.reply.value},function(){delete s.replyDrafts[m.id];s.notice='返信と処理状況を保存しました。';});}
    };
  }
  function run(s,op,payload,done,reload){s.busy=true;s.error='';paint(s);call(s,op,payload).then(function(r){if(current!==s)return;s.busy=false;done(r);if(reload!==false)load(s);else paint(s);}).catch(function(e){if(current!==s)return;s.busy=false;s.error=e.message;paint(s);});}
  window.addEventListener('beforeunload',function(e){if(current&&(current.busy||current.draft||current.message.body||current.cancel.reason||Object.keys(current.replyDrafts).length)){e.preventDefault();e.returnValue='';}});
  document.addEventListener('click',function(e){var a=e.target.closest('a[href]');if(a&&current&&(current.draft||current.message.body||current.cancel.reason||Object.keys(current.replyDrafts).length)){if(!confirm('入力中の内容があります。移動すると失われる場合があります。移動しますか？')){e.preventDefault();e.stopImmediatePropagation();}}},true);
  return {mount:mount,clear:function(){current=null;}};
  }
  window.StepwiseServices=create();window.StepwiseServices.create=create;
})();
