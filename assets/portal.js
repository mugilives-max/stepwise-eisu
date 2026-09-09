
      (function () {
        "use strict";
        var API = "https://script.google.com/macros/s/AKfycbz53sl4GgKNY1UY1gaBndjDplQk5MrA9EfShYfy05Jl4JNEFEl7-B1uKSmd0v5Mhn4Irw/exec";
        var app = document.getElementById("app");
        var WD = ["日", "月", "火", "水", "木", "金", "土"];
        var SUBJECT_COLOR = { "英語": "#3556c8", "数学": "#a86f12", "国語": "#7a4fc9", "理科": "#2e8b57", "化学": "#087e8b", "社会": "#b8466f", "5教科": "#19212a", "3教科": "#6b7280" };

        /* ---------- 状態 ---------- */
        var S = null;            // 生徒の状態(サーバーから)
        var busy = false;
        var pending = null;      // 確認バー {kind, slotId}
        var acceptBatches = Object.create(null), stateSeq = 0, stateKey = "";
        var selDate = null, selManual = false;
        var calNow = new Date(), calY = calNow.getFullYear(), calM = calNow.getMonth();
        var panel = "";          // "" | "wish" | "event" | "ng"
        var wishKind = "want";   // want=この日時 / ok=この時間帯のどこかで
        var selMode = "", selDays = {}; // 予定表で日付を選択中のモード("" | "ng" | "wish" | "event") と選んだ日付
        var previewK = null;     // 旧プレビューURLは受け付けない
        var parentStep = "pass"; // "pass" | "setup" | "data" | "logout"
        var parentNotice = "";
        var parentPlanMemos = Object.create(null), parentPlanNotice = "";
        var P = null;            // 保護者向けデータ
        var gradeMode = "score", examMode = "dev";
        var G = null, GX = [], gLoading = false; // 成績・模試(成績タブで初回に取得)
        var tabs = document.getElementById("tabs");
        function parentSection(){var part=(location.hash||'').split('/')[1]||'home';return ['home','schedule','records','grades','billing','contacts','settings'].indexOf(part)>=0?part:'home';}
        function parentNavigation(family){var prefix=family?'#family/':'#parent/';return [['home','ホーム'],['schedule','予定'],['records','授業報告・宿題'],['grades','成績'],['billing','請求・料金承認'],['contacts','連絡'],['settings','設定']].map(function(x){return '<a href="'+prefix+x[0]+'"'+(parentSection()===x[0]?' class="on" aria-current="page"':'')+'>'+x[1]+'</a>';}).join('');}
        function route() { var h = location.hash || "#home"; if (location.pathname.indexOf('/hogosha')===0 || h === "#family" || h.indexOf("#family?") === 0 || h.indexOf('#family/')===0) return "family"; if(h === '#parent' || h.indexOf('#parent/')===0)return 'family'; if (h === "#student-email" || h.indexOf("#student-email?") === 0) return "student-email"; return { "#schedule": "schedule", "#grades": "grades", "#history": "history", "#parent": "parent" }[h] || "home"; }
        function renderTabs() {
          if (route() === "family" || route() === 'parent') { tabs.innerHTML=parentNavigation(route()==='family');return; }
          if (!S || !S.me) { tabs.innerHTML = ""; return; }
          var p = route();
          tabs.innerHTML = [["#home", "home", "ホーム"], ["#schedule", "schedule", "予定"], ["#grades", "grades", "成績"], ["#history", "history", "授業の記録"], ["#student-email", "student-email", "メール通知"]]
            .map(function (t) { return '<a href="' + t[0] + '" class="' + (p === t[1] ? "on" : "") + '">' + t[2] + "</a>"; }).join("");
        }

        /* ---------- ユーティリティ ---------- */
        function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
        function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
        function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
        function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
        function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
        function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        function wdOf(ds) { var p = ds.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]).getDay(); }
        function fmtDate(ds) { var p = ds.split("-"); return (+p[1]) + "/" + (+p[2]); }
        function fmtDateW(ds) { return fmtDate(ds) + "(" + WD[wdOf(ds)] + ")"; }
        function fmtDY(ds) { if (!ds || ds.length < 10) return esc(ds || ""); var p = ds.split("-"); return p[0] + "/" + (+p[1]) + "/" + (+p[2]); }
        function cT(t) { return String(t || "").replace(/^0/, "").replace(/:00$/, ""); } // 13:00→13, 09:30→9:30
        function endTime(start, min) { var p = start.split(":"); var t = (+p[0]) * 60 + (+p[1]) + (+min); return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60); }
        function addDaysStr(ds, n) { var p = ds.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
        function yen(n) { return (Number(n) || 0).toLocaleString() + "円"; }
        function deliveryLabel(mode) { return mode === "in_person" ? "対面" : mode === "online" ? "オンライン" : "形式は先生に確認"; }
        function deliveryTag(s) { return ' <span class="tag gray">' + deliveryLabel(s.deliveryMode) + '</span>'; }
        function slotSnapshot(s) { return { id: String(s.id), date: s.date, start: s.start, min: Number(s.min), subject: s.subject || '', deliveryMode: s.deliveryMode || '' }; }
        function taskDueText(t) {
          if (t.dueMode === 'nextLesson') return '次回の' + (t.dueSubject || '同じ科目の') + '授業' + (t.due ? '（' + fmtDY(t.due) + (t.dueStart ? ' ' + t.dueStart : '') + '）まで' : '（予定未定）');
          return t.due ? fmtDY(t.due) + 'まで' : '期限なし';
        }
        var taskDrafts = Object.create(null);
        function taskDraft() {
          var k = myKey(), next = S && schedData().next;
          if (!taskDrafts[k]) taskDrafts[k] = { type:'宿題', title:'', dueMode:'nextLesson', due:next ? next.date : '', dueSubject:next ? next.subject || '' : '', open:false };
          return taskDrafts[k];
        }
        function taskDraftInput(el) {
          var field = { 'f-ttype':'type', 'f-ttitle':'title', 'f-tdue-mode':'dueMode', 'f-tdue':'due', 'f-tdue-subject':'dueSubject' }[el && el.id];
          if (!field) return false;
          var d = taskDraft(); d[field] = el.value; d.open = true; return true;
        }
        function renderTaskAdd() {
          var d = taskDraft(), dis = busy ? ' disabled' : '', subjects = [];
          ((S.slots || []).concat(S.history || [])).forEach(function (s) { if (s.subject && subjects.indexOf(s.subject) < 0) subjects.push(s.subject); });
          var h = '<details' + (d.open ? ' open' : '') + ' style="margin-top:8px"><summary style="cursor:pointer;color:var(--primary);font-size:13.5px">自分で追加する</summary><div class="row" style="margin-top:8px"><label>種類 <select id="f-ttype"' + dis + '>' + ['宿題','持ち物','メモ'].map(function (t) { return '<option' + (d.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select></label><input type="text" id="f-ttitle" aria-label="宿題・持ち物・メモの内容" placeholder="内容(例: ワークp.12〜15、単語帳を持っていく)" maxlength="80" value="' + esc(d.title) + '" style="flex:1;min-width:180px"' + dis + '></div><div class="row" style="margin-top:8px"><label>期限 <select id="f-tdue-mode"' + dis + '>' + [['nextLesson','次回の同じ科目の授業まで'],['date','日付を指定'],['none','期限なし']].map(function (x) { return '<option value="' + x[0] + '"' + (d.dueMode === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>';
          if (d.dueMode === 'nextLesson') h += '<label>科目 <input type="text" id="f-tdue-subject" list="task-subjects" maxlength="80" placeholder="例: 英語" value="' + esc(d.dueSubject) + '"' + dis + '></label><datalist id="task-subjects">' + subjects.map(function (s) { return '<option value="' + esc(s) + '"></option>'; }).join('') + '</datalist>';
          if (d.dueMode === 'date') h += '<label>期限の日付 <input type="date" id="f-tdue" value="' + esc(d.due) + '"' + dis + '></label>';
          h += '<button class="btn-primary btn-sm" data-action="taskadd"' + dis + '>追加</button></div>';
          if (d.dueMode === 'nextLesson') h += '<p class="note">選んだ科目の次の確定授業が期限です。まだ決まっていないときは「予定未定」と表示し、授業が決まると期限が入ります。</p>';
          return h + '<div class="note">先生から出た宿題・持ち物は自動でここに入ります。自分用のメモにも使えます。</div></details>';
        }
        function renderPublishedRecords(records,editable) {
          var list = records || [], h = '<h2>先生からの授業記録</h2>';
          if (!list.length) return h + '<p class="empty">公開された授業記録はまだありません。</p>';
          return h + list.map(function (r) { return '<details class="card"' + (!editable ? ' data-parent-record="'+esc(r.recordId)+'" data-record-revision="'+esc(r.revision)+'"' : '') + '><summary>' + (!editable ? '<span data-read-label class="tag">確認中</span> ' : '') + fmtDateW(r.date) + ' ' + esc(r.start) + ' ' + esc(r.subject) + '</summary>' + window.StepwiseReport.context(r.workspace) + window.StepwiseReport.view(r.report) + '<h3>授業報告</h3><p style="white-space:pre-wrap">' + esc(r.content) + '</p>' + (r.progress ? '<h3>取り組みの様子</h3><p style="white-space:pre-wrap">' + esc(r.progress) + '</p>' : '') + (r.nextFocus ? '<h3>次回の焦点</h3><p style="white-space:pre-wrap">' + esc(r.nextFocus) + '</p>' : '') + ((r.homework || []).length ? '<h3>宿題</h3><ul>' + r.homework.map(function (x) { return '<li>' + (editable && x.taskId && !x.withdrawn ? '<input type="checkbox" aria-label="'+esc(x.title)+'の完了" data-action="taskdone" data-id="'+esc(x.taskId)+'"'+(x.done?' checked':'')+'>' : x.done ? '☑ ' : '□ ') + esc(x.title) + ' <span class="small muted">' + esc(taskDueText(Object.assign({dueSubject:r.subject},x))) + '</span></li>'; }).join('') + '</ul>' : '') + '</details>'; }).join('');
        }

        var SE = { challenge:'', busy:false, message:'', error:'', email:'', removeConfirm:false, seq:0 };
        function studentEmailReadChallenge() {
          if (location.hash.indexOf('#student-email?') !== 0) return;
          SE.challenge = new URLSearchParams(location.hash.slice(15)).get('verify') || ''; SE.message = ''; SE.error = ''; SE.busy = false; ++SE.seq;
          history.replaceState(null, '', location.pathname + '#student-email');
        }
        function studentEmailMailMessage(status) {
          return status === 'suppressed' ? 'テストのためメール送信を省略しました。' : status === 'failed' ? '登録内容は保存しましたが、確認メールを送れませんでした。時間を置いて「確認メールを再送」を押してください。' : status === 'uncertain' ? '確認メールの送信結果を確認できませんでした。まず受信箱を確認してください。届かない場合は、時間を置いて新しい確認メールを申し込めます。' : '確認メールのリンクを開いてください。';
        }
        function renderStudentEmail() {
          var h = '<h1>生徒のメール通知</h1><p class="sub">授業の案内・変更・取消をメールで受け取れます。</p>', dis = SE.busy || previewK ? ' disabled' : '', s = S && S.emailStatus || {};
          if (previewK) h += '<p class="note">先生のプレビューでは確認のみできます。メールアドレスの登録・変更は生徒専用ページから行ってください。</p>';
          if (SE.error) h += '<p class="parent-error" role="alert">' + esc(SE.error) + '</p>';
          if (SE.message) h += '<p class="card" role="status">' + esc(SE.message) + '</p>';
          if (SE.challenge) { app.innerHTML = h + '<p>このメールアドレスで受信できることを確認します。</p><button class="btn-primary" data-action="se-verify"' + dis + '>メールアドレスを確認する</button> <button class="btn-quiet" data-action="se-back"' + dis + '>登録画面に戻る</button><p class="note">リンクは30分間有効です。期限が切れた場合は、元の生徒専用ページから確認メールを送り直してください。</p>'; return; }
          if (!S || !S.me) { app.innerHTML = h + '<p>登録・変更は、先生から届いた生徒専用リンクを開いて「メール通知」から行ってください。</p>'; return; }
          h += '<div class="card"><p>' + (s.verified ? '通知先：' + esc(s.email) + '（確認済み）' : '確認済みの通知先はありません。') + '</p>';
          if (s.pendingEmail) h += '<p>確認待ち：' + esc(s.pendingEmail) + '</p>' + (!SE.message && ['failed','uncertain','suppressed'].indexOf(s.mailStatus) >= 0 ? '<p role="status">' + studentEmailMailMessage(s.mailStatus) + '</p>' : '') + '<button class="btn-quiet" data-action="se-resend"' + dis + '>確認メールを再送</button>';
          h += '<form id="student-email-form"><label for="se-email">自分のメールアドレス</label><input type="email" id="se-email" autocomplete="email" maxlength="254" required value="' + esc(SE.email || s.pendingEmail || s.email || '') + '"' + dis + '><p class="note">確認メールのリンクを開くと通知先になります。変更の確認が終わるまでは、現在の確認済みアドレスを使います。</p><button class="btn-primary" type="submit"' + dis + '>確認メールを送る</button></form>';
          if (s.email || s.pendingEmail) h += SE.removeConfirm ? '<p>メール通知を解除します。</p><button class="btn-quiet" data-action="se-remove"' + dis + '>解除する</button> <button class="btn-quiet" data-action="se-cancel"' + dis + '>やめる</button>' : '<p><button class="btn-quiet" data-action="se-askremove"' + dis + '>通知先を解除する</button></p>';
          app.innerHTML = h + '</div>';
        }
        function studentEmailSend(action) {
          if (SE.busy || previewK || ['studentEmailVerify','studentEmailRequest','studentEmailResend','studentEmailRemove'].indexOf(action) < 0) return;
          var k = myKey(), seq = ++SE.seq, payload = action === 'studentEmailVerify' ? {action:action,challenge:SE.challenge} : {action:action,k:k};
          if (action === 'studentEmailRequest') { SE.email = val('se-email'); payload.email = SE.email; }
          SE.busy = true; SE.error = ''; SE.message = ''; render();
          apiPost(payload).then(function (res) {
            if (seq !== SE.seq || (action !== 'studentEmailVerify' && k !== myKey())) return;
            SE.busy = false;
            if (res.error) SE.error = res.error;
            else {
              if (res.emailStatus && S) S.emailStatus = res.emailStatus;
              if (res.verified) SE.challenge = '';
              if (action === 'studentEmailRemove') SE.email = '';
              SE.removeConfirm = false;
              var status = res.mailStatus || res.emailStatus && res.emailStatus.mailStatus;
              SE.message = res.message || (action === 'studentEmailRemove' ? 'メール通知を解除しました。' : studentEmailMailMessage(status));
              if (res.verified && myKey()) return loadState().catch(function () { SE.error = '通知先の最新情報を読み込めませんでした。元の生徒専用ページを開き直してください。'; if (route() === 'student-email') render(); });
            }
            if (route() === 'student-email') render();
          }).catch(function () { if (seq !== SE.seq) return; SE.busy = false; SE.error = '結果を確認できませんでした。メールが届いているか確認し、時間を置いて再試行してください。'; if (route() === 'student-email') render(); });
        }
        function gcalUrl(s) {
          var d = s.date.replace(/-/g, ""), st = s.start.replace(":", ""), en = endTime(s.start, s.min).replace(":", "");
          var u = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent("塾の授業" + (s.subject ? "(" + s.subject + ")" : "(ステップワイズ)")) +
            "&dates=" + d + "T" + st + "00/" + d + "T" + en + "00&ctz=Asia/Tokyo";
          if (s.meet) u += "&details=" + encodeURIComponent("Meetで参加: " + s.meet);
          return u;
        }
        function groupBlocked(list) {
          var sorted = list.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
          var groups = [], cur = null;
          sorted.forEach(function (b) {
            if (cur && String(b.note || "") === cur.note && b.date === addDaysStr(cur.end, 1)) { cur.end = b.date; cur.ids.push(b.id); }
            else { cur = { start: b.date, end: b.date, note: String(b.note || ""), ids: [b.id] }; groups.push(cur); }
          });
          return groups;
        }
        function rangeLabel(g) { return g.start === g.end ? fmtDateW(g.start) : fmtDateW(g.start) + "〜" + fmtDateW(g.end); }
        function ngWhen(b) { return b.start ? b.start + "〜" + b.end : ""; }
        // 授業できない日の一覧: 終日は連日をまとめ、時間帯は1件ずつ
        function ngRows(list) {
          var rows = groupBlocked(list.filter(function (b) { return !b.start; })).map(function (g) { return { key: g.start, label: rangeLabel(g), note: g.note, ids: g.ids }; })
            .concat(list.filter(function (b) { return b.start; }).map(function (b) { return { key: b.date + b.start, label: fmtDateW(b.date) + " " + b.start + "〜" + b.end, note: String(b.note || ""), ids: [b.id] }; }));
          return rows.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
        }
        // 日付の配列を連続する期間にまとめる → [{date, dateTo}]
        function groupDays(dates) {
          var out = [], cur = null;
          dates.slice().sort().forEach(function (d) {
            if (cur && d === addDaysStr(cur.dateTo, 1)) cur.dateTo = d;
            else { cur = { date: d, dateTo: d }; out.push(cur); }
          });
          return out;
        }
        function sameId(a, b) { return String(a) === String(b); }
        function slotCmp(a, b) { return a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1); }
        var toastTimer = null;
        function toast(msg) { var t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2800); }
        function val(id) { var el = document.getElementById(id); return el ? String(el.value || "").trim() : ""; }

        /* ---------- API ---------- */
        function apiGet(params) {
          var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
          return fetch(API + "?" + q).then(function (r) { return r.json(); });
        }
        function apiPost(body) { return fetch(API, { method: "POST", body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }
        function myKey() { return previewK || lsGet("sw_k") || ""; }
        function parentSessionKey(k) { return "sw_pt_v2:" + (k === undefined ? myKey() : k); }
        function clearParentSession(k) {
          ssDel(parentSessionKey(k)); ssDel(parentSessionKey(k) + ":logout"); ssDel("sw_pt");
          if (k === undefined || k === myKey()) { P = null; parentStep = "pass"; }
        }
        function loadState() {
          var k = myKey(), seq = ++stateSeq;
          return apiGet({ action: "state", k: k }).then(function (res) {
            if (k !== myKey() || seq !== stateSeq) return;
            if (res.error) throw new Error(res.error);
            stateKey = k; S = res; render();
          });
        }
        var wishReview=null;
        function wishModeField(prefix){return '<label>希望する形式 <select id="'+prefix+'-wmode"><option value="">選択してください</option><option value="in_person"'+((S.me||{}).deliveryMode==='in_person'?' selected':'')+'>対面</option><option value="online"'+((S.me||{}).deliveryMode==='online'?' selected':'')+'>オンライン</option></select></label>';}
        function wishStatusLabel(status){return status==='available'?'空きあり（確定前）':status==='full'?'現在は満員・要調整':status==='unavailable'?'休み・授業不可の時間帯：要調整':status==='unknown'?'先生による確認が必要':'';}
        function wishRestore(body){var prefix=body.action==='wishMany'?'b':'f';['date','start','end','min','note','mode'].forEach(function(k){var el=document.getElementById(prefix+'-w'+k);if(el)el.value=k==='mode'?body.deliveryMode:body[k] || '';});}
        function wishReviewHTML(){var w=wishReview,b=w.body;
          var h='<section class="card" aria-label="授業希望の空き状況"><h2>希望を送る前に確認</h2><p>'+esc((b.dates || [b.date]).map(fmtDateW).join('、'))+' '+esc(b.start)+(b.end?'〜'+esc(b.end):'')+' / '+esc(b.min)+'分 / '+(b.deliveryMode==='online'?'オンライン':'対面')+'</p>';
          if(b.note)h+='<p>'+esc(b.note)+'</p>';
          if(w.error)h+='<p role="alert">'+esc(w.error)+'</p>';
          if(w.busy)h+='<p role="status">'+(w.sending?'送信結果を確認しています…':'空き状況を確認しています…')+'</p>';
          if(w.result)h+=w.result.days.map(function(d){return '<p><strong>'+esc(fmtDateW(d.date))+'：'+wishStatusLabel(d.status)+'</strong>'+(d.firstStart && b.kind==='ok'?'（例：'+esc(d.firstStart)+'開始）':'')+'</p>';}).join('');
          h+='<p>空きがなくても希望は送れます。満員の場合は先生との調整が必要です。返事待ちの案内も席に数えています。希望の送信だけでは予約は確定せず、案内・確定時に再確認します。</p>';
          if(w.result)h+='<button class="btn-primary" data-action="wish-confirm"'+(w.busy?' disabled':'')+'>'+(w.result.days.some(function(d){return d.status!=="available";})?'調整が必要なことを確認して希望を送る':'この内容で希望を送る')+'</button> ';
          return h+'<button class="btn-quiet" data-action="wish-recheck"'+(w.busy?' disabled':'')+'>空き状況を再確認</button> <button class="btn-quiet" data-action="wish-back"'+(w.busy?' disabled':'')+'>入力に戻る</button></section>';
        }
        function wishCheck(body){
          if(busy || (wishReview && wishReview.busy))return;
          var w={key:myKey(),body:JSON.parse(JSON.stringify(body)),busy:true,result:null,error:''};wishReview=w;render();
          apiPost(Object.assign({},body,{action:'wishAvailability'})).then(function(res){if(wishReview!==w || w.key!==myKey())return;if(res.error)throw Error(res.error);w.result=res;}).catch(function(er){w.error=er.message || '確認できませんでした。入力は保持しています。';}).then(function(){w.busy=false;if(wishReview===w && w.key===myKey())render();});
        }
        function wishSend(){
          var w=wishReview;if(!w||w.busy||!w.result||w.key!==myKey()||busy||acceptBatch().pending)return;
          var body=Object.assign({},w.body,{availabilitySeen:w.result.days.map(function(d){return {date:d.date,status:d.status};})});
          w.busy=true;w.sending=true;w.error='';render();
          apiPost(body).then(function(res){
            if(wishReview!==w || w.key!==myKey())return;
            if(res.error){if(res.availability)w.result=res.availability;throw Error(res.error);}
            if(!res.ok || !res.state)throw Error('送信結果を確認できませんでした。同じ内容で再試行してください。');
            stateKey=w.key;S=res.state;wishReview=null;selMode='';selDays={};toast('希望を先生に送りました');
          }).catch(function(er){w.error=er.message || '送信結果が不明です。同じ内容で再試行してください。';}).then(function(){w.busy=false;w.sending=false;if(w.key===myKey())render();});
        }
        function studentAction(body, okMsg, onSuccess) {
          if (busy) return;
          if (acceptBatch().pending) { toast("先に一括確定の結果を確認してください"); return; }
          if (acceptBatch().refreshRequired) { toast('先に最新の案内を再読み込みしてください'); return; }
          var actionKey = myKey();
          busy = true; render();
          apiPost(body).then(function (res) {
            if (actionKey !== myKey()) return;
            busy = false; pending = null;
            if (res.error) {
              toast(res.error);
              if (res.badCode) { S = { me: null, slots: [], today: "" }; render(); return; }
              if (res.refresh) return loadState();
              render(); return;
            }
            stateKey = actionKey; S = res.state; if (onSuccess) onSuccess(); render();
            if (okMsg) toast(okMsg);
          }).catch(function () { if (actionKey !== myKey()) return; busy = false; toast("通信に失敗しました。電波の良いところでもう一度お試しください"); render(); });
        }

        function batchSessionKey(k) { return "sw_accept_v1:" + k; }
        function batchValid(p) { return p && /^[A-Za-z0-9_-]{8,100}$/.test(String(p.requestId || '')) && Array.isArray(p.slotIds) && p.slotIds.length > 0 && p.slotIds.length <= 31 && p.slotIds.every(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 100; }) && Array.isArray(p.slots) && p.slots.length === p.slotIds.length && p.slots.every(function (s) { return s && p.slotIds.indexOf(s.id) >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{2}:\d{2}$/.test(s.start) && Number(s.min) > 0; }); }
        function batchRemember(k, b) {
          if (!b.pending) { ssDel(batchSessionKey(k)); return; }
          ssSet(batchSessionKey(k), JSON.stringify({ requestId: b.pending.requestId, slotIds: b.pending.slotIds, slots: (b.review || b.rows || []).map(function (s) { return { id: s.id, date: s.date, start: s.start, min: s.min, subject: s.subject, deliveryMode: s.deliveryMode }; }) }));
        }
        function acceptBatch() {
          var k = myKey(), b = acceptBatches[k];
          if (!b) {
            b = acceptBatches[k] = { selected: Object.create(null), review: null, pending: null, results: [], busy: false, refreshRequired: false, message: "" };
            try { var saved = JSON.parse(ssGet(batchSessionKey(k)) || 'null'); if (batchValid(saved)) { b.pending = { action: 'acceptMany', k: k, requestId: saved.requestId, slotIds: saved.slotIds, expectedSnapshots: saved.slots.map(slotSnapshot) }; b.review = saved.slots || []; b.rows = b.review; b.message = '前回の確定処理を確認します。同じ処理を再試行してください。'; } } catch (e) { ssDel(batchSessionKey(k)); }
          }
          var server = stateKey === k && S && (S.pendingAccepts || []).filter(batchValid)[0];
          if (server && !b.busy) {
            if (!b.pending || b.pending.requestId !== server.requestId || JSON.stringify(b.pending.slotIds.slice().sort()) !== JSON.stringify(server.slotIds.slice().sort())) {
              b.pending = { action: 'acceptMany', k: k, requestId: server.requestId, slotIds: server.slotIds.slice() };
              b.results = []; b.message = '未完了の確定処理があります。確定済みの日時を含む元の選択で再試行できます。';
            }
            b.review = server.slots; b.rows = b.review; batchRemember(k, b);
          }
          return b;
        }
        function batchReview() {
          var b = acceptBatch(); if (b.busy || b.pending || b.refreshRequired || busy) return;
          var selected = schedData().offers.filter(function (s) { return b.selected[s.id]; });
          if (!selected.length || selected.length > 31) { toast("1〜31件の案内を選んでください"); return; }
          b.review = selected.map(function (s) { return Object.assign({}, s); }); b.rows = b.review; b.results = []; b.message = ""; render();
        }
        function batchSend() {
          var b = acceptBatch(), k = myKey(); if (b.busy || b.refreshRequired || busy) return;
          if (!b.pending) {
            if (!b.review || !b.review.length) return;
            b.pending = { action: "acceptMany", k: k, slotIds: b.review.map(function (s) { return s.id; }), expectedSnapshots: b.review.map(slotSnapshot), requestId: window.crypto.randomUUID() };
          }
          batchRemember(k, b);
          b.busy = true; b.message = "確定しています…"; render();
          var payload = b.pending;
          apiPost(payload).then(function (res) {
            if (b.pending !== payload) return;
            b.busy = false; b.results = res.results || [];
            b.message = res.warning || res.error || (res.pending ? "確定済みの日時を確認し、残りの処理を再試行してください。" : "選んだ授業を確定しました。");
            if (res.ok && !res.pending) { b.pending = null; b.review = null; b.selected = Object.create(null); }
            else if (!res.pending && res.errorCode !== 'pending') { b.pending = null; b.review = null; }
            batchRemember(k, b);
            if (k !== myKey()) return;
            if (res.refresh && !res.pending && res.errorCode !== 'pending') {
              b.selected = Object.create(null); b.results = []; pending = null;
              return batchRefresh(k, b);
            }
            if (res.state) { ++stateSeq; stateKey = k; S = res.state; }
            render();
          }).catch(function () { b.busy = false; b.message = "通信に失敗しました。確定済みの日時があっても、同じ処理を再試行できます。"; if (k === myKey()) render(); });
        }
        function batchRefresh(k, b) {
          if (k !== myKey() || b.pending || b.busy) return;
          b.refreshRequired = true; b.busy = true; b.message = '案内が更新されたため、最新の予定を読み込んでいます…'; render();
          var seq = ++stateSeq;
          return apiGet({ action:'state', k:k }).then(function (res) {
            b.busy = false;
            if (k !== myKey() || seq !== stateSeq) return;
            if (res.error) throw new Error(res.error);
            b.refreshRequired = false; b.message = '最新の案内を表示しました。日時・科目・形式を確認して、もう一度選んでください。';
            stateKey = k; S = res; render();
          }).catch(function () {
            b.busy = false;
            if (k !== myKey() || seq !== stateSeq) return;
            b.message = '最新の案内を読み込めませんでした。再読み込みしてから、日時を選び直してください。'; render();
          });
        }
        function renderBatch(b) {
          var h = b.message ? '<p class="parent-error" role="status">' + esc(b.message) + '</p>' : '';
          if (b.refreshRequired) h += '<button class="btn-primary" data-action="batchrefresh"' + (b.busy ? ' disabled' : '') + '>' + (b.busy ? '読み込み中…' : '最新の案内を再読み込み') + '</button>';
          if (b.review) h += '<div class="card" role="region" aria-label="確定する日時の確認"><strong>次の' + b.review.length + '件を確定します</strong>' + b.review.map(function (s) { return '<p>' + fmtDateW(s.date) + ' ' + esc(s.start) + '〜' + endTime(s.start, s.min) + ' ' + esc(s.subject) + '・' + deliveryLabel(s.deliveryMode) + '</p>'; }).join('') + '<p class="note">月間計画の承認と定員を確認します。カレンダー登録と通知を行い、オンライン授業にはMeetを発行します。</p>' + (b.pending ? '' : '<button class="btn-primary" data-action="batchsend">この日時で確定する</button> <button class="btn-quiet" data-action="batchcancel">選び直す</button>') + '</div>';
          if (b.results.length) h += '<ul>' + b.results.map(function (x) { var s = (b.review || b.rows || []).filter(function (r) { return sameId(r.id, x.slotId); })[0] || (S.slots || []).filter(function (r) { return sameId(r.id, x.slotId); })[0]; return '<li>' + (s ? fmtDateW(s.date) + ' ' + esc(s.start) : '選択した授業') + '：' + ({ booked: '確定済み', pending: '未完了', error: '確認が必要' }[x.status] || '確認中') + (x.error ? '・' + esc(x.error) : '') + '</li>'; }).join('') + '</ul>';
          if (b.pending) h += '<button class="btn-primary" data-action="batchsend"' + (b.busy ? ' disabled' : '') + '>' + (b.busy ? '処理中…' : '同じ処理を再試行') + '</button><p class="note">完了するまでこのタブを閉じないでください。</p>';
          return h;
        }

        /* ---------- 予定表 ---------- */
        function renderCal(info, today, showToff) {
          var label = calY + "年" + (calM + 1) + "月";
          var minIdx = calNow.getFullYear() * 12 + calNow.getMonth() - 2, curIdx = calY * 12 + calM, maxIdx = minIdx + 5;
          var h = '<div class="card cal"><div class="calhead">';
          h += '<button class="btn-quiet btn-sm" data-action="calprev"' + (curIdx <= minIdx ? " disabled" : "") + ' aria-label="前の月">◀</button>';
          h += '<span class="callabel">' + label + "</span>";
          h += '<button class="btn-quiet btn-sm" data-action="calnext"' + (curIdx >= maxIdx ? " disabled" : "") + ' aria-label="次の月">▶</button>';
          h += '</div><div class="calgrid">';
          WD.forEach(function (w, i) { h += '<span class="calwd' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + w + "</span>"; });
          var startWd = new Date(calY, calM, 1).getDay();
          for (var i = 0; i < startWd; i++) h += "<span></span>";
          var days = new Date(calY, calM + 1, 0).getDate();
          for (var d = 1; d <= days; d++) {
            var ds = calY + "-" + pad(calM + 1) + "-" + pad(d);
            var it = info[ds], wd = (startWd + d - 1) % 7, cls = "calday", past = ds < today;
            if (wd === 0) cls += " sun"; if (wd === 6) cls += " sat";
            if (ds === today) cls += " today"; if (ds === selDate) cls += " sel";
            var hasItems = !!(it && it.labels && it.labels.length);
            if (showToff && it && it.toff && !past) cls += " toff";
            var marks = '<span class="calmarks">';
            if (it && !past) {
              if (it.mine) cls += " mine";
              if (it.offer && !it.mine) marks += '<span class="caldot of"></span>';
              if (it.ngAll) marks += '<span class="calmark">×</span>';
            }
            if (selMode && selDays[ds] && !past) { cls += " selday " + selMode; if (selMode === "ng" && !(it && it.ng)) marks += '<span class="calmark" style="color:var(--danger)">×</span>'; }
            marks += "</span>";
            if (it && it.ngT && !past) it.ngT.slice(0, 2).forEach(function (b) { marks += '<span class="callbl to">×' + cT(b.start) + '-' + cT(b.end) + '</span>'; });
            if (showToff && it && it.toff && !past) marks += '<span class="callbl to">先生休み</span>';
            if (showToff && it && it.toffT && !past) it.toffT.slice(0, 2).forEach(function (o) { marks += '<span class="callbl to">先生休み' + cT(o.start) + '-' + cT(o.end) + '</span>'; });
            if (hasItems) {
              var lb = it.labels.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
              lb.slice(0, 2).forEach(function (l) {
                if (l.st === "event") { marks += '<span class="callbl ' + (l.kind === "test" ? "ts" : "ev") + '">' + esc(l.text) + "</span>"; return; }
                var lc = l.st === "offer" ? " of" : (l.st === "done" || l.st === "past") ? " dn" : "";
                marks += '<span class="callbl tm' + lc + '">' + esc(l.start) + '</span><span class="callbl' + lc + '">' + esc(l.text) + "</span>";
              });
              if (lb.length > 2) marks += '<span class="callbl more">+' + (lb.length - 2) + "</span>";
            }
            var clickable = !past || hasItems; // 今日以降はどの日もタップ可(その日の操作ボタンが出る)
            if (!clickable) h += '<span class="' + cls + (past && hasItems ? "" : " off") + '">' + d + marks + "</span>";
            else h += '<button class="' + cls + '" data-action="calday" data-date="' + ds + '">' + d + marks + "</button>";
          }
          h += '</div><div class="callegend">';
          h += '<span><span class="callbl" style="display:inline">科目</span> 授業(確定)</span>';
          h += '<span><span class="callbl of" style="display:inline">科目</span> 授業登録(未確定)</span>';
          h += '<span><span class="callbl dn" style="display:inline">科目</span> 実施済み</span>';
          h += '<span><span class="callbl ev" style="display:inline">予定</span> 共有した予定</span>';
          h += '<span><span class="callbl ts" style="display:inline">テスト</span> テスト・模試</span>';
          h += '<span><span class="calmark">×</span> 授業できない日</span>';
          if (showToff) h += '<span><span class="callbl to" style="display:inline">先生休み</span> 先生の休み(授業なし)</span>';
          h += "</div></div>";
          return h;
        }

        /* ---------- 画面: 専用リンクなし ---------- */
        function renderGuard() {
          app.innerHTML = '<div class="card" style="margin-top:26px;text-align:center;padding:28px 20px">' +
            '<div style="font-weight:700;font-size:16px;margin-bottom:8px">専用リンクからひらいてください</div>' +
            '<div style="font-size:13.5px;color:var(--muted)">このページは、先生からLINEで送られた<br>あなた専用のリンクからひらく必要があります。<br>リンクが分からないときは、LINEで先生に連絡してください。</div></div>' +
            '<footer class="app"><span></span><span></span></footer>';
        }

        /* ---------- 画面: 生徒のマイページ ---------- */
        // ホーム・予定ページで共通に使う予定データ
        function schedData() {
          var today = S.today;
          var now = new Date();
          var nowStr = pad(now.getHours()) + ":" + pad(now.getMinutes());
          var slots = S.slots.slice().sort(slotCmp);
          var mine = slots.filter(function (s) { return s.st === "mine"; });
          var offers = slots.filter(function (s) { return s.st === "offer"; });
          var hist = (S.history || []).map(function (h) { return { id: h.id, date: h.date, start: h.start, min: h.min, subject: h.subject, deliveryMode: h.deliveryMode, st: h.done ? "done" : "past" }; });
          var blocked = S.blocked || [];
          var events = (S.events || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
          var evDays = [];
          events.forEach(function (e) { var d = e.date; for (var i = 0; i < 61 && d <= e.dateTo; i++) { evDays.push({ date: d, title: e.title, id: e.id, st: "event", kind: e.kind }); d = addDaysStr(d, 1); } });
          var byDate = {}, dates = [];
          slots.forEach(function (s) { if (!byDate[s.date]) { byDate[s.date] = []; dates.push(s.date); } byDate[s.date].push(s); });
          hist.forEach(function (s) { (byDate[s.date] = byDate[s.date] || []).push(s); });
          evDays.forEach(function (e) { (byDate[e.date] = byDate[e.date] || []).push(e); });
          function hasVisible(d) { return (byDate[d] || []).some(function (s) { return s.st === "offer" || s.st === "mine"; }); }
          if (selDate === null || (!selManual && !hasVisible(selDate))) {
            var found = null;
            for (var di = 0; di < dates.length; di++) if (hasVisible(dates[di])) { found = dates[di]; break; }
            selDate = found || today;
            var sp = selDate.split("-"); calY = +sp[0]; calM = +sp[1] - 1;
          }
          var info = {};
          slots.concat(hist).concat(evDays.map(function (e) { return { date: e.date, subject: e.title, st: "event", start: "99:99", kind: e.kind }; })).forEach(function (s) {
            var it = info[s.date] || (info[s.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] });
            if (s.st === "done" || s.st === "past") it.past++; else if (s.st === "event") it.ev++; else it[s.st]++;
            it.labels.push({ text: s.subject || (s.st === "event" ? "予定" : "授業"), st: s.st, start: s.start, kind: s.kind });
          });
          blocked.forEach(function (b) { var it = info[b.date] || (info[b.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); it.ng++; if (b.start) (it.ngT = it.ngT || []).push(b); else it.ngAll = 1; });
          (S.teacherOff || []).forEach(function (o) { var it = info[o.date] || (info[o.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); if (o.start) (it.toffT = it.toffT || []).push(o); else it.toff = 1; });
          var upcoming = mine.filter(function (s) { return s.date > today || (s.date === today && endTime(s.start, s.min) >= nowStr); });
          return { today: today, slots: slots, mine: mine, offers: offers, hist: hist, blocked: blocked, events: events, byDate: byDate, info: info, upcoming: upcoming, next: upcoming[0] };
        }

        function previewBanner(long) {
          if (!previewK) return "";
          return '<div style="background:var(--amber-soft);border:1px solid #d99a2b;color:var(--amber);border-radius:12px;padding:10px 14px;font-size:13.5px;margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1"><strong>' + esc(S.me.name) + 'さんのページを表示中</strong>(先生プレビュー' + (long ? '。ここでの操作は本人として反映されます' : '') + ')</span><a class="btn-quiet btn-sm" href="../kanri/" style="text-decoration:none">管理画面へ</a></div>';
        }

        // 選んだ日の内訳。withActions=true なら「この日に:」のボタン(予定ページ)、showToff=false なら先生の休みを出さない(ホーム)
        function renderDayDetail(D, withActions, showToff) {
          var today = D.today;
          var ds2 = (D.byDate[selDate] || []).slice().sort(function (a, b) { return (a.start || "99") < (b.start || "99") ? -1 : 1; });
          var dayNg = D.blocked.filter(function (b) { return b.date === selDate; });
          var dayOffs = showToff ? (S.teacherOff || []).filter(function (o) { return o.date === selDate; }) : [];
          var dayToff = dayOffs.some(function (o) { return !o.start; });
          var html = '<div style="margin-top:10px"><div class="small muted" style="margin-bottom:6px">' + fmtDateW(selDate) + '</div>';
          if (!ds2.length && !dayNg.length && !dayOffs.length) html += '<div class="empty">この日の予定はありません</div>';
          else {
            html += '<div class="chips">';
            dayOffs.forEach(function (o) { html += '<span class="chip toff">' + (o.start ? '先生の休み ' + o.start + '〜' + o.end : '先生の休み(終日・授業なし)') + '</span>'; });
            ds2.forEach(function (s) {
              if (s.st === "event") { html += '<span class="chip ' + (s.kind === "test" ? "ts" : "ev") + '">' + (s.kind === "test" ? "テスト " : "") + esc(s.title) + "</span>"; return; }
              var label = s.start + "〜" + endTime(s.start, s.min) + (s.subject ? " " + esc(s.subject) : "") + '・' + deliveryLabel(s.deliveryMode);
              if (s.st === "mine") html += '<span class="chip mine">✓ ' + label + "</span>";
              else if (s.st === "done") html += '<span class="chip done">実施済 ' + label + "</span>";
              else if (s.st === "past") html += '<span class="chip past">' + label + "</span>";
              else if (s.st === "offer") html += '<button class="chip offer" data-action="askaccept" data-id="' + esc(s.id) + '">案内 ' + label + "</button>";
            });
            dayNg.forEach(function (b) { html += '<span class="chip ng">× 授業できない' + (b.start ? " " + b.start + "〜" + b.end : "") + (b.note ? " " + esc(b.note) : "") + '</span>'; });
            html += '</div>';
          }
          if (selDate >= today) {
            if (withActions) {
              html += '<div class="row" style="margin-top:10px;gap:6px"><span class="small muted">この日に:</span>' +
                (dayToff ? "" : '<button class="btn-quiet btn-sm" data-action="dayact" data-m="wish" data-date="' + selDate + '">授業を希望</button>') +
                '<button class="btn-quiet btn-sm" data-action="dayact" data-m="event" data-date="' + selDate + '">予定を共有</button>' +
                '<button class="btn-quiet btn-sm" data-action="dayact" data-m="ng" data-date="' + selDate + '">' + (dayNg.length ? "授業できない日を解除" : "授業できない日にする") + '</button></div>';
            } else {
              html += '<div class="small muted" style="margin-top:8px">授業の希望・予定の共有・授業できない日の登録は <a href="#schedule">「予定」ページ</a> から</div>';
            }
          }
          return html + '</div>';
        }

        function renderNextLesson(D) {
          var today = D.today, next = D.next;
          var html = '<h2>次の授業</h2>';
          if (next) {
            var untilTxt = next.date === today ? "今日" : next.date === addDaysStr(today, 1) ? "明日" : Math.round((new Date(next.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5) + "日後";
            html += '<div class="card next"><div class="in">' + untilTxt + '</div><div class="when">' + fmtDateW(next.date) + " " + next.start + "〜" + endTime(next.start, next.min) + '</div>';
            html += '<div class="row" style="margin-top:4px">' + (next.subject ? '<span class="tag blue">' + esc(next.subject) + '</span>' : "") + deliveryTag(next) + '<span class="small muted">' + next.min + "分</span>" + (next.req ? '<span class="tag red">取消を依頼中</span>' : "") + '</div>';
            html += '<div class="row" style="margin-top:10px">';
            if (next.meet) html += '<a class="btn-primary btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(next.meet) + '">Meetに参加</a>';
            html += '<a class="btn-ghost btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + gcalUrl(next) + '">カレンダーに追加</a>';
            html += cancelControl(next) + '</div></div>';
          } else {
            html += '<div class="empty">次の授業はまだ決まっていません。' + (D.offers.length ? '下の「授業登録」から確定してください。' : '先生から案内が届くとここに表示されます。') + '</div>';
          }
          return html;
        }

        function renderOffers(D) {
          var offers = D.offers, b = acceptBatch(), html = renderBatch(b);
          if (!offers.length) return html;
          html += '<h2>授業登録 <span class="cnt">' + offers.length + '件・返事をお願いします</span></h2><div class="card" style="border-color:#d99a2b">';
          html += '<div class="row"><button class="btn-quiet btn-sm" data-action="batchall"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>全件選択（31件まで）</button><button class="btn-quiet btn-sm" data-action="batchclear"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>選択を解除</button></div>';
          offers.forEach(function (s) {
            html += '<div class="slotline"><label><input type="checkbox" data-accept-id="' + esc(s.id) + '"' + (b.selected[s.id] ? ' checked' : '') + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + ' aria-label="' + esc(fmtDateW(s.date) + ' ' + s.start + 'を選択') + '"></label><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (s.subject ? esc(s.subject) : "") + deliveryTag(s) + "</span>";
            html += '<button class="btn-primary btn-sm" data-action="askaccept" data-id="' + esc(s.id) + '"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>確定</button><button class="btn-quiet btn-sm" data-action="askdecline" data-id="' + esc(s.id) + '">再調整</button></div>';
          });
          html += '<button class="btn-primary" data-action="batchreview"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>選んだ日時を確認する</button></div><div class="note">日時を確認してから確定します。日時が合わないときは「再調整」で先生に別の日時をお願いできます。</div>';
          return html;
        }

        function renderUpcoming(D, hasNextCard) {
          var upcoming = D.upcoming, next = D.next;
          var html = '<h2>今後の予定 <span class="cnt">' + upcoming.length + '件</span></h2>';
          if (upcoming.length > 1 || (upcoming.length === 1 && !(hasNextCard && next))) {
            html += '<div class="card">';
            upcoming.forEach(function (s) {
              html += '<div class="slotline"><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (s.subject ? esc(s.subject) : "") + (s.req ? ' <span class="tag red">取消を依頼中</span>' : "") + "</span>";
              html += deliveryTag(s);
              if (s.meet) html += '<a class="btn-ghost btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(s.meet) + '">Meet</a>';
              html += cancelControl(s) + "</div>";
            });
            html += '</div>';
          } else if (upcoming.length === 1) {
            html += '<div class="empty">上の「次の授業」の1件だけです</div>';
          } else {
            html += '<div class="empty">確定している授業はありません</div>';
          }
          html += '<div class="note">取消には理由と先生の承認が必要です。24時間前までは通常申請、それ以降は病気・大幅な電車遅延などの例外申請です。承認までは予定を保持します。受付時刻で期限を判定します。</div>';
          return html;
        }

        // 画面下の確認バー(確定・再調整・取消依頼・取り下げ)。ホーム・予定ページ共通
        function renderPendingBar(D) {
          if (!pending) return "";
          var s = null, slots = D.slots;
          for (var i = 0; i < slots.length; i++) if (sameId(slots[i].id, pending.slotId)) s = slots[i];
          if (!s) return "";
          var when = fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min);
          var html = '<div class="confirmbar"><div class="inner">';
          if (pending.kind === "accept") {
            html += '<div class="msg">' + when + " の授業を確定しますか?</div>";
            html += '<div class="row"><button class="btn-primary" data-action="doaccept"' + (busy ? " disabled" : "") + ">" + (busy ? "確定しています…" : "確定する") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "decline") {
            html += '<div class="msg">' + when + " の日時の再調整を先生にお願いしますか?<br><span class='small muted'>この案内は取り下げられ、先生が別の日時を登録します。</span></div>";
            html += '<div class="row"><button class="btn-danger" data-action="dodecline"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "再調整をお願いする") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "cancel") {
            html += '<div class="msg">' + when + " の授業の取消を先生に依頼しますか?<br><span class='small muted'>先生が確認してから取消になります。それまでは予定のままです。</span></div>";
            html += '<input type="text" id="f-creason" maxlength="1000" required value="' + esc(pending.reason || '') + '" placeholder="理由（必須）" style="width:100%;margin:6px 0 8px"><p>24時間前を過ぎた申請は原則取消不可のため、例外として認められる事情を記入してください。</p>';
            html += '<div class="row"><button class="btn-danger" data-action="docancel"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "取消を依頼する") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "withdraw") {
            html += '<div class="msg">' + when + " の取消依頼を取り下げて、予定どおり授業を受けますか?</div>";
            html += '<div class="row"><button class="btn-primary" data-action="dowithdraw"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "依頼を取り下げる") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          }
          return html + "</div></div>";
        }

        // 予定ページの画面下: 日付を選択中のバー(授業できない日・希望・予定共有)
        function renderSelBar(D) {
          if (!selMode) return "";
          var blocked = D.blocked;
          var selDates = Object.keys(selDays).filter(function (d) { return selDays[d]; }).sort();
          var selTxt = selDates.length ? selDates.map(fmtDateW).join("、") : "予定表の日付をタップすると選べます(もう一度タップで取り消し)";
          var html = '<div class="confirmbar selbar ' + selMode + '"><div class="inner">';
          if (selMode === "ng") {
            var ngByDate = {};
            blocked.forEach(function (b) { (ngByDate[b.date] = ngByDate[b.date] || []).push(b.id); });
            var addN = selDates.filter(function (d) { return !ngByDate[d]; }).length, remN = selDates.length - addN;
            html += '<div class="msg">授業できない日: ' + selDates.length + '日' + (selDates.length ? '(登録 ' + addN + '日' + (remN ? '・解除 ' + remN + '日' : '') + ')' : '') + '</div>';
            html += '<div class="small muted" style="margin-bottom:8px">' + selTxt + (selDates.length ? "" : "。×が付いている日をタップすると解除") + '</div>';
            html += '<div class="row" style="margin-bottom:6px"><span class="small muted">時間帯(任意。空欄なら終日)</span><input type="time" id="b-ngstart" step="900"><span class="muted">〜</span><input type="time" id="b-ngend" step="900"></div>';
            html += '<div class="row"><input type="text" id="b-ngnote" placeholder="メモ(任意。例: 大会)" maxlength="50" style="flex:1;min-width:140px"><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "登録しています…" : "この内容で登録") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          } else if (selMode === "wish") {
            html += wishModeField('b');
            html += '<div class="msg">授業の希望: ' + selDates.length + '日</div><div class="small muted" style="margin-bottom:8px">' + selTxt + '</div>';
            html += '<div class="row" style="margin-bottom:8px"><span class="seg"><button data-action="wkind" data-k="want" class="' + (wishKind === "want" ? "on" : "") + '">この日時に授業をしたい</button><button data-action="wkind" data-k="ok" class="' + (wishKind === "ok" ? "on" : "") + '">この時間帯のどこかで</button></span></div>';
            if (wishKind === "want") html += '<div class="row"><input type="time" id="b-wstart" value="17:00" step="900"><select id="b-wmin"><option value="60">60分</option><option value="90" selected>90分</option><option value="120">120分</option></select><input type="text" id="b-wnote" placeholder="メモ(任意)" maxlength="100" style="flex:1;min-width:120px"><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "空き状況を確認") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
            else html += '<div class="row"><input type="time" id="b-wstart" value="13:00" step="900"><span class="muted">〜</span><input type="time" id="b-wend" value="18:00" step="900"><label>授業の長さ<select id="b-wmin"><option value="30">30分</option><option value="45">45分</option><option value="60">60分</option><option value="90" selected>90分</option><option value="120">120分</option></select></label><input type="text" id="b-wnote" placeholder="メモ(任意)" maxlength="100" style="flex:1;min-width:120px"><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "空き状況を確認") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          } else if (selMode === "event") {
            var rangesTxt = groupDays(selDates).map(function (g) { return g.date === g.dateTo ? fmtDateW(g.date) : fmtDateW(g.date) + "〜" + fmtDateW(g.dateTo); }).join("、");
            html += '<div class="msg">予定を共有: ' + selDates.length + '日</div><div class="small muted" style="margin-bottom:8px">' + (selDates.length ? rangesTxt : selTxt) + '</div>';
            html += '<div class="row"><input type="text" id="b-etitle" placeholder="内容(例: 大会、高校見学)" maxlength="40" style="flex:1;min-width:160px"><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="b-etest"> テスト・模試</label><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="b-eblock"> 授業できない日にもする</label><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "先生に共有") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          }
          return html + '</div></div>';
        }

        function renderStudent() {
          if (route() === 'student-email') { renderTabs(); renderStudentEmail(); return; }
          renderTabs();
          if (route() === "family") { renderFamily(); return; }
          if (!S || !S.me) { renderGuard(); return; }
          var page = route();
          if (page !== "home" && page !== "schedule") {
            var hh = previewBanner(false);
            if (page === "grades") hh += renderGradesPage();
            else if (page === "history") hh += renderHistoryPage();
            else hh += renderParentPage();
            hh += '<footer class="app"><span></span><span></span></footer>';
            app.innerHTML = hh;
            return;
          }
          app.innerHTML = page === "schedule" ? renderSchedulePage() : renderHomePage();
        }

        /* ---------- ホーム: 今月の授業・やること・予定表(先生の休みなし)・次の授業・授業登録・今後の予定 ---------- */
        function renderHomePage() {
          var D = schedData(), today = D.today, mine = D.mine, events = D.events;
          var html = previewBanner(true);

          // 見出し + 今月の授業
          html += '<h1>' + esc(S.me.name) + 'さんのマイページ</h1><p class="sub">今月の授業・やること・次の授業</p>';
          (function () {
            var ym = today.slice(0, 7);
            var histM = (S.history || []).filter(function (h) { return h.date.slice(0, 7) === ym; });
            var doneM = histM.filter(function (h) { return h.done; });
            var planM = mine.filter(function (s) { return s.date.slice(0, 7) === ym; }).concat(histM.filter(function (h) { return !h.done; }));
            var target = S.plan || {};
            var bySub = {}, order = [];
            Object.keys(target).forEach(function (k) { if (!bySub[k]) { bySub[k] = { done: 0, plan: 0 }; order.push(k); } });
            doneM.concat(planM).forEach(function (x) { var k = x.subject || "その他"; if (!bySub[k]) { bySub[k] = { done: 0, plan: 0 }; order.push(k); } });
            doneM.forEach(function (x) { bySub[x.subject || "その他"].done++; });
            planM.forEach(function (x) { bySub[x.subject || "その他"].plan++; });
            if (!order.length) return;
            var remainTotal = 0;
            html += '<div class="card" style="margin-top:12px;padding:10px 14px"><div class="small muted" style="margin-bottom:2px">' + (+ym.slice(5)) + '月の授業</div><div class="row" style="gap:8px 18px">';
            order.forEach(function (k) {
              var b = bySub[k], goal = target[k] || 0, have = b.done + b.plan;
              if (goal) remainTotal += Math.max(0, goal - have);
              html += '<span><strong>' + esc(k) + '</strong> <span style="font-variant-numeric:tabular-nums">' + have + (goal ? '<span class="muted">/' + goal + '</span>' : "") + '回</span><span class="small muted">(実施 ' + b.done + '・予定 ' + b.plan + ')</span></span>';
            });
            var stTag = S.planStatus === "approved" ? '<span class="tag green">保護者承認済み</span>' : S.planStatus === "proposed" ? '<span class="tag amber">保護者の承認待ち</span>' : "";
            html += '</div>' + (stTag ? '<div class="small" style="margin-top:4px">今月の回数: ' + stTag + (S.planStatus === "proposed" ? ' <span class="muted">保護者の方は「保護者」タブからご確認ください</span>' : '') + '</div>' : '') + (remainTotal ? '<div class="small" style="color:var(--primary);margin-top:4px">あと ' + remainTotal + ' 回、日程調整が必要です。<a href="#schedule">「予定」ページ</a>から希望日を送れます。</div>' : "") + '</div>';
          })();

          // テストまでのカウントダウン + やること(宿題・持ち物)
          (function () {
            var tests = events.filter(function (e) { return e.kind === "test" && e.dateTo >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
            var tasks = (S.tasks || []).filter(function (t) { return !t.withdrawnAt && !t.withdrawn; });
            var open = tasks.filter(function (t) { return !t.done; });
            var doneT = tasks.filter(function (t) { return t.done; });
            var nextL = mine.filter(function (s) { return s.date >= today; })[0];
            html += '<h2>やること' + (open.length ? ' <span class="cnt">' + open.length + '件</span>' : '') + '</h2>';
            if (tests.length || nextL) {
              html += '<div class="countdown" style="margin-bottom:10px">';
              tests.slice(0, 2).forEach(function (e) {
                var days = Math.round((new Date(e.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5);
                html += '<div class="cd"><div class="small muted">' + esc(e.title) + ' <span class="muted">' + fmtDateW(e.date) + '</span></div><div class="n" style="color:#7a4fc9">' + (days === 0 ? "今日" : days + '<small>日後</small>') + '</div></div>';
              });
              if (!tests.length) html += '<div class="cd"><div class="small muted">次のテスト・模試</div><div class="small" style="margin-top:4px">未登録。「予定」ページの「予定を共有」で「テスト・模試」にチェックを入れて登録すると、ここに日数が出ます。</div></div>';
              html += '</div>';
            }
            html += '<div class="card">';
            if (!open.length) html += '<div class="empty">いま登録されている宿題・持ち物はありません</div>';
            open.forEach(function (t) {
              var over = t.due && t.due < today;
              html += '<label class="task"><input type="checkbox" data-action="taskdone" data-id="' + esc(t.id) + '"><span class="tt"><span class="tag ' + (t.type === "持ち物" ? "coral" : t.type === "メモ" ? "gray" : "blue") + '">' + esc(t.type) + '</span> ' + esc(t.title) + ' <span class="due' + (over ? " over" : "") + '">' + esc(taskDueText(t)) + (over ? '(期限切れ)' : '') + '</span>' + (t.createdBy === "teacher" ? ' <span class="small muted">先生から</span>' : '') + '</span>' + (t.createdBy === "student" ? '<button class="btn-quiet btn-sm" data-action="taskdel" data-id="' + esc(t.id) + '">削除</button>' : '') + '</label>';
            });
            html += renderTaskAdd();
            if (doneT.length) html += '<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">済んだもの ' + doneT.length + '件</summary>' + doneT.slice(0, 20).map(function (t) { return '<label class="task done"><input type="checkbox" checked data-action="taskdone" data-id="' + esc(t.id) + '"><span class="tt">' + esc(t.title) + ' <span class="due">' + esc(taskDueText(t)) + '・' + esc(t.doneAt) + ' に完了</span></span></label>'; }).join("") + '</details>';
            html += '</div>';
          })();

          // 予定表(見るだけ。先生の休みは表示しない)
          html += '<h2>予定表 <a href="#schedule" class="small" style="font-weight:500;margin-left:6px">希望・共有・授業できない日の登録 →</a></h2>';
          html += renderCal(D.info, today, false);
          html += renderDayDetail(D, false, false);

          html += renderNextLesson(D);
          html += renderOffers(D);
          html += renderUpcoming(D, true);

          html += '<div class="note" style="margin-top:18px">授業の希望・予定の共有・授業できない日は「予定」、実施済みの授業は「授業の記録」、テストの結果は「成績」、授業料などは「保護者」タブにあります。</div>';
          html += '<footer class="app"><span>ページを開くと最新の状態になります</span><span></span></footer>';
          html += renderPendingBar(D);
          return html;
        }

        /* ---------- 予定: 予定表(先生の休みも表示)・予定管理・授業登録・今後の予定 ---------- */
        function renderSchedulePage() {
          var D = schedData(), today = D.today;
          var html = previewBanner(true);
          html += '<h1>予定</h1><p class="sub">授業の希望・予定の共有・授業できない日の登録</p>';

          var hintMap = { ng: "授業できない日をタップして選んでください(複数可)", wish: "希望する日をタップ(複数可)。時間は画面下で", event: "予定の日をタップ(複数可)。内容は画面下で" };
          html += '<h2>予定表' + (selMode ? ' <span style="font-size:12.5px;color:var(--' + (selMode === "ng" ? "danger" : selMode === "wish" ? "green" : "coral") + ');font-weight:600">' + hintMap[selMode] + '</span>' : "") + '</h2>';
          html += renderCal(D.info, today, true);
          if (!selMode) html += renderDayDetail(D, true, true);

          // 予定管理(予定表の直下)
          html += '<h2>予定管理</h2><div class="actions">';
          html += '<button data-action="panel" data-p="wish" class="' + (panel === "wish" ? "on" : "") + '"><span class="ico">🗓</span>授業の希望</button>';
          html += '<button data-action="panel" data-p="event" class="' + (panel === "event" ? "on" : "") + '"><span class="ico">📌</span>予定を共有</button>';
          html += '<button data-action="panel" data-p="ng" class="' + (panel === "ng" ? "on" : "") + '"><span class="ico">✕</span>授業できない日</button>';
          html += '</div><div class="note">ボタンを押して、上の予定表で日付をタップ。選んだら画面下の内容を確認して送ります。</div>';
          if (panel === "wish") html += renderWishPanel(today);
          if (panel === "event") html += renderEventPanel(today, D.events);
          if (panel === "ng") html += renderNgPanel(today, D.blocked);

          html += renderOffers(D);
          html += renderUpcoming(D, false);

          html += '<footer class="app"><span>ページを開くと最新の状態になります</span><span></span></footer>';
          html += selMode ? renderSelBar(D) : renderPendingBar(D);
          return html;
        }

        function cancelControl(s) {
          if (s.req) return '<button class="btn-quiet btn-sm" data-action="askwithdraw" data-id="' + esc(s.id) + '">依頼を取り下げる</button>';
          if (typeof s.hours === "number" && s.hours < (S.cancelDeadlineH || 24)) return '<button class="btn-quiet btn-sm" data-action="askcancel" data-id="' + esc(s.id) + '">例外取消を申請</button>';
          return '<button class="btn-quiet btn-sm" data-action="askcancel" data-id="' + esc(s.id) + '">取消を依頼</button>';
        }

        function renderWishPanel(today) {
          var wishes = S.wishes || [];
          var h = '<div class="panel card">';
          h += '<div class="row" style="margin-bottom:8px"><button class="btn-primary btn-sm" data-action="selstart" data-m="wish">予定表で日を選ぶ</button><span class="small muted">授業をしてほしい日をタップ。時間は画面下で入力します。</span></div>';
          h += '<details><summary style="cursor:pointer;color:var(--primary);font-size:13.5px">日付を入力して送る</summary><div style="margin-top:8px">';
          h += '<div class="row" style="margin-bottom:8px"><span class="seg"><button data-action="wkind" data-k="want" class="' + (wishKind === "want" ? "on" : "") + '">この日時に授業をしたい</button><button data-action="wkind" data-k="ok" class="' + (wishKind === "ok" ? "on" : "") + '">この時間帯のどこかで</button></span></div>';
          h += wishModeField('f');
          if (wishKind === "want") {
            h += '<div class="row"><input type="date" id="f-wdate" min="' + today + '"><input type="time" id="f-wstart" value="17:00" step="900"><select id="f-wmin"><option value="60">60分</option><option value="90" selected>90分</option><option value="120">120分</option></select><input type="text" id="f-wnote" placeholder="メモ(任意。例: 英語を希望)" maxlength="100" style="flex:1;min-width:140px"><button class="btn-primary btn-sm" data-action="addwish"' + (busy ? " disabled" : "") + '>空き状況を確認</button></div>';
            h += '<div class="note">「この日のこの時間に授業をしたい」という希望です。先生が案内を送ります。保護者が月の回数と料金を承認した範囲内で、日程を承認すると確定します。</div>';
          } else {
            h += '<div class="row"><input type="date" id="f-wdate" min="' + today + '"><input type="time" id="f-wstart" value="13:00" step="900"><span class="muted">〜</span><input type="time" id="f-wend" value="18:00" step="900"><label>授業の長さ<select id="f-wmin"><option value="30">30分</option><option value="45">45分</option><option value="60">60分</option><option value="90" selected>90分</option><option value="120">120分</option></select></label><input type="text" id="f-wnote" placeholder="メモ(任意。例: 英語を希望)" maxlength="100" style="flex:1;min-width:140px"><button class="btn-primary btn-sm" data-action="addwish"' + (busy ? " disabled" : "") + '>空き状況を確認</button></div>';
            h += '<div class="note">「この時間帯なら授業ができる」という空き時間です。先生がこの中から授業の時間を決めて案内します(時間帯すべてが授業になるわけではありません)。</div>';
          }
          h += '</div></details>';
          if (wishes.length) {
            h += '<div style="margin-top:10px">';
            wishes.forEach(function (wv) {
              var isWant = wv.kind === "want";
              h += '<div class="slotline"><span class="time">' + fmtDateW(wv.date) + " " + wv.start + "〜" + wv.end + '</span><span class="who"><span class="tag ' + (isWant ? "blue" : "green") + '">' + (isWant ? "この日時を希望" : "この時間帯のどこかで") + '</span> ' + (wv.note ? esc(wv.note) : "") + ' '+(wv.availability ? '送信時：'+wishStatusLabel(wv.availability).replace('現在は','') : '')+' <span class="small muted">先生の返事待ち</span></span><button class="btn-quiet btn-sm" data-action="delwish" data-id="' + esc(wv.id) + '">取消</button></div>';
            });
            h += '</div>';
          }
          return h + '</div>';
        }

        function renderEventPanel(today, events) {
          var h = '<div class="panel card">';
          h += '<div class="row" style="margin-bottom:8px"><button class="btn-primary btn-sm" data-action="selstart" data-m="event">予定表で日を選ぶ</button><span class="small muted">大会・見学・テスト期間など。連続する日は1つの予定になります。</span></div>';
          h += '<details><summary style="cursor:pointer;color:var(--primary);font-size:13.5px">日付を入力して送る</summary><div style="margin-top:8px">';
          h += '<div class="row"><input type="date" id="f-edate" min="' + today + '"><span class="muted">〜</span><input type="date" id="f-edate2" min="' + today + '"><input type="text" id="f-etitle" placeholder="内容(例: 大会、高校見学、修学旅行)" maxlength="40" style="flex:1;min-width:160px"></div>';
          h += '<div class="row" style="margin-top:8px"><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="f-etest"> テスト・模試</label><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="f-eblock"> この期間は授業できない日にもする</label><button class="btn-primary btn-sm" data-action="addevent"' + (busy ? " disabled" : "") + '>先生に共有</button></div></div></details>';
          var up = events.filter(function (e) { return e.dateTo >= today; });
          if (up.length) {
            h += '<div style="margin-top:10px">';
            up.forEach(function (e) { h += '<div class="slotline"><span class="time">' + (e.date === e.dateTo ? fmtDateW(e.date) : fmtDateW(e.date) + "〜" + fmtDateW(e.dateTo)) + '</span><span class="who">' + (e.kind === "test" ? '<span class="tag" style="background:#f1ecfb;color:#7a4fc9">テスト</span> ' : '') + esc(e.title) + '</span><button class="btn-quiet btn-sm" data-action="delevent" data-id="' + esc(e.id) + '">取消</button></div>'; });
            h += '</div>';
          }
          return h + '</div>';
        }

        function renderNgPanel(today, blocked) {
          var h = '<div class="panel card">';
          h += '<div class="row"><button class="btn-primary btn-sm" data-action="selstart" data-m="ng">予定表で日を選ぶ</button><span class="small muted">授業ができない日を先生に伝えます。その日には案内が来なくなります。</span></div>';
          h += '<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--primary);font-size:13.5px">期間でまとめて登録する(旅行など連日のとき)</summary>';
          h += '<div class="row" style="margin-top:8px"><input type="date" id="f-bdate" min="' + today + '"><span class="muted">〜</span><input type="date" id="f-bdate2" min="' + today + '"><input type="text" id="f-bnote" placeholder="メモ(任意。例: 修学旅行)" maxlength="50" style="flex:1;min-width:140px"></div>';
          h += '<div class="row" style="margin-top:6px"><span class="small muted">時間帯(任意。空欄なら終日)</span><input type="time" id="f-bstart" step="900"><span class="muted">〜</span><input type="time" id="f-bend" step="900"><button class="btn-ghost btn-sm" data-action="addblock"' + (busy ? " disabled" : "") + '>登録</button></div></details>';
          if (blocked.length) {
            h += '<div style="margin-top:10px">';
            ngRows(blocked).forEach(function (g) { h += '<div class="slotline"><span class="time">' + g.label + '</span><span class="who">' + (g.note ? esc(g.note) : "") + '</span><button class="btn-quiet btn-sm" data-action="delblock" data-ids="' + esc(g.ids.join(",")) + '">解除</button></div>'; });
            h += '</div>';
          }
          return h + '</div>';
        }

        /* ---------- 画面: 成績 / 授業の記録 ---------- */
        function renderGradesPage() {
          var h = '<h1>' + esc(S.me.name) + 'さんの成績</h1><p class="sub">先生が記録したテストの結果</p>';
          if (G === null) {
            if (!gLoading) {
              gLoading = true;
              apiPost({ action: "grades", k: myKey() }).then(function (res) { gLoading = false; G = res.grades || []; GX = res.exams || []; if (res.error) toast(res.error); render(); })
                .catch(function () { gLoading = false; G = []; toast("通信に失敗しました"); render(); });
            }
            return h + '<div class="loading"><div class="spinner"></div>読み込んでいます…</div>';
          }
          var grades = G;
          if (GX.length) {
            h += '<h2>模試 <span class="cnt">' + GX.length + '件</span><span class="seg" style="margin-left:auto"><button data-action="exmode" data-m="dev" class="' + (examMode === "dev" ? "on" : "") + '">偏差値</button><button data-action="exmode" data-m="score" class="' + (examMode === "score" ? "on" : "") + '">点数</button></span></h2>';
            h += '<div class="card">' + gradeChart(examPoints(GX, examMode), examMode) + examTable(GX, false) + '</div>';
          }
          h += '<h2>成績推移 <span class="cnt">' + grades.length + '件</span>' + (grades.some(function (g) { return g.dev !== null; }) ? '<span class="seg" style="margin-left:auto"><button data-action="gmode" data-m="score" class="' + (gradeMode === "score" ? "on" : "") + '">点数</button><button data-action="gmode" data-m="dev" class="' + (gradeMode === "dev" ? "on" : "") + '">偏差値</button></span>' : "") + '</h2>';
          h += '<div class="card">' + gradeChart(grades, gradeMode);
          if (grades.length) {
            h += '<div class="tbwrap" style="margin-top:10px"><table class="tb"><tr><th>日付</th><th>テスト</th><th>科目</th><th>点数</th><th>偏差値</th><th>順位</th></tr>';
            grades.slice().reverse().forEach(function (g) { h += '<tr><td>' + fmtDY(g.date) + '</td><td>' + esc(g.test) + '</td><td>' + esc(g.subject) + '</td><td>' + g.score + (g.max ? '<span class="muted">/' + g.max + '</span>' : "") + '</td><td>' + (g.dev === null ? "—" : g.dev) + '</td><td>' + esc(g.rank || "—") + '</td></tr>'; });
            h += '</table></div>';
          } else h += '<div class="empty" style="margin-top:8px">まだ記録がありません。テストの結果を先生に伝えると、ここに積み上がっていきます。</div>';
          h += '</div>';
          return h;
        }

        function renderHistoryPage() {
          var h = '<h1>' + esc(S.me.name) + 'さんの授業の記録</h1><p class="sub">実施済みの授業(直近120日)</p>';
          h += renderPublishedRecords(S.lessonRecords,true);
          var done = (S.history || []).filter(function (x) { return x.done; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
          var bySub = {}, order = [];
          done.forEach(function (x) { var k = x.subject || "その他"; if (!bySub[k]) { bySub[k] = 0; order.push(k); } bySub[k]++; });
          if (done.length) h += '<div class="card" style="margin-top:12px;padding:10px 14px"><div class="row" style="gap:8px 18px"><span><strong>合計</strong> ' + done.length + '回</span>' + order.map(function (k) { return '<span>' + esc(k) + ' ' + bySub[k] + '回</span>'; }).join("") + '</div></div>';
          h += '<h2>月ごと</h2>';
          if (!done.length) return h + '<div class="empty">実施済みの授業はまだありません</div>';
          var months = {}, mk = [];
          done.forEach(function (x) { var m = x.date.slice(0, 7); if (!months[m]) { months[m] = []; mk.push(m); } months[m].push(x); });
          h += '<div class="card">';
          mk.forEach(function (m, i) {
            var list = months[m], mins = 0; list.forEach(function (x) { mins += Number(x.min) || 0; });
            h += '<details class="month"' + (i === 0 ? " open" : "") + '><summary>' + (+m.slice(0, 4)) + "年" + (+m.slice(5, 7)) + "月 <span class=\"small muted\">" + list.length + "回・" + mins + "分</span></summary>";
            list.forEach(function (x) { h += '<div class="slotline"><span class="time">' + fmtDateW(x.date) + " " + x.start + '</span><span class="who">' + (x.subject ? esc(x.subject) : '<span class="muted">科目なし</span>') + ' <span class="small muted">' + x.min + '分</span></span></div>'; });
            h += '</details>';
          });
          return h + '</div>';
        }

        /* ---------- 画面: 保護者ページ ---------- */
        function renderParentPage() {
          if (ssGet(parentSessionKey() + ":logout")) { P = null; parentStep = "logout"; }
          if (parentStep === "data" && P) return renderParent();
          var h = '<h1>保護者ページ</h1><p class="sub">' + esc(S.me.name) + 'さんの授業料とお支払い状況</p>';
          h += '<p><a href="/hogosha/">メールでログインする家族の保護者ページはこちら</a></p>';
          var dis = busy ? " disabled" : "";
          h += '<div class="card parent-auth">';
          if (parentNotice) h += '<p class="parent-error" role="alert">' + esc(parentNotice) + '</p>';
          if (parentStep === "logout") {
            return h + '<p>ログアウトを完了するには、サーバーでの確認が必要です。</p><button class="btn-primary" data-action="parentclose"' + dis + '>' + (busy ? "ログアウト中…" : "ログアウトを再試行") + '</button></div>';
          }
          if (ssGet(parentSessionKey())) {
            return h + '<p>前回のログインを確認して、保護者ページを開きます。</p><div class="row"><button class="btn-primary" data-action="parentresume"' + dis + '>' + (busy ? "確認中…" : "保護者ページを開く") + '</button><button class="btn-quiet" data-action="parentclose"' + dis + '>ログアウト</button></div></div>';
          }
          var setup = parentStep === "setup";
          h += '<strong>' + (setup ? "保護者用パスワードの設定・再設定" : "保護者ログイン") + '</strong>';
          h += '<p class="small muted" id="parent-auth-help">' + (setup ? "先生から受け取った6桁の設定コードを入力し、ご自身で保護者用パスワードを決めてください。コードの有効期限は発行から24時間です。" : "保護者ご自身が設定したパスワードでログインしてください。初めての方・パスワードを忘れた方は、先生に設定コードの発行をご依頼ください。") + '</p>';
          h += '<form id="parent-auth-form" aria-describedby="parent-auth-help">';
          if (setup) h += '<label for="f-pcode">先生から受け取った設定コード</label><input type="text" id="f-pcode" inputmode="numeric" pattern="[0-9０-９]{6}" maxlength="6" autocomplete="one-time-code" placeholder="6桁の数字" required' + dis + '>';
          h += '<label for="f-ppass">' + (setup ? "新しい保護者用パスワード" : "保護者用パスワード") + '</label><input type="password" id="f-ppass" autocomplete="' + (setup ? "new-password" : "current-password") + '" maxlength="128"' + (setup ? ' minlength="12" aria-describedby="parent-pass-help"' : '') + ' required' + dis + '>';
          if (setup) h += '<div class="small muted" id="parent-pass-help">12〜128文字で設定してください。長い言葉を組み合わせても構いません。</div><label for="f-ppass2">新しい保護者用パスワード（確認）</label><input type="password" id="f-ppass2" autocomplete="new-password" minlength="12" maxlength="128" required' + dis + '>';
          h += '<div class="row"><button type="submit" class="btn-primary"' + dis + '>' + (busy ? "確認中…" : setup ? "パスワードを設定して開く" : "ログイン") + '</button><button type="button" class="btn-quiet btn-sm" data-action="parentmode"' + dis + '>' + (setup ? "ログインに戻る" : "初めて・パスワードを忘れた方") + '</button></div></form></div>';
          return h + '<p class="note">パスワードは保護者ご自身で管理してください。共用の端末では、ご利用後にログアウトしてください。</p>';
        }

        var EXAM_SUBJ = ["国語", "数学", "社会", "理科", "英語"];
        function examPoints(exams, mode) {
          var pts = [];
          exams.forEach(function (e) {
            var label = (e.name || "") + (e.round ? " " + e.round : "");
            EXAM_SUBJ.forEach(function (k) { var v = e.subjects && e.subjects[k]; if (!v) return; if (mode === "dev" ? v.dev !== null : v.score !== null) pts.push({ date: e.date, test: label, subject: k, score: v.score === null ? NaN : v.score, dev: v.dev, max: 100 }); });
            if (mode === "dev" && e.total5 && e.total5.dev !== null) pts.push({ date: e.date, test: label, subject: "5教科", score: NaN, dev: e.total5.dev, max: null });
          });
          return pts;
        }
        function judgeCls(j) { return /安全圏/.test(j) ? "blue" : /合格圏/.test(j) ? "green" : /努力圏/.test(j) ? "amber" : "gray"; }
        function examTable(exams, admin) {
          if (!exams.length) return '<div class="empty" style="margin-top:8px">まだ模試の記録がありません</div>';
          var cell = function (v) { if (!v || (v.score === null && v.dev === null)) return "<td>—</td>"; return "<td>" + (v.score === null ? "" : "<b>" + v.score + "</b>") + (v.dev === null ? "" : '<div class="small muted">' + v.dev + "</div>") + "</td>"; };
          var cols = 1 + EXAM_SUBJ.length + 3 + (admin ? 1 : 0);
          var h = '<div class="tbwrap" style="margin-top:10px"><table class="tb extb"><tr><th>模試</th>' + EXAM_SUBJ.map(function (k) { return '<th title="' + k + '">' + k.charAt(0) + "</th>"; }).join("") + '<th>3教科</th><th>5教科</th><th>順位(5教科)</th>' + (admin ? "<th></th>" : "") + '</tr>';
          exams.slice().reverse().forEach(function (e) {
            var rk = function (rs) { var p = String(rs).split("/"); return "<b>" + esc(p[0]) + "</b>" + (p[1] ? '<div class="small muted">/ ' + esc(p[1]) + "</div>" : ""); };
            h += '<tr><td class="nw"><b>' + esc(e.name) + '</b>' + (e.round ? " " + esc(e.round) : "") + '<div class="small muted">' + fmtDY(e.date) + (e.grade ? "・" + esc(e.grade) : "") + '</div></td>' + EXAM_SUBJ.map(function (k) { return cell(e.subjects && e.subjects[k]); }).join("") + cell(e.total3) + cell(e.total5);
            h += '<td class="nw">' + (e.rank5 ? rk(e.rank5) : "—") + (e.rank3 ? '<div class="small muted">3教科 ' + esc(String(e.rank3).split("/")[0]) + '</div>' : "") + '</td>';
            if (admin) h += '<td class="nw">' + (e.url ? '<a class="btn-ghost btn-sm" target="_blank" rel="noopener" href="' + esc(e.url) + '">成績票</a> ' : "") + (e.row ? '<button class="btn-quiet btn-sm" data-action="delrow" data-sheet="模試" data-row="' + e.row + '">削除</button>' : '<span class="small muted">保存中</span>') + '</td>';
            h += '</tr>';
            if ((e.judge && e.judge.length) || e.note) h += '<tr class="exsub"><td colspan="' + cols + '">' + (e.judge || []).map(function (j) { return '<span class="tag ' + judgeCls(j) + '">' + esc(j) + '</span> '; }).join("") + (e.note ? '<span class="small muted">' + esc(e.note) + '</span>' : "") + '</td></tr>';
          });
          return h + '</table></div><div class="small muted" style="margin-top:6px">上段: 点数、下段: 偏差値。志望校判定はその回の成績票のもの。</div>';
        }
        function colorFor(subject, idx) { return SUBJECT_COLOR[subject] || ["#6b7280", "#4b5563"][idx % 2]; }
        function gradeChart(grades, mode) {
          var pts = grades.filter(function (g) { return mode === "dev" ? (g.dev !== null && !isNaN(g.dev)) : !isNaN(g.score); });
          if (pts.length < 2) return '<div class="empty">記録が2件以上たまるとグラフが表示されます</div>';
          var dates = []; pts.forEach(function (g) { if (dates.indexOf(g.date) < 0) dates.push(g.date); }); dates.sort();
          var subjects = []; pts.forEach(function (g) { var s = g.subject || "その他"; if (subjects.indexOf(s) < 0) subjects.push(s); });
          var W = 640, H = 260, L = 44, R = 90, T = 16, B = 40, iw = W - L - R, ih = H - T - B;
          var vals = pts.map(function (g) { return mode === "dev" ? g.dev : g.score; });
          var ymax = Math.max.apply(null, vals.concat(mode === "dev" ? [70] : pts.map(function (g) { return g.max || 100; })));
          var ymin = mode === "dev" ? Math.min(30, Math.min.apply(null, vals)) : 0;
          ymax = Math.ceil(ymax / 10) * 10; ymin = Math.floor(ymin / 10) * 10;
          var xOf = function (d) { var i = dates.indexOf(d); return dates.length === 1 ? L + iw / 2 : L + i * iw / (dates.length - 1); };
          var yOf = function (v) { return T + ih - (v - ymin) / (ymax - ymin || 1) * ih; };
          var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="成績推移">';
          for (var i = 0; i <= 4; i++) { var v = ymin + (ymax - ymin) * i / 4, y = yOf(v); svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#e5e9ee"/><text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#64717f">' + Math.round(v) + '</text>'; }
          var every = Math.ceil(dates.length / 6);
          dates.forEach(function (d, i) { if (i % every === 0 || i === dates.length - 1) svg += '<text x="' + xOf(d) + '" y="' + (H - 14) + '" text-anchor="middle" font-size="11" fill="#64717f">' + fmtDY(d).slice(5) + '</text>'; });
          var endLbls = [];
          subjects.forEach(function (sub, si) {
            var col = colorFor(sub, si), minePts = pts.filter(function (g) { return (g.subject || "その他") === sub; });
            svg += '<path d="' + minePts.map(function (g, i) { return (i ? "L" : "M") + xOf(g.date).toFixed(1) + " " + yOf(mode === "dev" ? g.dev : g.score).toFixed(1); }).join(" ") + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
            minePts.forEach(function (g) { var v = mode === "dev" ? g.dev : g.score; svg += '<circle cx="' + xOf(g.date) + '" cy="' + yOf(v) + '" r="4.5" fill="' + col + '" stroke="#fff" stroke-width="2"><title>' + esc(fmtDY(g.date) + " " + (g.test || "") + " " + sub + " " + v + (mode === "dev" ? "" : (g.max ? "/" + g.max : ""))) + '</title></circle>'; });
            var last = minePts[minePts.length - 1];
            endLbls.push({ x: xOf(last.date) + 8, y: yOf(mode === "dev" ? last.dev : last.score) + 4, text: esc(sub) + ' ' + (mode === "dev" ? last.dev : last.score) });
          });
          // 右端ラベルは上下に13px以上あけて重ならないように並べる
          endLbls.sort(function (a, b) { return a.y - b.y; });
          for (var li = 1; li < endLbls.length; li++) if (endLbls[li].y - endLbls[li - 1].y < 13) endLbls[li].y = endLbls[li - 1].y + 13;
          for (var lj = endLbls.length - 1; lj >= 0; lj--) { var lim = (lj === endLbls.length - 1) ? T + ih + 4 : endLbls[lj + 1].y - 13; if (endLbls[lj].y > lim) endLbls[lj].y = lim; }
          endLbls.forEach(function (l) { svg += '<text x="' + l.x + '" y="' + l.y.toFixed(1) + '" font-size="11.5" font-weight="700" fill="#19212a">' + l.text + '</text>'; });
          svg += '</svg>';
          if (subjects.length >= 2) svg += '<div class="legend">' + subjects.map(function (s, i) { return '<span><i style="background:' + colorFor(s, i) + '"></i>' + esc(s) + '</span>'; }).join("") + '</div>';
          return svg;
        }

        function renderParent(data, family) {
          var d = data || P, activeBusy = family ? F.busy : busy, memoKey = family ? F.studentId : myKey(), memos = family ? F.memos : parentPlanMemos;
          var html = '<div class="parentbar"><span style="flex:1"><strong>保護者ページ</strong> ' + esc(d.name) + 'さん</span><button class="btn-sm" data-action="' + (family ? 'fa-logout' : 'parentclose') + '"' + (activeBusy ? " disabled" : "") + '>ログアウト</button></div>';
          var tm = d.thisMonth || {}, bill = d.billing, section=parentSection();
          if (!family && parentPlanNotice) html += '<p class="parent-error" role="alert">' + esc(parentPlanNotice) + '</p>';
          html += '<p><button class="btn-sm" data-action="' + (family ? 'fa-refresh' : 'parentrefresh') + '"' + (activeBusy ? " disabled" : "") + '>最新の情報を確認</button></p>';
          if(section==='home'){
          html += '<h2>今月の授業 <span class="cnt">' + esc(d.month) + '</span></h2><div class="row" style="align-items:stretch">';
          html += '<div class="card" style="flex:1;min-width:150px"><div class="small muted">実施済み</div><div class="stat">' + (tm.count || 0) + '<small>回 / ' + (tm.minutes || 0) + '分</small></div></div>';
          html += '<div class="card" style="flex:1;min-width:150px"><div class="small muted">' + (bill && bill.mode === "recorded" ? "請求記録額" : tm.mode === "monthly" ? "月謝" : "授業料(時間換算)") + '</div><div class="stat">' + (bill && bill.provisional && !bill.invoice ? "料金の承認待ち" : yen(bill ? (bill.invoice ? bill.invoice.amount : bill.amount) : tm.fee)) + '</div><div class="small muted">' + (bill && bill.provisional && !bill.invoice ? "この月の条件を先生にご確認ください" : bill && bill.mode === "recorded" ? "過去の請求記録（当時の料金条件は未記録）" : tm.mode === "monthly" ? "月額固定" : "30分 " + yen(bill ? bill.rate30 : d.rate30) + " × 実施時間") + '</div></div></div>';
          html += '<p>予定・授業報告・請求・連絡は上のメニューから確認できます。</p>';
          }
          if(section==='home'||section==='schedule'){
          html += '<h2>今後の授業</h2><div class="card">' + ((d.upcoming || []).length ? d.upcoming.map(function (s) { return '<p>' + fmtDateW(s.date) + ' ' + esc(s.start) + '〜' + endTime(s.start, s.min) + ' ' + esc(s.subject || '') + deliveryTag(s) + ' <span class="tag ' + (s.status === 'booked' ? 'blue' : 'amber') + '">' + (s.status === 'booked' ? '確定' : '生徒の返事待ち') + '</span>' + (s.meetUrl ? ' <a href="' + esc(s.meetUrl) + '" target="_blank" rel="noopener">Meet</a>' : '') + '</p>'; }).join('') : '<p class="muted">今後の授業はまだありません。</p>') + '</div>';

          }
          if(section==='billing'){
          html += '<h2>お支払い状況</h2>';
          var pays = d.payments || [];
          if (!pays.length) html += '<div class="empty">請求・入金の記録はまだありません</div>';
          else {
            html += '<div class="card tbwrap"><table class="tb"><tr><th>月</th><th>金額</th><th>状態</th><th>入金日</th></tr>';
            pays.forEach(function (p) { html += '<tr><td>' + esc(p.ym) + '</td><td>' + yen(p.amount) + '</td><td>' + (p.status === "取消" ? '<span class="tag gray">取消済み</span>' : p.status === "入金済" ? '<span class="tag green">入金済</span>' : '<span class="tag red">未入金</span>') + '</td><td>' + (p.paidDate ? fmtDY(p.paidDate) : "—") + '</td></tr>'; });
            html += '</table></div>';
          }

          var pms = d.planMonths || [];
          html += '<h2>授業回数と料金の承認</h2>';
          if (!pms.length) html += '<div class="empty">承認をお願いする予定はいまありません</div>';
          else {
            html += '<div class="card">';
            pms.forEach(function (m) {
              html += '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="row between"><strong>' + (+m.ym.slice(0, 4)) + '年' + (+m.ym.slice(5)) + '月の授業回数</strong>' + (m.status === "approved" ? '<span class="tag green">承認済み ' + esc(m.approvedAt) + '</span>' : m.status === "declined" ? '<span class="tag red">見送り</span>' : '<span class="tag amber">ご確認ください</span>') + '</div>';
              html += '<div style="margin:4px 0">' + m.rows.map(function (x) { return esc(x.subject) + ' ' + x.count + '回'; }).join("、") + '<span class="small muted">(合計 ' + m.total + '回)</span></div>';
              html += '<p class="small">' + (m.termsKnown ? (m.monthly > 0 ? "月謝 " + yen(m.monthly) + "（旧条件・先生に再提案を依頼してください）" : "30分あたり " + yen(m.rate30) + "（実施時間で計算）") : "料金条件が未確認です。先生からの再提案をお待ちください。") + (m.revision != null ? "・第" + esc(m.revision) + "版" : "") + '</p>';
              if (m.status === "proposed" && m.termsKnown && m.revision != null) html += '<div class="row" style="margin-top:6px"><button class="btn-primary btn-sm" data-action="' + (family ? 'fa-planok' : 'planok') + '" data-ym="' + esc(m.ym) + '"' + (activeBusy ? " disabled" : "") + '>この回数と料金を承認する</button><input type="text" id="pl-memo-' + esc(m.ym) + '" value="' + esc(memos[memoKey + ":" + m.ym] || "") + '" data-parent-plan-memo="' + esc(m.ym) + '" aria-label="' + esc(m.ym) + 'の相談" placeholder="見送る場合の理由や相談(任意)" maxlength="100" style="flex:1;min-width:160px"><button class="btn-quiet btn-sm" data-action="' + (family ? 'fa-planng' : 'planng') + '" data-ym="' + esc(m.ym) + '"' + (activeBusy ? " disabled" : "") + '>見送る・相談する</button></div>';
              else if (m.status === "declined" && m.memo) html += '<div class="small muted">' + esc(m.memo) + '</div>';
              html += '</div>';
            });
            html += '<div class="note">承認いただいた月の回数と料金で授業を確定・実施・請求します。回数や料金を変更する場合は、あらためて承認をお願いします。請求済みの金額は履歴に残ります。</div></div>';
          }
          }
          if(section==='records') html += renderPublishedRecords(d.lessonRecords);


          var months = d.months || [];
          if (section==='records' && months.length) {
            html += '<h2>月ごとの授業</h2><div class="card tbwrap"><table class="tb"><tr><th>月</th><th>実施</th><th>時間</th></tr>';
            months.forEach(function (m) { html += '<tr><td>' + (+m.ym.slice(0, 4)) + '年' + (+m.ym.slice(5)) + '月</td><td>' + m.count + '回</td><td>' + m.minutes + '分</td></tr>'; });
            html += '</table></div>';
          }
          if(section==='contacts')html+='<p>予定の希望・質問・改善点を送れます。取消は理由を記入して申請してください。</p>';
          if(section==='grades')html+='<h2>成績の推移</h2>'+gradeChart(d.grades||[],'score');
          if(section==='settings')html+='<h2>保護者の設定</h2><p>共用端末では利用後にログアウトしてください。</p>';
          return html;
        }

        /* ---------- 家族の保護者認証: 専用リンク方式とは別のセッション ---------- */
        var F = { step: "login", email: "", home: null, data: null, studentId: "", busy: false, message: "", error: "", seq: 0, challenge: "", challengeKind: "", confirm: null, memos: Object.create(null) };
        function familyToken() { return ssGet("sw_ft_v1") || ""; }
        function familyClear() { ssDel("sw_ft_v1"); ssDel("sw_ft_v1:logout"); F.home = null; F.data = null; F.studentId = ""; F.confirm = null; F.memos = Object.create(null); F.step = "login"; }
        function familyRender() { if (route() === "family") render(); }
        function familyRequest(action, payload, success) {
          if (F.busy) return;
          var seq = ++F.seq, auth = payload.ftoken || ""; F.busy = true; F.error = ""; familyRender();
          apiPost(Object.assign({ action: action }, payload)).then(function (res) {
            if (seq !== F.seq || auth && auth !== familyToken()) return;
            F.busy = false;
            if (res.error) { if (res.familyAuthRequired) familyClear(); F.error = res.error; familyRender(); return; }
            success(res); familyRender();
          }).catch(function () { if (seq !== F.seq || auth && auth !== familyToken()) return; F.busy = false; F.error = "通信に失敗しました。通信状態を確認して再試行してください。"; familyRender(); });
        }
        function familyLoadChild(id) {
          if (F.busy || !F.home || !(F.home.children || []).some(function (c) { return sameId(c.studentId, id); })) return;
          F.studentId = id; F.data = null; F.confirm = null;
          familyRequest("familyData", { ftoken: familyToken(), studentId: id }, function (res) { if (sameId(F.studentId, id)) F.data = res.data; });
        }
        function familyLoadHome() {
          if (F.busy || !familyToken()) return;
          if (ssGet("sw_ft_v1:logout")) { F.step = "logout"; familyRender(); return; }
          F.data = null; F.confirm = null;
          familyRequest("familyHome", { ftoken: familyToken() }, function (res) { F.home = res; F.step = "home"; var list = res.children || []; if (list.length) familyLoadChild(list.some(function (c) { return sameId(c.studentId, F.studentId); }) ? F.studentId : list[0].studentId); else F.studentId = ""; });
        }
        function familyLogout() {
          if (F.busy) return;
          if (!familyToken()) { familyClear(); familyRender(); return; }
          F.home = null; F.data = null; F.confirm = null; F.step = "logout"; ssSet("sw_ft_v1:logout", "1");
          familyRequest("familyLogout", { ftoken: familyToken() }, function () { familyClear(); F.message = "ログアウトしました。"; });
        }
        function familyReadChallenge() {
          if (location.hash.indexOf("#family?") !== 0) return;
          var q = new URLSearchParams(location.hash.slice(8)), verify = q.get("verify"), reset = q.get("reset");
          F.challenge = verify || reset || ""; F.challengeKind = verify ? "verify" : reset ? "reset" : "";
          if (F.challenge) { ++F.seq; F.busy = false; F.home = null; F.data = null; F.step = F.challengeKind; F.message = ""; F.error = ""; }
          history.replaceState(null, "", location.pathname + "#family");
        }
        function familyMailMessage(res) { return res.mailStatus === "suppressed" ? "テストのため確認メールの送信を省略しました。" : res.mailStatus === "failed" ? "登録は保存しましたが確認メールを送れませんでした。「確認メールを再送」からお試しください。メール変更の場合は現在のメールでログインして変更をやり直せます。" : res.mailStatus === "uncertain" ? "確認メールの送信結果が不明です。まず受信箱と迷惑メールをご確認ください。届かない場合は少し待って再送してください。" : res.message || "確認メールの手続きを受け付けました。メール内のリンクを開いてからログインしてください。"; }
        function familySubmit() {
          if (F.busy || route() !== "family") return;
          var step = F.step, email = val("fa-email").toLowerCase(), passEl = document.getElementById("fa-pass"), pass2 = document.getElementById("fa-pass2"), inviteEl = document.getElementById("fa-invite");
          var pass = passEl ? passEl.value : "", confirmation = pass2 ? pass2.value : "";
          if (step !== "reset" && !email) { F.error = "メールアドレスを入力してください。"; familyRender(); return; }
          if (step !== "requestReset" && (!pass || (step === "register" || step === "reset") && (pass.length < 12 || pass.length > 128 || pass !== confirmation))) { F.error = "パスワードを確認してください。新しいパスワードは12〜128文字で、確認欄と同じ内容を入力してください。"; familyRender(); return; }
          var invite = inviteEl ? inviteEl.value.trim() : "";
          if (step === "register" && !invite) { F.error = "先生から受け取った招待コードを入力してください。"; familyRender(); return; }
          F.email = email || F.email;
          if (passEl) passEl.value = ""; if (pass2) pass2.value = ""; if (inviteEl) inviteEl.value = "";
          if (step === "register") familyRequest("familyRegister", { inviteCode: invite, email: email, pass: pass }, function (res) { F.step = "login"; F.message = familyMailMessage(res); });
          else if (step === "reset") { if (!F.challenge) { F.error = "メール内の再設定リンクを開いてください。"; familyRender(); return; } familyRequest("familyResetConfirm", { challenge: F.challenge, pass: pass }, function () { familyClear(); F.challenge = ""; F.challengeKind = ""; F.message = "パスワードを変更しました。メールアドレスでログインしてください。"; }); }
          else if (step === "requestReset") familyRequest("familyResetRequest", { email: email }, function (res) { F.message = res.message || "登録されている場合は、再設定のメールを送ります。"; });
          else if (step === "resend") familyRequest("familyResendVerification", { email: email, pass: pass }, function (res) { F.message = familyMailMessage(res); });
          else if (step === "emailChange") familyRequest("familyEmailChange", { ftoken: familyToken(), email: email, pass: pass }, function (res) { familyClear(); F.message = familyMailMessage(res); });
          else familyRequest("familyLogin", { email: email, pass: pass }, function (res) {
            if (!res.ftoken) { F.error = "ログインを確認できませんでした。"; return; }
            ssSet("sw_ft_v1", res.ftoken); ssDel("sw_ft_v1:logout");
            if (familyToken() !== res.ftoken) { apiPost({ action: "familyLogout", ftoken: res.ftoken }).catch(function () {}); F.error = "このブラウザではログインを保持できません。セッション保存を許可してお試しください。"; return; }
            F.home = res; F.step = "home"; F.message = ""; F.challenge = ""; var children = res.children || []; if (children.length) familyLoadChild(children[0].studentId);
          });
        }
        function renderFamily() {
          var dis = F.busy ? " disabled" : "", h = '<h1>保護者ページ</h1><p class="sub">メールアドレスでログインし、登録されたお子さまの情報を確認できます。</p>';
          if (F.error) h += '<p class="parent-error" role="alert">' + esc(F.error) + '</p>';
          if (F.message) h += '<p class="card" role="status">' + esc(F.message) + '</p>';
          if (F.step === "logout" || ssGet("sw_ft_v1:logout")) { app.innerHTML = h + '<div class="card"><p>ログアウトを完了するにはサーバーの確認が必要です。</p><button class="btn-primary" data-action="fa-logout"' + dis + '>ログアウトを再試行</button></div>'; return; }
          if (F.step === "verify") { app.innerHTML = h + '<div class="card"><p>メールアドレスを確認します。確認後は、ご自身で設定したパスワードでログインしてください。</p><button class="btn-primary" data-action="fa-verify"' + dis + '>メールアドレスを確認する</button><div class="row" style="margin-top:12px"><button class="btn-quiet" data-action="fa-mode" data-step="resend"' + dis + '>確認メールを再送</button><button class="btn-quiet" data-action="fa-mode" data-step="login"' + dis + '>ログインへ</button></div></div>'; return; }
          if (F.home && F.step === "home") {
            h += '<div class="card"><strong>' + esc((F.home.family || {}).label) + '</strong>' + (parentSection()==='settings'?'<p>'+esc((F.home.family || {}).email)+'・メール確認済み</p>':'') + '<label for="fa-child">表示する子ども</label><select id="fa-child"' + dis + '>' + (F.home.children || []).map(function (c) { return '<option value="' + esc(c.studentId) + '"' + (sameId(c.studentId, F.studentId) ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select>' + (parentSection()==='settings'?'<div class="row" style="margin-top:12px"><button class="btn-quiet btn-sm" data-action="fa-home"' + dis + '>家族情報を更新</button><button class="btn-quiet btn-sm" data-action="fa-mode" data-step="emailChange"' + dis + '>メールアドレスを変更</button><button class="btn-quiet btn-sm" data-action="fa-logout"' + dis + '>ログアウト</button></div>':'')+'</div>';
            if(parentSection()==='billing')h += window.StepwiseReport.invoices(F.home.billing,F.home.family.label);
            if (!(F.home.children || []).length) h += '<p>子どもの紐付けを先生にご依頼ください。</p>';
            if (F.confirm && parentSection() === "billing") h += '<div class="card" role="region" aria-label="月間計画の回答確認"><strong>' + esc((F.data || {}).name) + 'さん・' + esc(F.confirm.ym) + '</strong><p>第' + F.confirm.expectedRevision + '版の回数と料金を' + (F.confirm.approve ? '承認します。' : '見送り・相談として先生に伝えます。') + '</p><button class="btn-primary" data-action="fa-decide"' + dis + '>この内容で回答する</button> <button class="btn-quiet" data-action="fa-cancel"' + dis + '>やめる</button></div>';
            h += F.data ? renderParent(F.data, true) : F.busy ? '<p>読み込んでいます…</p>' : F.studentId ? '<button class="btn-quiet" data-action="fa-refresh">子どもの情報を再読み込み</button>' : '';
            app.innerHTML = h; return;
          }
          if (familyToken() && F.step === "login") { app.innerHTML = h + '<div class="card"><button class="btn-primary" data-action="fa-home"' + dis + '>家族ページを開く</button> <button class="btn-quiet" data-action="fa-logout"' + dis + '>ログアウト</button></div>'; return; }
          var step = F.step, newPass = step === "register" || step === "reset";
          var titles = { login: 'ログイン', register: '初めての登録', requestReset: 'パスワードを忘れた方', resend: '確認メールを再送', reset: '新しいパスワード', emailChange: 'メールアドレスを変更' };
          h += '<div class="card parent-auth"><h2>' + esc(titles[step] || titles.login) + '</h2><form id="family-auth-form">';
          if (step === "register") h += '<label for="fa-invite">先生から受け取った招待コード</label><input id="fa-invite" autocomplete="off" required' + dis + '>';
          if (step !== "reset") h += '<label for="fa-email">' + (step === "emailChange" ? '新しいメールアドレス' : 'メールアドレス') + '</label><input type="email" id="fa-email" autocomplete="email" value="' + esc(F.email) + '" required' + dis + '>';
          if (step !== "requestReset") h += '<label for="fa-pass">' + (newPass ? '新しい保護者用パスワード（12〜128文字）' : '保護者用パスワード') + '</label><input type="password" id="fa-pass" autocomplete="' + (newPass ? 'new-password' : 'current-password') + '" maxlength="128"' + (newPass ? ' minlength="12"' : '') + ' required' + dis + '>';
          if (newPass) h += '<label for="fa-pass2">新しいパスワード（確認）</label><input type="password" id="fa-pass2" autocomplete="new-password" minlength="12" maxlength="128" required' + dis + '>';
          if (step === 'register') h += '<p class="note">確認メール内のリンクでメールアドレスを確認するとログインできます。</p>';
          if (step === 'emailChange') h += '<p class="note">変更手続きでログアウトします。新しいメールの確認が完了するまで、登録先は現在のメールのままです。</p>';
          h += '<div class="row"><button type="submit" class="btn-primary"' + dis + '>' + (F.busy ? '確認中…' : step === 'login' ? 'ログイン' : step === 'reset' ? 'パスワードを変更する' : step === 'emailChange' ? '確認メールを送りログアウトする' : '送信する') + '</button></div></form><div class="row" style="margin-top:16px">' + (step === 'login' ? [['register', '初めての登録'], ['requestReset', 'パスワードを忘れた方'], ['resend', '確認メールを再送']] : [[F.home ? 'home' : 'login', F.home ? '家族ページに戻る' : 'ログインに戻る']]).map(function (x) { return '<button class="btn-quiet btn-sm" data-action="fa-mode" data-step="' + x[0] + '"' + dis + '>' + x[1] + '</button>'; }).join('') + '</div></div><p class="note">共用端末では、利用後にログアウトしてください。</p>';
          app.innerHTML = h;
        }
        function familyClick(action, btn) {
          if (F.busy || route() !== "family") return;
          if (action === "fa-home") familyLoadHome();
          else if (action === "fa-refresh") familyLoadChild(F.studentId);
          else if (action === "fa-logout") familyLogout();
          else if (action === "fa-mode") { F.step = btn.getAttribute("data-step"); F.error = ""; F.message = ""; F.confirm = null; if (F.step === 'emailChange') F.email = ''; familyRender(); }
          else if (action === "fa-verify" && F.challenge) familyRequest("familyVerify", { challenge: F.challenge }, function () { familyClear(); F.challenge = ""; F.challengeKind = ""; F.message = "メールアドレスを確認しました。ログインしてください。"; });
          else if (action === "fa-planok" || action === "fa-planng") {
            var ym = btn.getAttribute("data-ym"), m = (F.data && F.data.planMonths || []).filter(function (x) { return x.ym === ym; })[0];
            if (!m || m.status !== 'proposed' || !m.termsKnown || !Number.isSafeInteger(m.revision)) { F.error = '最新の提案を確認してください。'; familyRender(); return; }
            var memo = val('pl-memo-' + ym); F.memos[F.studentId + ':' + ym] = memo;
            F.confirm = { studentId: F.studentId, ym: ym, approve: action === "fa-planok", expectedRevision: m.revision, memo: memo }; familyRender();
          } else if (action === "fa-cancel") { F.confirm = null; familyRender(); }
          else if (action === "fa-decide" && F.confirm && sameId(F.confirm.studentId, F.studentId)) {
            var confirmation = F.confirm;
            familyRequest("familyPlanDecide", Object.assign({ ftoken: familyToken() }, confirmation), function (res) { F.confirm = null; F.data = res.data; delete F.memos[confirmation.studentId + ':' + confirmation.ym]; F.message = res.notificationWarning || (confirmation.approve ? '承認しました。' : '先生に相談を伝えました。'); });
          }
        }

        function render() {
          renderStudent(); if(wishReview && wishReview.key===myKey()) app.innerHTML=wishReviewHTML();
          if(!window.StepwiseServices)return;
          var page=route(),auth=null;
          if(!wishReview&&!previewK){
            if(page==='family'&&F.home&&F.step==='home'&&F.data&&F.studentId)auth={ftoken:familyToken(),studentId:F.studentId};
            else if(page==='parent'&&parentStep==='data'&&P)auth={k:myKey(),ptoken:ssGet(parentSessionKey(myKey()))};
            else if(['home','schedule','grades','history'].indexOf(page)>=0&&S&&S.me)auth={k:myKey()};
          }
          if(window.StepwiseLessonRead){
            if(auth&&(auth.ftoken||auth.ptoken))window.StepwiseLessonRead.mount(app,function(op,payload){return apiPost(Object.assign({},payload,auth,{action:'learningService',op:op}));},JSON.stringify(auth));
            else window.StepwiseLessonRead.clear();
          }
          if(!auth){window.StepwiseServices.clear();return;}
          var parentPanel=auth.ftoken||auth.ptoken;if(parentPanel&&['contacts','grades','schedule'].indexOf(parentSection())<0){return;}
          window.StepwiseServices.mount(app,{key:JSON.stringify(auth),teacher:false,panel:parentPanel?(parentSection()==='grades'?'exams':parentSection()==='schedule'?'cancel':'messages'):'all',call:function(op,payload){return apiPost(Object.assign({},payload,auth,{action:'learningService',op:op}));}});
        }

        function loadParent(ptoken) {
          var k = myKey();
          busy = true; parentNotice = ""; render();
          apiPost({ action: "parentData", k: k, ptoken: ptoken }).then(function (res) {
            if (k !== myKey()) return;
            busy = false;
            if (res.error) {
              if (res.parentAuthRequired || res.badCode) clearParentSession(k);
              parentNotice = res.error; render(); return;
            }
            P = res.data; parentStep = "data"; render(); window.scrollTo(0, 0);
          }).catch(function () { if (k !== myKey()) return; busy = false; parentNotice = "通信に失敗しました。もう一度お試しください。"; render(); });
        }

        function submitParentAuth() {
          if (busy) return;
          var setup = parentStep === "setup", passEl = document.getElementById("f-ppass"), confirmEl = document.getElementById("f-ppass2");
          var pass = passEl ? passEl.value : "", confirmPass = confirmEl ? confirmEl.value : "";
          var code = val("f-pcode").replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
          if (!pass) { toast("保護者用パスワードを入力してください"); return; }
          if (setup && !/^\d{6}$/.test(code)) { toast("先生から受け取った6桁の設定コードを入力してください"); return; }
          if (setup && (pass.length < 12 || pass.length > 128)) { toast("パスワードは12〜128文字で設定してください"); return; }
          if (setup && pass !== confirmPass) { toast("確認用のパスワードが一致しません"); return; }
          var k = myKey(), body = { action: setup ? "parentSetup" : "parentLogin", k: k, pass: pass };
          try { sessionStorage.setItem(parentSessionKey(k) + ":check", "1"); sessionStorage.removeItem(parentSessionKey(k) + ":check"); }
          catch (e) { parentNotice = "このブラウザでログインを一時保存できません。ブラウザの設定を確認して、もう一度お試しください。"; render(); return; }
          if (setup) body.setupCode = code;
          if (passEl) passEl.value = "";
          if (confirmEl) confirmEl.value = "";
          busy = true; parentNotice = ""; render();
          apiPost(body).then(function (res) {
            if (k !== myKey()) return;
            busy = false;
            if (res.error) { if (res.needSetup) parentStep = "setup"; parentNotice = res.error; render(); return; }
            if (!res.ptoken) { parentNotice = "ログインを確認できませんでした。もう一度お試しください。"; render(); return; }
            ssSet(parentSessionKey(k), res.ptoken); ssDel("sw_pt"); loadParent(res.ptoken);
          }).catch(function () { if (k !== myKey()) return; busy = false; parentNotice = "通信に失敗しました。もう一度お試しください。"; render(); });
        }

        function logoutParent() {
          if (busy) return;
          var k = myKey(), ptoken = ssGet(parentSessionKey(k));
          P = null; parentNotice = "";
          if (!ptoken) { clearParentSession(k); render(); return; }
          // 通信失敗時は再試行に必要なトークンを sessionStorage に残し、完了と表示しない。
          ssSet(parentSessionKey(k) + ":logout", "1"); parentStep = "logout"; busy = true; render();
          apiPost({ action: "parentLogout", k: k, ptoken: ptoken }).then(function (res) {
            if (res.ok || res.parentAuthRequired || res.badCode) clearParentSession(k);
            if (k !== myKey()) return;
            busy = false;
            if (!res.ok && !res.parentAuthRequired && !res.badCode) { parentNotice = "ログアウトが完了していません。" + (res.error || "サーバーの応答を確認できませんでした。") + " 再試行してください。"; render(); return; }
            parentNotice = ""; render(); toast("ログアウトしました"); window.scrollTo(0, 0);
          }).catch(function () { if (k !== myKey()) return; busy = false; parentNotice = "通信に失敗し、ログアウトが完了していません。通信状態を確認して再試行してください。"; render(); });
        }

        app.addEventListener("submit", function (ev) {
          if (ev.target && ev.target.id === 'student-email-form') { ev.preventDefault(); studentEmailSend('studentEmailRequest'); return; }
          if (ev.target && ev.target.id === "family-auth-form") { ev.preventDefault(); familySubmit(); return; }
          if (!ev.target || ev.target.id !== "parent-auth-form") return;
          ev.preventDefault(); submitParentAuth();
        });

        /* ---------- 操作 ---------- */
        app.addEventListener("click", function (ev) {
          var btn = ev.target.closest("[data-action]");
          if (!btn || btn.disabled) return;
          var act = btn.getAttribute("data-action"), id = btn.getAttribute("data-id");
          if (act.indexOf("fa-") === 0) { ev.preventDefault(); familyClick(act, btn); return; }
          if (act.indexOf('se-') === 0) { ev.preventDefault(); if (act === 'se-askremove') { SE.removeConfirm = true; render(); } else if (act === 'se-cancel') { SE.removeConfirm = false; render(); } else if (act === 'se-back') { ++SE.seq; SE.challenge = ''; SE.error = ''; SE.message = ''; render(); if (myKey() && !S) loadState().catch(function () { toast('元の生徒専用ページを開き直してください'); }); } else studentEmailSend({'se-verify':'studentEmailVerify','se-resend':'studentEmailResend','se-remove':'studentEmailRemove'}[act]); return; }
          switch (act) {
            case "batchall": if (!acceptBatch().pending) { acceptBatch().selected = Object.create(null); acceptBatch().review = null; schedData().offers.slice(0, 31).forEach(function (s) { acceptBatch().selected[s.id] = true; }); render(); } break;
            case "batchclear": if (!acceptBatch().pending) { acceptBatch().selected = Object.create(null); render(); } break;
            case "batchreview": batchReview(); break;
            case "batchcancel": if (!acceptBatch().pending) { acceptBatch().review = null; render(); } break;
            case "batchsend": batchSend(); break;
            case "batchrefresh": batchRefresh(myKey(), acceptBatch()); break;
            case "closebar": pending = null; render(); break;
            case "calprev": calM--; if (calM < 0) { calM = 11; calY--; } pending = null; render(); break;
            case "calnext": calM++; if (calM > 11) { calM = 0; calY++; } pending = null; render(); break;
            case "calday":
              if (selMode) { var nd = btn.getAttribute("data-date"); selDays[nd] = !selDays[nd]; render(); break; }
              selDate = btn.getAttribute("data-date"); selManual = true; pending = null; render(); break;
            case "panel":
              var p = btn.getAttribute("data-p");
              if (panel === p) { panel = ""; selMode = ""; selDays = {}; render(); break; }
              panel = p; selMode = p; selDays = {}; pending = null; render();
              var calEl0 = document.querySelector(".cal"); if (calEl0) calEl0.scrollIntoView({ behavior: "smooth", block: "start" });
              break;
            case "dayact":
              selMode = btn.getAttribute("data-m"); panel = selMode; selDays = {}; selDays[btn.getAttribute("data-date")] = true; pending = null; render();
              var calEl2 = document.querySelector(".cal"); if (calEl2) calEl2.scrollIntoView({ behavior: "smooth", block: "start" });
              break;
            case "selstart":
              selMode = btn.getAttribute("data-m"); selDays = {}; pending = null; render();
              var calEl1 = document.querySelector(".cal"); if (calEl1) calEl1.scrollIntoView({ behavior: "smooth", block: "start" });
              break;
            case "selcancel": selMode = ""; selDays = {}; render(); break;
            case "selapply":
              var chosen = Object.keys(selDays).filter(function (d) { return selDays[d]; }).sort();
              if (!chosen.length) { toast("日付をえらんでください"); return; }
              if (selMode === "ng") {
                var ngBy2 = {}; (S.blocked || []).forEach(function (b) { (ngBy2[b.date] = ngBy2[b.date] || []).push(b.id); });
                var addD2 = chosen.filter(function (d) { return !ngBy2[d]; }), remIds2 = [];
                chosen.forEach(function (d) { if (ngBy2[d]) remIds2 = remIds2.concat(ngBy2[d]); });
                var ngNote2 = val("b-ngnote"), ngSt = val("b-ngstart"), ngEn = val("b-ngend");
                if ((ngSt && !ngEn) || (!ngSt && ngEn)) { toast("時間帯は開始と終了の両方を入れてください(終日なら両方空欄)"); return; }
                if (ngSt && ngSt >= ngEn) { toast("時間帯は「開始 < 終了」で入れてください"); return; }
                selMode = ""; selDays = {};
                studentAction({ action: "blockSet", k: myKey(), add: addD2, removeIds: remIds2, note: ngNote2, start: ngSt, end: ngEn }, "登録しました");
              } else if (selMode === "wish") {
                var bws = val("b-wstart"), bwn = val("b-wnote");
                if (!bws) { toast("開始時刻を入れてください"); return; }
                var body = { action: "wishMany", k: myKey(), kind: wishKind, dates: chosen, start: bws, note: bwn };
                if (wishKind === "want") body.min = +(val("b-wmin") || 90);
                else { var bwe = val("b-wend"); if (!bwe || bws >= bwe) { toast("時間帯は「開始 < 終了」で入れてください"); return; } body.end = bwe; }
                body.deliveryMode=val('b-wmode');body.min=+(val('b-wmin') || 90);wishCheck(body);
              } else if (selMode === "event") {
                var bet = val("b-etitle"), beb = !!(document.getElementById("b-eblock") || {}).checked;
                if (!bet) { toast("予定の内容を入れてください"); return; }
                var ranges = groupDays(chosen);
                selMode = ""; selDays = {};
                var bkind = (document.getElementById("b-etest") || {}).checked ? "test" : "event";
                studentAction({ action: "eventAddMany", k: myKey(), ranges: ranges, title: bet, alsoBlock: beb, kind: bkind }, "先生に共有しました");
              }
              break;
            case "askaccept": pending = { kind: "accept", slotId: id }; render(); break;
            case "doaccept":
              var b = acceptBatch(); if (b.pending || b.busy || b.refreshRequired || busy || !pending) return;
              var selectedSlot = (S.slots || []).filter(function (s) { return sameId(s.id, pending.slotId) && s.st === 'offer'; })[0];
              if (!selectedSlot) { toast('最新の案内を確認してください'); return; }
              b.review = [Object.assign({}, selectedSlot)]; b.rows = b.review; b.results = []; pending = null; batchSend(); break;
            case "askdecline": pending = { kind: "decline", slotId: id }; render(); break;
            case "dodecline": studentAction({ action: "decline", slotId: pending.slotId, k: myKey() }, "再調整をお願いしました"); break;
            case "askcancel": pending = { kind: "cancel", slotId: id, requestId:crypto.randomUUID() }; render(); break;
            case "docancel":
              var reason = val("f-creason");
              if(!reason.trim()){toast('取消の理由を入力してください');return;}
              pending.reason=reason;
              studentAction({ action: "cancelReq", slotId: pending.slotId, requestId:pending.requestId, k: myKey(), reason: reason }, "取消未確定・先生の確認待ちです"); break;
            case "askwithdraw": pending = { kind: "withdraw", slotId: id }; render(); break;
            case "dowithdraw": studentAction({ action: "cancelReq", withdraw: true, slotId: pending.slotId, k: myKey() }, "依頼を取り下げました"); break;
            case 'wish-confirm': wishSend(); break;
            case 'wish-recheck': if(wishReview && !wishReview.busy)wishCheck(wishReview.body); break;
            case 'wish-back':
              if(wishReview && !wishReview.busy){var draft=wishReview.body;wishReview=null;render();wishRestore(draft);} break;
            case "wkind": wishKind = btn.getAttribute("data-k"); render(); break;
            case "addwish":
              var wd = val("f-wdate"), ws = val("f-wstart"), wn = val("f-wnote");
              if (!wd) { toast("日付をえらんでください"); return; }
              if (!ws) { toast("開始時刻を入れてください"); return; }
              if (wishKind === "want") wishCheck({ action: "wish", kind: "want", k: myKey(), date: wd, start: ws, min: +(val("f-wmin") || 90), deliveryMode:val('f-wmode'), note: wn });
              else { var we = val("f-wend"); if (!we || ws >= we) { toast("時間帯は「開始 < 終了」で入れてください"); return; } wishCheck({ action: "wish", kind: "ok", k: myKey(), date: wd, start: ws, end: we, min:+(val('f-wmin') || 90), deliveryMode:val('f-wmode'), note: wn }); }
              break;
            case "delwish": studentAction({ action: "unwish", k: myKey(), wishId: id }, "希望を取り消しました"); break;
            case "addevent":
              var ed = val("f-edate"), ed2 = val("f-edate2"), et = val("f-etitle"), eb = !!(document.getElementById("f-eblock") || {}).checked;
              if (!ed) { toast("日付をえらんでください"); return; }
              if (!et) { toast("予定の内容を入れてください"); return; }
              var fkind = (document.getElementById("f-etest") || {}).checked ? "test" : "event";
              studentAction({ action: "eventAdd", k: myKey(), date: ed, dateTo: ed2 || ed, title: et, alsoBlock: eb, kind: fkind }, "先生に共有しました"); break;
            case "delevent": studentAction({ action: "eventDel", k: myKey(), eventId: id }, "予定を取り消しました"); break;
            case "taskadd":
              var tt = val("f-ttitle"), ty = val("f-ttype"), dm = val("f-tdue-mode"), td = dm === 'date' ? val("f-tdue") : '', ds = dm === 'nextLesson' ? val("f-tdue-subject") : '', taskKey = myKey();
              if (!tt) { toast("内容を入れてください"); return; }
              if (['date','nextLesson','none'].indexOf(dm) < 0) { toast('期限の種類を選んでください'); return; }
              if (dm === 'date' && !td) { toast('期限の日付を入れてください'); return; }
              if (dm === 'nextLesson' && !ds) { toast('期限にする授業の科目を入れてください'); return; }
              studentAction({ action: "taskAdd", k: taskKey, type: ty, title: tt, due: td, dueMode: dm, dueSubject: ds }, "追加しました", function () { delete taskDrafts[taskKey]; }); break;
            case "taskdel": studentAction({ action: "taskDel", k: myKey(), taskId: id }, "削除しました"); break;
            case "addblock":
              var bd = val("f-bdate"), bdto = val("f-bdate2"), bn = val("f-bnote"), bst = val("f-bstart"), ben = val("f-bend");
              if (!bd) { toast("日付をえらんでください"); return; }
              if ((bst && !ben) || (!bst && ben)) { toast("時間帯は開始と終了の両方を入れてください(終日なら両方空欄)"); return; }
              if (bst && bst >= ben) { toast("時間帯は「開始 < 終了」で入れてください"); return; }
              studentAction({ action: "block", k: myKey(), date: bd, dateTo: bdto || bd, note: bn, start: bst, end: ben }, "登録しました"); break;
            case "delblock":
              var sids = btn.getAttribute("data-ids");
              studentAction({ action: "unblock", k: myKey(), blockIds: sids ? sids.split(",") : [id] }, "解除しました"); break;
            case "parentmode": if (busy) return; parentStep = parentStep === "setup" ? "pass" : "setup"; parentNotice = ""; render(); break;
            case "parentresume": if (busy) return; loadParent(ssGet(parentSessionKey()) || ""); break;
            case "parentclose": parentPlanMemos = Object.create(null); parentPlanNotice = ""; logoutParent(); break;
            case "parentrefresh": parentPlanNotice = ""; loadParent(ssGet(parentSessionKey()) || ""); break;
            case "planok":
            case "planng":
              if (busy) return;
              var pym = btn.getAttribute("data-ym"), approve = act === "planok", pmemo = val("pl-memo-" + pym);
              var proposedMonth = (P && P.planMonths || []).filter(function (m) { return m.ym === pym; })[0];
              if (!proposedMonth || proposedMonth.revision == null || !proposedMonth.termsKnown) { toast("最新の提案を確認してください"); return; }
              parentPlanMemos[myKey() + ":" + pym] = pmemo;
              if (!confirm(approve ? pym + " の第" + proposedMonth.revision + "版、回数と料金を承認しますか？" : "この月の回数と料金を見送り(相談)として先生に伝えますか?")) return;
              var approvalKey = myKey();
              busy = true; render();
              apiPost({ action: "parentPlanDecide", k: approvalKey, ptoken: ssGet(parentSessionKey(approvalKey)) || "", ym: pym, expectedRevision: proposedMonth.revision, approve: approve, memo: pmemo }).then(function (res) {
                if (approvalKey !== myKey()) return;
                busy = false;
                if (res.error) { if (res.parentAuthRequired || res.badCode) { clearParentSession(approvalKey); parentNotice = res.error; } else { parentPlanNotice = res.error + "。最新の提案を確認してからお試しください。"; } render(); return; }
                delete parentPlanMemos[approvalKey + ":" + pym]; parentPlanNotice = res.notificationWarning || "";
                P = res.data; render(); toast(approve ? "承認しました。ありがとうございます" : "先生に伝えました");
              }).catch(function () { if (approvalKey !== myKey()) return; busy = false; parentPlanNotice = "通信に失敗しました。入力は保持しています。最新の提案を確認してからお試しください。"; render(); });
              break;
            case "gohome": location.hash = "#home"; break;
            case "gmode": gradeMode = btn.getAttribute("data-m"); render(); break;
            case "exmode": examMode = btn.getAttribute("data-m"); render(); break;
          }
        });

        app.addEventListener("change", function (ev) {
          var el = ev.target;
          if (el && el.id === "fa-child") { familyLoadChild(el.value); return; }
          if (taskDraftInput(el)) { if (el.id === 'f-tdue-mode') render(); return; }
          if (el && el.getAttribute("data-accept-id")) { var b = acceptBatch(); if (!b.pending && !b.busy && !b.refreshRequired) { b.selected[el.getAttribute("data-accept-id")] = el.checked; b.review = null; } return; }
          if (!el || el.getAttribute("data-action") !== "taskdone") return;
          studentAction({ action: "taskDone", k: myKey(), taskId: el.getAttribute("data-id"), done: el.checked }, el.checked ? "できた! ✓" : "未完了に戻しました");
        });

        app.addEventListener("input", function (ev) { if (taskDraftInput(ev.target)) return; var ym = ev.target && ev.target.getAttribute("data-parent-plan-memo"); if (ym) { if (route() === 'family') { F.memos[F.studentId + ':' + ym] = ev.target.value; F.confirm = null; } else parentPlanMemos[myKey() + ":" + ym] = ev.target.value; } if (ev.target && ev.target.id === 'fa-email') F.email = ev.target.value; if (ev.target && ev.target.id === 'se-email') SE.email = ev.target.value; });

        /* ---------- 起動 ---------- */
        window.addEventListener("beforeunload", function (ev) { if (Object.keys(acceptBatches).some(function (k) { return !!acceptBatches[k].pending; })) { ev.preventDefault(); ev.returnValue = ""; } });
        ssDel("sw_pt"); // 旧方式の、全生徒で共通だった端末内セッションを破棄する。
        familyReadChallenge();
        studentEmailReadChallenge();
        try {
          var qs = new URLSearchParams(location.search);
          var qk = qs.get("k"), qp = qs.get("preview");
          if (qk) { lsSet("sw_k", qk); history.replaceState(null, "", location.pathname + location.hash); }
          else if (qp) { history.replaceState(null, "", location.pathname + location.hash); }
          else if (qs.toString()) history.replaceState(null, "", location.pathname + location.hash);
        } catch (e) {}
        window.addEventListener("hashchange", function () { pending = null; selMode = ""; selDays = {}; familyReadChallenge(); studentEmailReadChallenge(); if (route() === 'family') { render(); if (!F.challenge && !F.home && familyToken()) familyLoadHome(); } else if (route() === 'student-email' && SE.challenge) render(); else if (!S) loadState().catch(function () { toast('読み込めませんでした'); }); else render(); window.scrollTo(0, 0); });
        window.addEventListener("storage", function (ev) {
          if (route()==='family')return;
          if (previewK || (ev.key !== "sw_k" && ev.key !== null) || (ev.key !== null && ev.oldValue === ev.newValue)) return;
          // 別タブで専用リンクを切り替えたら、前の生徒の保護者情報をすぐに消す。
          P = null; S = null; G = null; GX = []; parentStep = "pass"; parentNotice = ""; busy = false;
          ++SE.seq; SE.busy = false; SE.email = ''; SE.removeConfirm = false; SE.message = ''; SE.error = '';
          pending = null; selMode = ""; selDays = {}; tabs.innerHTML = "";
          app.innerHTML = '<div class="loading"><div class="spinner"></div>専用リンクを確認しています…</div>';
          loadState().catch(function () { app.innerHTML = '<div class="loading">読み込みに失敗しました。再読み込みしてください。</div>'; });
        });
        if (route() === 'family') { render(); if (!F.challenge && familyToken()) familyLoadHome(); }
        else if (route() === 'student-email' && SE.challenge) render();
        else loadState().catch(function () { app.innerHTML = '<div class="loading">読み込みに失敗しました。<br>電波の良いところで再読み込みしてください。</div>'; });
      })();
