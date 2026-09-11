
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
        var selDate = null, selManual = false, dayAddOpen = false;
        var calNow = new Date(), calY = calNow.getFullYear(), calM = calNow.getMonth();
        var panel = "";          // "" | "wish" | "event" | "ng"
        var wishKind = "ok";   // 生徒の登録は授業可能時間帯に統一
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
        function route() { var h = location.hash || "#home"; if (location.pathname.indexOf('/hogosha')===0 || h === "#family" || h.indexOf("#family?") === 0 || h.indexOf('#family/')===0) return "family"; if(h === '#parent' || h.indexOf('#parent/')===0)return 'family'; if (h === "#student-email" || h.indexOf("#student-email?") === 0) return "student-email"; return { "#grades": "grades", "#history": "history", "#parent": "parent" }[h] || "home"; }
        // 生徒本人のページではヘッダー左上を「〇〇さんのマイページ」にする(保護者ページ・保護者向け表示は元のまま)
        function updateBrand() {
          var brand = document.getElementById('site-brand'); if (!brand) return;
          if (!brand.getAttribute('data-default')) { brand.setAttribute('data-default', brand.innerHTML); brand.setAttribute('data-title', document.title || ''); }
          var r = route(), mine = r !== 'family' && r !== 'parent' && S && S.me && S.me.name ? S.me.name : '';
          brand.innerHTML = mine ? esc(mine) + 'さんのマイページ<small>ステップワイズ個別指導</small>' : brand.getAttribute('data-default');
          document.title = mine ? mine + 'さんのマイページ | ステップワイズ個別指導' : brand.getAttribute('data-title');
        }
        function renderTabs() {
          updateBrand();
          if (route() === "family" || route() === 'parent') { tabs.innerHTML=parentNavigation(route()==='family');return; }
          if (!S || !S.me) { tabs.innerHTML = ""; return; }
          var p = route();
          tabs.innerHTML = [["#home", "home", "ホーム"], ["#grades", "grades", "成績"], ["#history", "history", "授業の記録"], ["#student-email", "student-email", "設定"]]
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
        function lessonLabel(s) { if (!s) return ""; var k = String(s.kind || ""); return String(s.subject || "") + (k && k !== "通常" ? "（" + k + "）" : ""); } // 科目＋種類(通常は省略)
        function endTime(start, min) { var p = start.split(":"); var t = (+p[0]) * 60 + (+p[1]) + (+min); return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60); }
        function addDaysStr(ds, n) { var p = ds.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
        function yen(n) { return (Number(n) || 0).toLocaleString() + "円"; }
        function deliveryLabel(mode) { return mode === "in_person" ? "対面" : mode === "online" ? "オンライン" : "形式は先生に確認"; }
        function deliveryTag(s) { if (route() !== 'family' && s.deliveryMode === 'in_person') return ''; return ' <span class="tag gray">' + deliveryLabel(s.deliveryMode) + '</span>'; }
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
          return h + list.map(function (r) { return publishedRecordItem(r, editable); }).join('');
        }
        function publishedRecordItem(r, editable) {
          var rep = r.report || {};
          var h = '<details class="card"' + (!editable ? ' data-parent-record="' + esc(r.recordId) + '" data-record-revision="' + esc(r.revision) + '"' : '') + '><summary>' + (!editable ? '<span data-read-label class="tag">確認中</span> ' : '') + fmtDateW(r.date) + ' ' + esc(r.start) + ' ' + esc(lessonLabel(r)) + (rep.actualUnit ? ' <span class="small muted">' + esc(rep.actualUnit) + '</span>' : '') + '</summary>';
          h += '<dl class="sw-report-grid">' + (rep.actualUnit ? '<div><dt>単元</dt><dd style="margin:0;white-space:pre-wrap">' + esc(rep.actualUnit) + '</dd></div>' : '') + '<div><dt>コメント</dt><dd style="margin:0;white-space:pre-wrap">' + esc(r.content) + '</dd></div>' + (!editable && rep.parentMessage ? '<div><dt>保護者への連絡</dt><dd style="margin:0;white-space:pre-wrap">' + esc(rep.parentMessage) + '</dd></div>' : '') + '</dl>';
          if ((r.homework || []).length) h += '<h3>宿題</h3><ul>' + r.homework.map(function (x) { return '<li>' + (editable && x.taskId && !x.withdrawn ? '<input type="checkbox" aria-label="' + esc(x.title) + 'の完了" data-action="taskdone" data-id="' + esc(x.taskId) + '"' + (x.done ? ' checked' : '') + '>' : x.done ? '☑ ' : '□ ') + esc(x.title) + ' <span class="small muted">' + esc(taskDueText(Object.assign({ dueSubject: r.subject }, x))) + '</span></li>'; }).join('') + '</ul>';
          return h + '</details>';
        }

        var SE = { challenge:'', busy:false, message:'', error:'', email:'', removeConfirm:false, seq:0 };
        var NL = { text: '', busy: false, proposal: null, error: '' }; // 文章で予定を伝える
        var folds = { tasks: true, offers: false, plan: false }; // ホームの折り畳み(やることリスト・授業登録・授業計画の案内)。開閉は再描画をまたいで保持
        function foldHead(key, title, cnt) { return '<details class="fold ' + key + '" data-fold="' + key + '"' + (folds[key] ? ' open' : '') + '><summary><h2><span class="mk" aria-hidden="true"></span>' + title + (cnt ? ' <span class="cnt">' + cnt + '</span>' : '') + '</h2></summary>'; }
        function studentEmailReadChallenge() {
          if (location.hash.indexOf('#student-email?') !== 0) return;
          SE.challenge = new URLSearchParams(location.hash.slice(15)).get('verify') || ''; SE.message = ''; SE.error = ''; SE.busy = false; ++SE.seq;
          history.replaceState(null, '', location.pathname + '#student-email');
        }
        function studentEmailMailMessage(status) {
          return status === 'suppressed' ? 'テストのためメール送信を省略しました。' : status === 'failed' ? '登録内容は保存しましたが、確認メールを送れませんでした。時間を置いて「確認メールを再送」を押してください。' : status === 'uncertain' ? '確認メールの送信結果を確認できませんでした。まず受信箱を確認してください。届かない場合は、時間を置いて新しい確認メールを申し込めます。' : '確認メールのリンクを開いてください。';
        }
        function renderStudentEmail() {
          var h = '<h1>設定</h1><h2>メール通知</h2><p class="sub">授業の案内・変更・取消をメールで受け取れます。</p>', dis = SE.busy || previewK ? ' disabled' : '', s = S && S.emailStatus || {};
          if (previewK) h += '<p class="note">先生のプレビューでは確認のみできます。メールアドレスの登録・変更は生徒専用ページから行ってください。</p>';
          if (SE.error) h += '<p class="parent-error" role="alert">' + esc(SE.error) + '</p>';
          if (SE.message) h += '<p class="card" role="status">' + esc(SE.message) + '</p>';
          if (SE.challenge) { app.innerHTML = h + '<p>このメールアドレスで受信できることを確認します。</p><button class="btn-primary" data-action="se-verify"' + dis + '>メールアドレスを確認する</button> <button class="btn-quiet" data-action="se-back"' + dis + '>登録画面に戻る</button><p class="note">リンクは30分間有効です。期限が切れた場合は、元の生徒専用ページから確認メールを送り直してください。</p>'; return; }
          if (!S || !S.me) { app.innerHTML = h + '<p>登録・変更は、先生から届いた生徒専用リンクを開いて「設定」から行ってください。</p>'; return; }
          h += '<div class="card"><p>' + (s.verified ? '通知先：' + esc(s.email) + '（確認済み）' : '確認済みの通知先はありません。') + '</p>';
          if (s.pendingEmail) h += '<p>確認待ち：' + esc(s.pendingEmail) + '</p>' + (!SE.message && ['failed','uncertain','suppressed'].indexOf(s.mailStatus) >= 0 ? '<p role="status">' + studentEmailMailMessage(s.mailStatus) + '</p>' : '') + '<button class="btn-quiet" data-action="se-resend"' + dis + '>確認メールを再送</button>';
          h += '<form id="student-email-form"><label for="se-email">自分のメールアドレス</label><input type="email" id="se-email" autocomplete="email" maxlength="254" required value="' + esc(SE.email || s.pendingEmail || s.email || '') + '"' + dis + '><p class="note">確認メールのリンクを開くと通知先になります。変更の確認が終わるまでは、現在の確認済みアドレスを使います。</p><button class="btn-primary" type="submit"' + dis + '>確認メールを送る</button></form>';
          if (s.email || s.pendingEmail) h += SE.removeConfirm ? '<p>メール通知を解除します。</p><button class="btn-quiet" data-action="se-remove"' + dis + '>解除する</button> <button class="btn-quiet" data-action="se-cancel"' + dis + '>やめる</button>' : '<p><button class="btn-quiet" data-action="se-askremove"' + dis + '>通知先を解除する</button></p>';
          h += '</div>';
          var prefs = s.prefs || {}, kinds = [['offered', '授業の案内（新しい授業の日時）'], ['changed', '授業の変更（日時・科目・形式）'], ['cancelled', '授業の取消'], ['cancelDeclined', '取消依頼への回答（予定どおり実施）']];
          h += '<div class="card" style="margin-top:14px"><h2 style="margin:0 0 6px;font-size:16px">メールで受け取る項目</h2>';
          kinds.forEach(function (kv) { h += '<label style="display:block;padding:6px 0"><input type="checkbox" data-action="se-pref" data-kind="' + kv[0] + '"' + (prefs[kv[0]] === false ? '' : ' checked') + dis + '> ' + kv[1] + '</label>'; });
          h += '<p class="note">オフにした項目はメールを送りません（生徒ページでは今までどおり確認できます）。変更はすぐに保存されます。受信確認が済むまでは、どの項目もメールは届きません。</p></div>';
          app.innerHTML = h;
        }
        function studentEmailPrefSend(kind, on) {
          var prefs = Object.assign({}, S && S.emailStatus && S.emailStatus.prefs || {}); prefs[kind] = on;
          studentEmailSend('studentEmailPrefs', { prefs: prefs });
        }
        function studentEmailSend(action, extra) {
          if (SE.busy || previewK || ['studentEmailVerify','studentEmailRequest','studentEmailResend','studentEmailRemove','studentEmailPrefs'].indexOf(action) < 0) return;
          var k = myKey(), seq = ++SE.seq, payload = action === 'studentEmailVerify' ? {action:action,challenge:SE.challenge} : {action:action,k:k};
          if (action === 'studentEmailRequest') { SE.email = val('se-email'); payload.email = SE.email; }
          if (extra) Object.assign(payload, extra);
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
              SE.message = res.message || (action === 'studentEmailRemove' ? 'メール通知を解除しました。' : action === 'studentEmailPrefs' ? '通知設定を保存しました。' : studentEmailMailMessage(status));
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
        function wishModeField(prefix){return '<input type="hidden" id="'+prefix+'-wmode" value="'+esc((S.me||{}).deliveryMode || '')+'">';}
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
          if (b.review) h += '<div class="card" role="region" aria-label="確定する日時の確認"><strong>次の' + b.review.length + '件を確定します</strong>' + b.review.map(function (s) { return '<p>' + fmtDateW(s.date) + ' ' + esc(s.start) + '〜' + endTime(s.start, s.min) + ' ' + esc(lessonLabel(s)) + (s.deliveryMode === 'in_person' ? '' : '・' + deliveryLabel(s.deliveryMode)) + '</p>'; }).join('') + '<p class="note">月間計画の承認と定員を確認します。カレンダー登録と通知を行い、オンライン授業にはMeetを発行します。</p>' + (b.pending ? '' : '<button class="btn-primary" data-action="batchsend">この日時で確定する</button> <button class="btn-quiet" data-action="batchcancel">選び直す</button>') + '</div>';
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
            if (it && it.ngAll && !past) cls += " ngday";
            var marks = '<span class="calmarks">';
            if (it && !past) {
              if (it.mine) cls += " mine";
              if (it.offer && !it.mine) marks += '<span class="caldot of"></span>';
            }
            if (selMode && selDays[ds] && !past) { cls += " selday " + selMode; if (selMode === "ng" && !(it && it.ng)) marks += '<span class="callbl to" style="color:var(--danger)">授業不可</span>'; }
            marks += "</span>";
            if (it && it.ngAll && !past) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">授業不可</span>';
            if (it && it.ngT && !past) it.ngT.slice(0, 2).forEach(function (b) { marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">授業不可' + cT(b.start) + '-' + cT(b.end) + '</span>'; });
            if (it && it.wish && !past) marks += '<span class="callbl wi">授業可</span>';
            if (showToff && it && it.toff && !past) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">登録不可</span>';
            if (showToff && it && it.toffT && !past) it.toffT.slice(0, 2).forEach(function (o) { marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">登録不可' + cT(o.start) + '-' + cT(o.end) + '</span>'; });
            if (hasItems) {
              var lb = it.labels.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
              lb.slice(0, 2).forEach(function (l) {
                if (l.st === "event") { marks += '<span class="callbl ev">' + esc(l.text) + "</span>"; return; }
                var lc = l.st === "offer" ? " of" : l.st === "past" ? " dn" : "";
                marks += '<span class="callbl tm' + lc + '">' + esc(l.start) + '</span><span class="callbl' + lc + '">' + esc(l.text) + "</span>";
              });
              if (lb.length > 2) marks += '<span class="callbl more">+' + (lb.length - 2) + "</span>";
            }
            var clickable = !past || hasItems; // 今日以降はどの日もタップ可(その日の操作ボタンが出る)
            if (!clickable) h += '<span class="' + cls + (past && hasItems ? "" : " off") + '">' + d + marks + "</span>";
            else h += '<button class="' + cls + '" data-action="calday" data-date="' + ds + '">' + d + marks + "</button>";
          }
          h += '</div><div class="callegend">';
          h += '<span><span class="callbl" style="display:inline">授業</span></span>';
          h += '<span><span class="callbl of" style="display:inline">授業（未承認）</span></span>';
          h += '<span><span class="callbl ev" style="display:inline">予定</span> 重要な予定（テスト・行事など）</span>';
          h += '<span><span class="callbl wi" style="display:inline">授業可</span> 授業できる時間帯（返事待ち）</span>';
          h += '<span><span class="callbl to ngswatch" style="display:inline">授業不可</span> 授業できない日</span>';
          if (showToff) h += '<span><span class="callbl to toffswatch" style="display:inline">登録不可</span> 先生の休み（登録できません）</span>';
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
            it.labels.push({ text: lessonLabel(s) || (s.st === "event" ? "予定" : "授業"), st: s.st, start: s.start, kind: s.kind });
          });
          blocked.forEach(function (b) { var it = info[b.date] || (info[b.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); it.ng++; if (b.start) (it.ngT = it.ngT || []).push(b); else it.ngAll = 1; });
          (S.teacherOff || []).forEach(function (o) { var it = info[o.date] || (info[o.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); if (o.start) (it.toffT = it.toffT || []).push(o); else it.toff = 1; });
          (S.wishes || []).forEach(function (w) { var it = info[w.date] || (info[w.date] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); it.wish = (it.wish || 0) + 1; });
          var upcoming = mine.filter(function (s) { return s.date > today || (s.date === today && endTime(s.start, s.min) >= nowStr); });
          return { today: today, slots: slots, mine: mine, offers: offers, hist: hist, blocked: blocked, events: events, byDate: byDate, info: info, upcoming: upcoming, next: upcoming[0] };
        }

        function previewBanner(long) {
          if (!previewK) return "";
          return '<div style="background:var(--amber-soft);border:1px solid #d99a2b;color:var(--amber);border-radius:12px;padding:10px 14px;font-size:13.5px;margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1"><strong>' + esc(S.me.name) + 'さんのページを表示中</strong>(先生プレビュー' + (long ? '。ここでの操作は本人として反映されます' : '') + ')</span><a class="btn-quiet btn-sm" href="../kanri/" style="text-decoration:none">管理画面へ</a></div>';
        }

        // 選んだ日の内訳。withActions=true なら「この日に:」のボタン(予定ページ)。登録不可(先生の休み)はホーム・予定の両方で出す(2026-09-11)
        function renderDayDetail(D, withActions, showToff) {
          var today = D.today;
          var ds2 = (D.byDate[selDate] || []).slice().sort(function (a, b) { return (a.start || "99") < (b.start || "99") ? -1 : 1; });
          var dayNg = D.blocked.filter(function (b) { return b.date === selDate; });
          var dayOffs = showToff ? (S.teacherOff || []).filter(function (o) { return o.date === selDate; }) : [];
          var dayWishes = (S.wishes || []).filter(function (w) { return w.date === selDate; });
          var dayLabel = Number(selDate.slice(5, 7)) + '月' + Number(selDate.slice(8, 10)) + '日（' + WD[wdOf(selDate)] + '）の予定';
          var html = '<div class="card" style="margin-top:14px"><div class="row" style="margin-bottom:12px"><h3 style="margin:0;font-size:18px;font-weight:700">' + dayLabel + '</h3>'+(selDate>=today?'<button class="btn-primary" style="border-radius:50%;width:40px;height:40px;padding:0;font-size:26px" data-action="dayadd" aria-label="'+fmtDateW(selDate)+'の予定を追加" aria-expanded="'+dayAddOpen+'">＋</button>':'')+'</div>';
          if (!ds2.length && !dayNg.length && !dayOffs.length && !dayWishes.length) html += '<div class="empty">この日の予定はありません</div>';
          else {
            // 授業登録の一覧と同じ行形式(左: 種類のタグ、時刻、内容 / 右: 操作)
            var dis = (acceptBatch().pending || acceptBatch().busy || acceptBatch().refreshRequired) ? ' disabled' : '';
            function dayRow(lead, time, who, actions) { return '<div class="slotline">' + lead + '<span class="time">' + time + '</span><span class="who">' + who + '</span>' + actions + '</div>'; }
            html += '<div class="daylist">';
            dayOffs.forEach(function (o) { html += dayRow('<span class="tag gray">' + (o.start ? '登録不可' : '登録不可（終日）') + '</span>', o.start ? esc(o.start) + '〜' + esc(o.end) : '', '', '<button class="btn-quiet btn-sm" data-action="helptoff" aria-label="登録不可の説明" aria-expanded="' + helpToff + '" style="border-radius:50%;width:30px;height:30px;padding:0;font-weight:700">？</button>'); });
            if (dayOffs.length && helpToff) html += '<div class="note" style="margin:4px 0 8px">先生の予定があるため、この時間帯には授業を登録できません。別の日時を選ぶか、先生にご相談ください。</div>';
            ds2.forEach(function (s) {
              if (s.st === "event") { html += dayRow('<span class="tag coral">重要な予定</span>', '', esc(s.title), s.id ? '<button class="btn-quiet btn-sm" data-action="delevent" data-id="' + esc(s.id) + '">削除</button>' : ''); return; }
              var time = s.start + "〜" + endTime(s.start, s.min), who = (s.subject ? esc(lessonLabel(s)) : "") + (s.deliveryMode === 'in_person' ? '' : deliveryTag(s));
              if (s.st === "mine") html += dayRow('<span class="tag green">確定</span>', time, who + (s.req ? ' <span class="tag amber">キャンセル申請中</span>' : ''), cancelControl(s, true));
              else if (s.st === "done") {
                var records = (S.lessonRecords || []).filter(function (r) { return r.date === s.date && r.start === s.start && r.subject === (s.subject || '') && Number(r.min) === Number(s.min); });
                var record = records.length === 1 ? records[0] : null;
                html += '<details class="slotline" style="display:block"><summary style="cursor:pointer;font-weight:600">実施済 ' + time + (s.subject ? ' ' + esc(lessonLabel(s)) : '') + '</summary><div style="padding:12px 4px">';
                if (record) {
                  html += window.StepwiseReport.view({actualUnit:(record.report || {}).actualUnit || '未記入'});
                  html += '<h3 style="font-size:15px;margin:10px 0 6px">コメント</h3><p style="white-space:pre-wrap;margin:0">' + esc(record.content || 'コメントはまだありません。') + '</p>';
                } else html += '<p class="muted" style="margin:0">授業の内容はまだ公開されていません。</p>';
                html += '</div></details>';
              }
              else if (s.st === "past") html += dayRow('<span class="tag gray">授業</span>', time, who, '');
              else if (s.st === "offer") html += dayRow('<label><input type="checkbox" data-accept-id="' + esc(s.id) + '"' + (acceptBatch().selected[s.id] ? ' checked' : '') + dis + ' aria-label="' + esc(fmtDateW(s.date) + ' ' + s.start + 'を選択') + '"></label><span class="tag amber">案内</span>', time, who, '<button class="btn-primary btn-sm" data-action="askaccept" data-id="' + esc(s.id) + '"' + dis + '>確定</button><button class="btn-quiet btn-sm" data-action="askdecline" data-id="' + esc(s.id) + '">再調整</button>');
            });
            dayNg.forEach(function (b) { html += dayRow('<span class="tag gray">授業不可</span>', b.start ? esc(b.start) + '〜' + esc(b.end) : '終日', b.note ? esc(b.note) : '', b.id && selDate >= today ? '<button class="btn-quiet btn-sm" data-action="delblock" data-ids="' + esc(b.id) + '">解除</button>' : ''); });
            dayWishes.forEach(function (w) { html += dayRow('<span class="tag green">授業可</span>', esc(w.start) + '〜' + esc(w.end), (w.note ? esc(w.note) + ' ' : '') + '<span class="small muted">先生の返事待ち</span>', '<button class="btn-quiet btn-sm" data-action="delwish" data-id="' + esc(w.id) + '">取消</button>'); });
            html += '</div>';
          }
          if (selDate >= today) {
            if (dayAddOpen) {
              html += '<h3 style="margin:12px 0 6px;font-size:15px">手動で予定入力</h3><div class="row" style="gap:6px">' +
                '<button class="btn-quiet btn-sm" data-action="dayact" data-m="wish" data-date="' + selDate + '">授業可能</button>' +
                '<button class="btn-quiet btn-sm" data-action="dayact" data-m="ng" data-date="' + selDate + '">授業不可</button>' +
                '<button class="btn-quiet btn-sm" data-action="dayact" data-m="event" data-date="' + selDate + '">予定共有</button></div>';
              if (S.nlEnabled && !previewK) html += renderNaturalEntry();
            }
          }
          if (route() === 'home' && selMode) html += renderSelBar(D, true);
          return html + '</div>';
        }

        function renderNextLesson(D) {
          var today = D.today, next = D.next;
          var html = '<h2>次の授業</h2>';
          if (next) {
            var untilTxt = next.date === today ? "今日" : next.date === addDaysStr(today, 1) ? "明日" : Math.round((new Date(next.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5) + "日後";
            html += '<div class="card next"><div class="in">' + untilTxt + '</div><div class="when">' + fmtDateW(next.date) + " " + next.start + "〜" + endTime(next.start, next.min) + '</div>';
            html += '<div class="row" style="margin-top:4px">' + (next.subject ? '<span class="tag blue">' + esc(next.subject) + '</span>' : "") + deliveryTag(next) + '<span class="small muted">' + next.min + "分</span>" + (next.req ? '<span class="tag red">キャンセル申請中</span>' : "") + '</div>';
            html += '<div class="row" style="margin-top:10px">';
            if (next.meet) html += '<a class="btn-primary btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(next.meet) + '">Meetに参加</a>';
            html += '<a class="btn-ghost btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + gcalUrl(next) + '">カレンダーに追加</a>';
            html += cancelControl(next) + '</div></div>';
          } else {
            html += '<div class="empty">次の授業はまだ決まっていません。' + (D.offers.length ? '下の「授業登録」から確定してください。' : '先生から案内が届くとここに表示されます。') + '</div>';
          }
          return html;
        }

        // 授業計画(折り畳み)。案内=保護者の承認待ちの月の計画、実施計画=承認済みの月の計画と実施・予定の回数。GAS の planMonths(今月・来月)を使う
        function renderMonthSummary(D) {
          var today = D.today, mine = D.mine, months = S.planMonths;
          if (!Array.isArray(months)) months = (S.plan && Object.keys(S.plan).length && (S.planStatus === 'proposed' || S.planStatus === 'approved')) ? [{ ym: today.slice(0, 7), status: S.planStatus, plan: S.plan }] : [];
          var proposed = months.filter(function (m) { return m.status === 'proposed'; }), approved = months.filter(function (m) { return m.status === 'approved'; });
          function counts(ym) {
            var histM = (S.history || []).filter(function (h) { return h.date.slice(0, 7) === ym; }), out = {};
            function add(k, key) { var c = out[k] || (out[k] = { done: 0, plan: 0 }); c[key]++; }
            histM.forEach(function (h) { add(lessonLabel(h) || 'その他', h.done ? 'done' : 'plan'); });
            mine.filter(function (s2) { return s2.date.slice(0, 7) === ym; }).forEach(function (s2) { add(lessonLabel(s2) || 'その他', 'plan'); });
            return out;
          }
          var proposedRows = 0; proposed.forEach(function (m) { proposedRows += Object.keys(m.plan).length; });
          var ymNow = today.slice(0, 7), nowCounts = counts(ymNow), nowHasLessons = Object.keys(nowCounts).length > 0;
          if (!months.length && !nowHasLessons) return '';
          var html = foldHead('plan', '授業計画', proposedRows ? proposedRows + '件の案内' : approved.length ? '承認済み' : (+ymNow.slice(5)) + '月') + '<div class="card">';
          html += '<h3 style="margin:0 0 6px;font-size:15px">案内 <span class="small muted" style="font-weight:400">保護者の承認待ち</span></h3>';
          if (!proposedRows) html += '<div class="empty">新しい案内はありません</div>';
          proposed.forEach(function (m) { Object.keys(m.plan).forEach(function (k) { html += '<div class="slotline"><span class="tag amber">案内</span><span class="time">' + (+m.ym.slice(5)) + '月</span><span class="who"><strong>' + esc(k) + '</strong> ' + m.plan[k] + '回</span><span class="tag amber">保護者の承認待ち</span></div>'; }); });
          if (proposedRows) html += '<div class="note">保護者の方に伝えて、保護者ページから承認・調整をお願いしましょう。承認されると下の実施計画に移ります。</div>';
          html += '<h3 style="margin:14px 0 6px;font-size:15px">実施計画 <span class="small muted" style="font-weight:400">承認済み</span></h3>';
          var remainTotal = 0, shown = 0;
          approved.forEach(function (m) {
            var c = counts(m.ym), keys = Object.keys(m.plan);
            Object.keys(c).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
            keys.forEach(function (k) {
              var n = c[k] || { done: 0, plan: 0 }, goal = m.plan[k] || 0, remain = goal ? Math.max(0, goal - n.done - n.plan) : 0; remainTotal += remain; shown++;
              html += '<div class="slotline"><span class="tag green">承認済み</span><span class="time">' + (+m.ym.slice(5)) + '月</span><span class="who"><strong>' + esc(k) + '</strong> 実施 ' + n.done + '・予定 ' + n.plan + (goal ? '<span class="muted">／計画 ' + goal + '回</span>' : '<span class="muted">（計画外）</span>') + '</span>' + (remain ? '<span class="small" style="color:var(--primary)">あと ' + remain + ' 回</span>' : goal ? '<span class="tag green">日程確定</span>' : '') + '</div>';
            });
          });
          if (!approved.length && nowHasLessons) Object.keys(nowCounts).forEach(function (k) { var n = nowCounts[k]; shown++; html += '<div class="slotline"><span class="tag gray">' + (+ymNow.slice(5)) + '月</span><span class="time"></span><span class="who"><strong>' + esc(k) + '</strong> 実施 ' + n.done + '・予定 ' + n.plan + '</span></div>'; });
          if (!shown) html += '<div class="empty">承認済みの計画はありません</div>';
          if (remainTotal) html += '<div class="small" style="color:var(--primary);margin-top:8px">あと ' + remainTotal + ' 回、日程調整が必要です。予定表で日付を選び、＋から授業可能日時を送れます。</div>';
          return html + '</div></details>';
        }

        function renderOffers(D) {
          var offers = D.offers, b = acceptBatch(), html = renderBatch(b);
          var selectable = offers.slice(0, 31), allSelected = selectable.every(function (s) { return b.selected[s.id]; });
          if (!offers.length) return html;
          html += foldHead('offers', '授業登録', offers.length + '件・返事をお願いします');
          html += '<div class="card" style="border-color:#d99a2b">';
          html += '<div class="row"><button class="btn-quiet btn-sm" data-action="' + (allSelected ? 'batchclear' : 'batchall') + '"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>' + (allSelected ? '選択解除' : '一括選択') + '</button>' + (offers.length > 31 ? '<span class="small muted">一括選択は31件まで</span>' : '') + '</div>';
          offers.forEach(function (s) {
            html += '<div class="slotline"><label><input type="checkbox" data-accept-id="' + esc(s.id) + '"' + (b.selected[s.id] ? ' checked' : '') + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + ' aria-label="' + esc(fmtDateW(s.date) + ' ' + s.start + 'を選択') + '"></label><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (s.subject ? esc(lessonLabel(s)) : "") + deliveryTag(s) + "</span>";
            html += '<button class="btn-primary btn-sm" data-action="askaccept" data-id="' + esc(s.id) + '"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>確定</button><button class="btn-quiet btn-sm" data-action="askdecline" data-id="' + esc(s.id) + '">再調整</button></div>';
          });
          html += '<button class="btn-primary" data-action="batchreview"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>選んだ日時を確認する</button></div><div class="note">日時を確認してから確定します。日時が合わないときは「再調整」で先生に別の日時をお願いできます。</div></details>';
          return html;
        }

        function renderUpcoming(D, hasNextCard) {
          var upcoming = D.upcoming, next = D.next;
          var html = '<h2>今後の予定 <span class="cnt">' + upcoming.length + '件</span></h2>';
          if (upcoming.length > 1 || (upcoming.length === 1 && !(hasNextCard && next))) {
            html += '<div class="card">';
            upcoming.forEach(function (s) {
              html += '<div class="slotline"><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (s.subject ? esc(lessonLabel(s)) : "") + (s.req ? ' <span class="tag red">キャンセル申請中</span>' : "") + "</span>";
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
          html += '<div class="note">キャンセルは各授業から申請できます。申請後は「キャンセル申請中」と表示されます。</div>';
          return html;
        }

        // 画面下の確認バー(確定・再調整・取消依頼・取り下げ)。ホーム・予定ページ共通
        function renderPendingBar(D) {
          if (!pending) return "";
          if (pending.kind === "remove") {
            return '<div class="confirmbar"><div class="inner"><div class="msg">' + pending.text + '</div><div class="row"><button class="btn-danger" data-action="doremove"' + (busy ? ' disabled' : '') + '>' + (busy ? '処理しています…' : esc(pending.verb)) + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div></div></div>';
          }
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
            var deadline = S.cancelDeadlineH || 24;
            var late = (new Date(s.date + 'T' + s.start + ':00+09:00').getTime() - Date.now()) / 3600000 < deadline;
            html += '<div class="msg">' + when + ' のキャンセル申請</div>';
            html += '<p>' + (late ? '授業開始まで' + deadline + '時間を切っています。病気や大幅な電車の遅れなど、やむを得ない事情がある場合は記載してください。' : 'キャンセルの理由を記入してください。') + '</p>';
            html += '<input type="text" id="f-creason" maxlength="1000" required value="' + esc(pending.reason || '') + '" placeholder="理由（必須）" style="width:100%;margin:6px 0 8px">';
            html += '<div class="row"><button class="btn-danger" data-action="docancel"' + (busy ? " disabled" : "") + '>' + (busy ? '申請しています…' : 'キャンセルを申請する') + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "withdraw") {
            html += '<div class="msg">' + when + " の取消依頼を取り下げて、予定どおり授業を受けますか?</div>";
            html += '<div class="row"><button class="btn-primary" data-action="dowithdraw"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "依頼を取り下げる") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          }
          return html + "</div></div>";
        }

        // 予定ページの画面下: 日付を選択中のバー(授業できない日・希望・予定共有)
        function renderSelBar(D, inline) {
          if (!selMode) return "";
          var blocked = D.blocked;
          var selDates = Object.keys(selDays).filter(function (d) { return selDays[d]; }).sort();
          var selTxt = selDates.length ? selDates.map(fmtDateW).join("、") : "予定表の日付をタップすると選べます(もう一度タップで取り消し)";
          var html = '<div class="confirmbar selbar ' + selMode + '"' + (inline ? ' style="position:static;margin-top:14px;padding:14px 0 0;box-shadow:none"' : '') + '><div class="inner">';
          if (selMode === "ng") {
            var ngByDate = {};
            blocked.forEach(function (b) { (ngByDate[b.date] = ngByDate[b.date] || []).push(b.id); });
            var addN = selDates.filter(function (d) { return !ngByDate[d]; }).length, remN = selDates.length - addN;
            html += '<div class="msg">授業できない日: ' + selDates.length + '日' + (selDates.length ? '(登録 ' + addN + '日' + (remN ? '・解除 ' + remN + '日' : '') + ')' : '') + '</div>';
            html += '<div class="small muted" style="margin-bottom:8px">' + selTxt + (selDates.length ? "" : "。斜線の日をタップすると解除") + '</div>';
            html += '<div class="row" style="margin-bottom:6px"><span class="small muted">時間帯(任意。空欄なら終日)</span><input type="time" id="b-ngstart" step="900"><span class="muted">〜</span><input type="time" id="b-ngend" step="900"></div>';
            html += '<div class="row"><input type="text" id="b-ngnote" placeholder="メモ(任意。例: 大会)" maxlength="50" style="flex:1;min-width:140px"><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "登録しています…" : "この内容で登録") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          } else if (selMode === "wish") {
            html += wishModeField('b');
            html += '<div class="msg">授業可能日時: ' + selDates.length + '日</div><div class="small muted" style="margin-bottom:8px">' + selTxt + '</div>';
            html += '<div class="row"><input type="time" id="b-wstart" value="13:00" step="900"><span class="muted">〜</span><input type="time" id="b-wend" value="18:00" step="900"><input type="text" id="b-wnote" placeholder="メモ(任意)" maxlength="100" style="flex:1;min-width:120px"><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "登録する") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          } else if (selMode === "event") {
            var rangesTxt = groupDays(selDates).map(function (g) { return g.date === g.dateTo ? fmtDateW(g.date) : fmtDateW(g.date) + "〜" + fmtDateW(g.dateTo); }).join("、");
            html += '<div class="msg">予定を共有: ' + selDates.length + '日</div><div class="small muted" style="margin-bottom:8px">' + (selDates.length ? rangesTxt : selTxt) + '</div>';
            html += '<div class="row"><input type="text" id="b-etitle" placeholder="内容(例: 大会、高校見学)" maxlength="40" style="flex:1;min-width:160px"><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="b-etest"> テスト・模試</label><label class="small" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="b-eblock"> 授業できない日にもする</label><button class="btn-primary" data-action="selapply"' + (busy || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "先生に共有") + '</button><button class="btn-quiet" data-action="selcancel">やめる</button></div>';
          }
          return html + '</div></div>';
        }

        /* ---------- 文章で自動入力(「選んだ日の予定」の＋を押すと表示。GAS が AI で候補に変換 → ここで確認 → 既存の登録処理へ) ---------- */
        var NL_LABEL = { wish: '授業できる時間帯', block: '授業できない日', event: '予定の共有' };
        function nlDates(dates) { return groupDays(dates).map(function (g) { return g.date === g.dateTo ? fmtDateW(g.date) : fmtDateW(g.date) + '〜' + fmtDateW(g.dateTo); }).join('、'); }
        function renderNaturalEntry() {
          var dis = NL.busy || busy ? ' disabled' : '';
          var h = '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px"><h3 style="margin:0 0 6px;font-size:15px">文章で自動入力</h3>';
          h += '<p class="note" style="margin-top:0">例:「来週の月曜と水曜は16時から19時まで授業できます」「10/3〜10/5は修学旅行で授業できません」「10/20に模試があります」。読み取った内容を確認してから登録します。</p>';
          h += '<textarea id="nl-text" rows="3" maxlength="400" placeholder="予定を文章で入力" style="width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px"' + dis + '>' + esc(NL.text) + '</textarea>';
          h += '<div class="row" style="margin-top:8px"><button class="btn-primary btn-sm" data-action="nl-parse"' + dis + '>' + (NL.busy ? '読み取っています…' : '内容を確認') + '</button>' + (NL.proposal || NL.text ? '<button class="btn-quiet btn-sm" data-action="nl-clear"' + dis + '>消す</button>' : '') + '</div>';
          if (NL.error) h += '<p role="alert" style="color:var(--danger);margin:8px 0 0">' + esc(NL.error) + '</p>';
          if (NL.proposal) h += renderNaturalProposal(NL.proposal, dis);
          return h + '</div>';
        }
        function renderNaturalProposal(p, dis) {
          var h = '<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">';
          if (p.summary) h += '<p style="margin:0 0 6px">' + esc(p.summary) + '</p>';
          if (!p.items.length) h += '<div class="empty">登録できる予定を読み取れませんでした。日付と時間を入れて書き直してください。</div>';
          p.items.forEach(function (it, i) {
            var head = NL_LABEL[it.kind] + (it.kind === 'event' ? '：' + esc(it.title) + (it.test ? '（テスト・模試）' : '') + (it.alsoBlock ? '（授業できない日としても登録）' : '') : '');
            h += '<label class="task" style="align-items:flex-start"><input type="checkbox" data-action="nl-item" data-i="' + i + '"' + (it.sel ? ' checked' : '') + (it.done ? ' disabled' : dis) + '><span class="tt"><strong>' + head + '</strong>' + (it.done ? ' <span class="tag green">登録済み</span>' : '') + '<br>' + esc(nlDates(it.dates));
            if (it.kind === 'wish') {
              if (it.needsTime) h += '<br><span class="small" style="color:var(--danger)">時間帯を入れてください</span>';
              h += '<br><input type="time" id="nl-start-' + i + '" value="' + esc(it.start || '') + '" step="900"' + dis + '><span class="muted">〜</span><input type="time" id="nl-end-' + i + '" value="' + esc(it.end || '') + '" step="900"' + dis + '>';
            } else if (it.start && it.end) h += ' ' + esc(it.start) + '〜' + esc(it.end);
            else if (it.kind === 'block') h += ' 終日';
            if (it.note) h += '<br><span class="small muted">' + esc(it.note) + '</span>';
            if (it.confidence === 'low') h += '<br><span class="small" style="color:var(--amber)">読み取りに自信がありません。内容を確認してください</span>';
            h += '</span></label>';
          });
          if (p.questions && p.questions.length) h += '<ul class="small" style="margin:8px 0 0 18px;padding:0">' + p.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>';
          if (p.items.some(function (it) { return !it.done; })) h += '<div class="row" style="margin-top:10px"><button class="btn-primary" data-action="nl-register"' + dis + '>チェックした内容で登録する</button></div><p class="note">授業できる時間帯は先生への希望です。登録だけでは授業は確定しません。</p>';
          return h + '</div>';
        }
        function nlParse() {
          if (NL.busy || busy) return;
          var text = String(NL.text || '').trim(); if (!text) { toast('予定の文章を入れてください'); return; }
          var k = myKey(); NL.busy = true; NL.error = ''; NL.proposal = null; render();
          apiPost({ action: 'scheduleParse', k: k, text: text }).then(function (res) {
            if (k !== myKey()) return; NL.busy = false;
            if (res.error) NL.error = res.error;
            else { (res.items || []).forEach(function (it) { it.sel = true; if (it.kind === 'wish' && it.needsTime) { it.start = it.start || '13:00'; it.end = it.end || '18:00'; } }); NL.proposal = { items: res.items || [], questions: res.questions || [], summary: res.summary || '' }; }
            render();
          }).catch(function () { if (k !== myKey()) return; NL.busy = false; NL.error = '通信に失敗しました。電波の良いところでもう一度お試しください'; render(); });
        }
        function nlRegister() {
          var p = NL.proposal; if (!p || busy || NL.busy) return;
          var queue = [], k = myKey(), blockedDates = {};
          (S.blocked || []).forEach(function (b) { blockedDates[b.date] = true; });
          for (var i = 0; i < p.items.length; i++) {
            var it = p.items[i]; if (!it.sel || it.done) continue;
            if (it.kind === 'wish') {
              var st = val('nl-start-' + i) || it.start, en = val('nl-end-' + i) || it.end;
              if (!st || !en || st >= en) { toast(nlDates(it.dates) + ' の時間帯は「開始 < 終了」で入れてください'); return; }
              queue.push({ i: i, body: { action: 'wishMany', k: k, kind: 'ok', dates: it.dates, start: st, end: en, note: it.note || '', deliveryMode: (S.me || {}).deliveryMode || '' } });
            } else if (it.kind === 'block') {
              var add = it.dates.filter(function (d) { return !blockedDates[d]; });
              if (add.length) queue.push({ i: i, body: { action: 'blockSet', k: k, add: add, removeIds: [], note: it.note || '', start: it.start || '', end: it.end || '' } });
              else { it.done = true; it.sel = false; }
            } else if (it.kind === 'event') {
              queue.push({ i: i, body: { action: 'eventAddMany', k: k, ranges: groupDays(it.dates), title: it.title, alsoBlock: !!it.alsoBlock, kind: it.test ? 'test' : 'event' } });
            }
          }
          if (!queue.length) { toast('登録する項目にチェックを入れてください'); return; }
          var total = queue.length;
          (function next() {
            var job = queue.shift();
            if (!job) { NL.text = ''; NL.proposal = null; NL.error = ''; toast(total + '件を登録しました'); render(); return; }
            studentAction(job.body, '', function () { p.items[job.i].done = true; p.items[job.i].sel = false; next(); });
          })();
        }

        function renderStudent() {
          if (route() === 'student-email') { renderTabs(); renderStudentEmail(); return; }
          renderTabs();
          if (route() === "family") { renderFamily(); return; }
          if (!S || !S.me) { renderGuard(); return; }
          var page = route();
          if (page !== "home") {
            var hh = previewBanner(false);
            if (page === "grades") hh += renderGradesPage();
            else if (page === "history") hh += renderHistoryPage();
            else hh += renderParentPage();
            hh += '<footer class="app"><span></span><span></span></footer>';
            app.innerHTML = hh;
            return;
          }
          app.innerHTML = renderHomePage();
        }

        /* ---------- ホーム: 予定表・予定の編集(選んだ日の内訳。登録・取消はここから)・やることリスト(折り畳み、既定は開)・授業登録(折り畳み)・授業計画の案内(折り畳み) ---------- */
        function renderHomePage() {
          var D = schedData(), today = D.today, mine = D.mine, events = D.events;
          var html = previewBanner(true);

          // 予定表と日付ごとの登録。日を選ぶモード中は見出しに案内を出す
          var hintMap = { ng: "授業できない日をタップして選んでください(複数可)", wish: "授業が可能な日をタップ(複数可)。時間は下の入力欄で", event: "予定の日をタップ(複数可)。内容は下の入力欄で" };
          html += '<h2>予定表' + (selMode ? ' <span style="font-size:12.5px;color:var(--' + (selMode === "ng" ? "danger" : selMode === "wish" ? "green" : "coral") + ');font-weight:600">' + hintMap[selMode] + '</span>' : '') + '</h2>';
          html += renderCal(D.info, today, true);
          html += '<h2>予定の編集</h2>';
          html += renderDayDetail(D, true, true);

          // テストまでのカウントダウン + やること(宿題・持ち物)
          (function () {
            var tests = events.filter(function (e) { return e.kind === "test" && e.dateTo >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
            var tasks = (S.tasks || []).filter(function (t) { return !t.withdrawnAt && !t.withdrawn; });
            var open = tasks.filter(function (t) { return !t.done; });
            var doneT = tasks.filter(function (t) { return t.done; });
            var nextL = mine.filter(function (s) { return s.date >= today; })[0];
            html += foldHead('tasks', 'やることリスト', open.length ? open.length + '件' : '');
            if (tests.length || nextL) {
              html += '<div class="countdown" style="margin-bottom:10px">';
              tests.slice(0, 2).forEach(function (e) {
                var days = Math.round((new Date(e.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5);
                html += '<div class="cd"><div class="small muted">' + esc(e.title) + ' <span class="muted">' + fmtDateW(e.date) + '</span></div><div class="n" style="color:#7a4fc9">' + (days === 0 ? "今日" : days + '<small>日後</small>') + '</div></div>';
              });
              if (!tests.length) html += '<div class="cd"><div class="small muted">次のテスト・模試</div><div class="small" style="margin-top:4px">未登録。予定表で日付を選び、＋の「予定を共有」で「テスト・模試」にチェックを入れて登録すると、ここに日数が出ます。</div></div>';
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
            html += '</div></details>';
          })();

          html += renderOffers(D);
          html += renderMonthSummary(D);

          html += '<div class="note" style="margin-top:18px">実施済みの授業は「授業の記録」、テストの結果は「成績」、授業料などは「保護者ページ」にあります。</div>';
          html += '<footer class="app"><span>ページを開くと最新の状態になります</span><span></span></footer>';
          html += renderPendingBar(D);
          return html;
        }

        function cancelControl(s, compact) {
          if (s.req) return '<button class="btn-quiet btn-sm" data-action="askwithdraw" data-id="' + esc(s.id) + '">依頼を取り下げる</button>';
          if (typeof s.hours === "number" && s.hours < (S.cancelDeadlineH || 24)) return '<button class="btn-quiet btn-sm" data-action="askcancel" data-id="' + esc(s.id) + '">' + (compact ? 'キャンセル' : '例外取消を申請') + '</button>';
          return '<button class="btn-quiet btn-sm" data-action="askcancel" data-id="' + esc(s.id) + '">' + (compact ? 'キャンセル' : '取消を依頼') + '</button>';
        }

        /* ---------- 画面: 成績 / 授業の記録 ---------- */
        function renderGradesPage() {
          var h = '<p class="sub">先生が記録したテストの結果</p>';
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

        // 授業の記録: 科目＋種類ごとのフォルダをカードで並べ、開くとそのフォルダの中身(公開された授業記録と実施済みの授業、日付の新しい順)を表示する
        var histFolder = null;
        var helpToff = false; // 「登録不可」の説明(？ボタン)の開閉
        function historyFolders() {
          var done = (S.history || []).filter(function (x) { return x.done; }), records = (S.lessonRecords || []).slice(), used = {};
          function recordFor(x) { return records.filter(function (r) { return r.date === x.date && r.start === x.start && r.subject === (x.subject || '') && Number(r.min) === Number(x.min); })[0] || null; }
          var folders = {}, order = [];
          function folder(label) { if (!folders[label]) { folders[label] = { label: label, items: [], lessons: 0, records: 0, mins: 0, last: '' }; order.push(label); } return folders[label]; }
          done.forEach(function (x) { var f = folder(x.subject ? lessonLabel(x) : 'その他'), r = recordFor(x); if (r) used[r.recordId || (r.date + ' ' + r.start)] = true; f.items.push({ date: x.date, start: x.start, min: x.min, record: r }); f.lessons++; f.mins += Number(x.min) || 0; if (r) f.records++; if (x.date > f.last) f.last = x.date; });
          records.forEach(function (r) {
            if (used[r.recordId || (r.date + ' ' + r.start)]) return;
            var match = (S.history || []).filter(function (x) { return x.date === r.date && x.start === r.start && (x.subject || '') === r.subject; })[0];
            var f = folder(r.subject ? lessonLabel({ subject: r.subject, kind: match ? match.kind : '' }) : 'その他'); f.items.push({ date: r.date, start: r.start, min: r.min, record: r }); f.records++; if (r.date > f.last) f.last = r.date;
          });
          order.sort(function (x, y) { return folders[y].lessons - folders[x].lessons || (x < y ? -1 : x > y ? 1 : 0); });
          order.forEach(function (k) { folders[k].items.sort(function (x, y) { return x.date + ' ' + x.start < y.date + ' ' + y.start ? 1 : -1; }); });
          return { order: order, folders: folders, total: done.length };
        }
        function renderHistoryPage() {
          var d = historyFolders(), h = '';
          if (!d.order.length) return '<p class="sub">実施済みの授業(直近120日)と先生からの授業記録</p><div class="empty">実施済みの授業はまだありません</div>';
          var f = histFolder && d.folders[histFolder];
          if (f) {
            h += '<div class="row" style="margin-bottom:10px"><button class="btn-quiet btn-sm" data-action="histback">← 一覧に戻る</button></div>';
            h += '<h2>📁 ' + esc(f.label) + ' <span class="cnt">' + f.lessons + '回・' + f.mins + '分' + (f.records ? '・記録 ' + f.records + '件' : '') + '</span></h2><div class="card">';
            if (f.records) h += '<h3 style="margin:0 0 6px;font-size:14px">先生からの授業記録</h3>';
            f.items.forEach(function (it) {
              if (it.record) h += publishedRecordItem(it.record, true);
              else h += '<div class="slotline"><span class="time">' + fmtDateW(it.date) + ' ' + esc(it.start) + '</span><span class="who"><span class="small muted">' + (it.min ? it.min + '分・' : '') + '記録はまだ公開されていません</span></span></div>';
            });
            return h + '</div>';
          }
          h += '<p class="sub">実施済みの授業(直近120日)と先生からの授業記録。科目と種類ごとのフォルダをタップすると開きます</p>';
          h += '<div class="card" style="padding:10px 14px;margin-bottom:12px"><div class="row" style="gap:8px 18px"><span><strong>合計</strong> ' + d.total + '回</span>' + d.order.map(function (k) { return '<span>' + esc(k) + ' ' + d.folders[k].lessons + '回</span>'; }).join('') + '</div></div>';
          h += '<div class="folder-grid">';
          d.order.forEach(function (k) {
            var fo = d.folders[k];
            h += '<button class="folder-card" data-action="histopen" data-folder="' + esc(k) + '"><span class="fname">📁 ' + esc(k) + '</span><span class="small muted">' + fo.lessons + '回・' + fo.mins + '分' + (fo.last ? '・最終 ' + fmtDateW(fo.last) : '') + '</span>' + (fo.records ? '<span class="tag blue">記録 ' + fo.records + '件</span>' : '<span class="small muted">記録はまだありません</span>') + '</button>';
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

        function renderParent(data, family, childId) {
          var d = data || P, activeBusy = family ? F.busy : busy, memoKey = family ? childId : myKey(), memos = family ? F.memos : parentPlanMemos;
          var html = family ? '' : '<div style="display:flex;justify-content:flex-end"><button class="btn-quiet btn-sm" data-action="parentclose"' + (activeBusy ? ' disabled' : '') + '>ログアウト</button></div>';
          var tm = d.thisMonth || {}, bill = d.billing, section=parentSection();
          if (!family && parentPlanNotice) html += '<p class="parent-error" role="alert">' + esc(parentPlanNotice) + '</p>';
          html += '<p><button class="btn-sm" data-action="' + (family ? 'fa-refresh' : 'parentrefresh') + '"' + (activeBusy ? " disabled" : "") + '>最新の情報を確認</button></p>';
          if(section==='home'){
          html += '<h2>今月の授業 <span class="cnt">' + esc(d.month) + '</span></h2><div class="row" style="align-items:stretch">';
          html += '<div class="card" style="flex:1;min-width:150px"><div class="small muted">実施済み</div><div class="stat">' + (tm.count || 0) + '<small>回 / ' + (tm.minutes || 0) + '分</small></div></div>';
          html += '<div class="card" style="flex:1;min-width:150px"><div class="small muted">' + (bill && bill.mode === "recorded" ? "請求記録額" : tm.mode === "monthly" ? "月謝" : "授業料(時間換算)") + '</div><div class="stat">' + (bill && bill.provisional && !bill.invoice ? "料金の承認待ち" : yen(bill ? (bill.invoice ? bill.invoice.amount : bill.amount) : tm.fee)) + '</div><div class="small muted">' + (bill && bill.provisional && !bill.invoice ? "この月の条件を先生にご確認ください" : bill && bill.mode === "recorded" ? "過去の請求記録（当時の料金条件は未記録）" : tm.mode === "monthly" ? "月額固定" : "30分 " + yen(bill ? bill.rate30 : d.rate30) + " × 実施時間") + '</div></div></div>';
          html += '<p>予定・授業報告・請求・連絡は上のメニューから確認できます。</p>';
          }
          if(!family&&(section==='home'||section==='schedule')){
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
          var approvalHelpId='approval-help-'+encodeURIComponent(childId||'parent');
          html += '<h2>授業計画の案内<button type="button" class="approval-help-button" data-action="approval-help" aria-label="授業計画の案内について" aria-expanded="false" aria-controls="'+approvalHelpId+'">?</button></h2><div id="'+approvalHelpId+'" class="card note" hidden><p>この承認は、契約上、その月に実施できる授業回数の上限を確認するものです。</p><p>授業料は、実際に実施した授業の分だけ発生します。承認した回数分の料金が、すべて発生するわけではありません。</p><p>予定を入れなかった分や、事前にキャンセルが成立した授業の料金は発生しません。キャンセルには理由の記入と先生の承認が必要です。</p></div>';
          if (!pms.length) html += '<div class="empty">承認をお願いする予定はいまありません</div>';
          else {
            html += '<div class="card">';
            pms.forEach(function (m) {
              html += '<div style="padding:12px 0;border-bottom:1px solid var(--line)"><strong>'+esc(Number(m.ym.slice(0,4))+'年'+Number(m.ym.slice(5)))+'月</strong>'+(m.status==='approved'?' <span class="tag green">承認済み</span>':m.status==='declined'?' <span class="tag gray">見送り</span>':'');
              html += '<p>'+m.rows.map(function(x){return esc(lessonLabel(x))+'　'+(m.lessonMin?esc(m.lessonMin)+'分 × ':'')+esc(x.count)+'回まで';}).join('<br>')+'</p><p><strong>'+(m.termsKnown&&m.lessonMin?'1回 '+yen(m.rate30*m.lessonMin/30):'授業時間・料金は先生に確認してください')+'</strong></p>';
              if(m.status==='proposed'&&m.termsKnown&&m.revision!=null)html+='<div class="row"><button class="btn-primary btn-sm" data-action="'+(family?'fa-planok':'planok')+'" data-ym="'+esc(m.ym)+'"'+(activeBusy?' disabled':'')+'>承認する</button><button class="btn-quiet btn-sm" data-action="'+(family?'fa-planng':'planng')+'" data-ym="'+esc(m.ym)+'"'+(activeBusy?' disabled':'')+'>見送る</button></div>';
              if(m.memo)html+='<p class="note">'+esc(m.memo)+'</p>';
              html += '</div>';
            });
            html += '</div>';
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
          if (family) html = html.replace(/data-action="(fa-[^"]+)"/g, 'data-action="$1" data-child="' + esc(childId) + '"').replace(/id="pl-memo-/g, 'id="pl-memo-' + esc(childId) + '-').replace(/data-parent-plan-memo=/g, 'data-child="' + esc(childId) + '" data-parent-plan-memo=');
          return html;
        }

        /* ---------- 家族の保護者認証: 専用リンク方式とは別のセッション ---------- */
        var notices={items:[],open:false,busy:false,error:"",seq:0};
        var F = { step: "login", invite: "", email: "", home: null, childrenData: Object.create(null), studentId: "", busy: false, message: "", error: "", seq: 0, challenge: "", challengeKind: "", verificationInfo: null, verificationInvalid: false, confirm: null, memos: Object.create(null) };
        function familyToken() { return ssGet("sw_ft_v1") || ""; }
        function familyClear() { notices.items=[]; notices.open=false; ++notices.seq; notices.busy=false; ssDel("sw_ft_v1"); ssDel("sw_ft_v1:logout"); F.home = null; F.childrenData = Object.create(null); F.studentId = ""; F.confirm = null; F.memos = Object.create(null); F.step = "login"; }
        function familyRender() { if (route() === "family") render(); }
        function familyRequest(action, payload, success) {
          if (F.busy) return;
          var seq = ++F.seq, auth = payload.ftoken || ""; F.busy = true; F.error = ""; familyRender();
          apiPost(Object.assign({ action: action }, payload)).then(function (res) {
            if (seq !== F.seq || auth && auth !== familyToken()) return;
            F.busy = false;
            if (res.error) { if (res.verificationUnavailable) F.verificationInvalid = true; if (res.familyAuthRequired) familyClear(); F.error = res.error; familyRender(); return; }
            success(res); familyRender();
          }).catch(function () { if (seq !== F.seq || auth && auth !== familyToken()) return; F.busy = false; F.error = "通信に失敗しました。通信状態を確認して再試行してください。"; familyRender(); });
        }
        var familyCalendarMonth = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
        familyCalendarMonth.setDate(1);
        var familyCalendarDay = '';
        function renderFamilyCalendar() {
          var y=familyCalendarMonth.getFullYear(), m=familyCalendarMonth.getMonth(), month=y+'-'+pad(m+1), items=[];
          var children=familyVisibleChildren(), loading=children.some(function(c){return !F.childrenData[c.studentId];});
          children.forEach(function(c){(F.childrenData[c.studentId] && F.childrenData[c.studentId].upcoming || []).forEach(function(slot){
            if(slot.status==='booked'||slot.status==='offered') items.push({slot:slot,name:c.name});
          });});
          items.sort(function(a,b){return (a.slot.date+a.slot.start+a.name).localeCompare(b.slot.date+b.slot.start+b.name);});
          var h='<section aria-label="子どもの予定カレンダー"><h2>予定カレンダー</h2><div class="card cal"><div class="calhead"><button class="btn-quiet btn-sm" data-action="fa-calprev" aria-label="前の月">◀</button><strong>'+y+'年'+(m+1)+'月</strong><button class="btn-quiet btn-sm" data-action="fa-calnext" aria-label="次の月">▶</button></div><div class="calgrid">';
          WD.forEach(function(w){h+='<span class="calwd">'+w+'</span>';});
          for(var blank=0;blank<new Date(y,m,1).getDay();blank++)h+='<span></span>';
          for(var day=1;day<=new Date(y,m+1,0).getDate();day++){
            var date=month+'-'+pad(day), rows=items.filter(function(x){return x.slot.date===date;});
            h+='<button class="calday'+(familyCalendarDay===date?' sel':'')+'" data-action="fa-calday" data-date="'+date+'" aria-label="'+date+' '+rows.length+'件" aria-pressed="'+(familyCalendarDay===date)+'"><span>'+day+'</span>';
            rows.forEach(function(x){h+='<span style="background:'+(x.slot.status==='booked'?'#dce8ff':'#fff0d6')+';color:#19212a;border-radius:3px;width:100%" class="callbl" title="'+esc(x.name+' '+x.slot.start+' '+x.slot.subject)+'">'+esc(cT(x.slot.start)+' '+x.name+' '+(x.slot.subject||''))+'</span>';});h+='</button>';
          }
          h+='</div><p class="note">日付を押すと、その日の授業を確認できます。</p></div>';
          if(loading)h+='<p role="status">予定を読み込んでいます…</p>';
          var selected=familyCalendarDay && familyCalendarDay.slice(0,7)===month;
          var rows=items.filter(function(x){return selected?x.slot.date===familyCalendarDay:x.slot.date.slice(0,7)===month;});
          h+='<h2>'+(selected?fmtDateW(familyCalendarDay):'この月')+'の授業</h2><div class="card">';
          rows.forEach(function(x){var slot=x.slot;h+='<p><strong>'+esc(x.name)+'</strong> '+fmtDateW(slot.date)+' '+esc(slot.start)+'〜'+endTime(slot.start,slot.min)+' '+esc(slot.subject)+deliveryTag(slot)+' <span class="tag '+(slot.status==='booked'?'blue':'amber')+'">'+(slot.status==='booked'?'確定':'生徒の返事待ち')+'</span></p>';});
          h+=!rows.length&&!loading?'<p>今後の授業予定はありません。</p>':'';
          return h+'</div></section>';
        }
        function familyVisibleChildren() {
          return (F.home && F.home.children || []).filter(function(c){return !F.studentId || sameId(c.studentId,F.studentId);});
        }
        function familyLoadChild(id) {
          if (F.busy || !F.home) return;
          var list = F.home.children || [];
          if (id) list = (F.home.children || []).filter(function(c){return sameId(c.studentId,id);});
          F.confirm = null;
          list.forEach(function(c){delete F.childrenData[c.studentId];});
          function next(index) {
            if (!F.home) return;
            if(index >= list.length){loadFamilyNotices();return;}
            var child = list[index];
            familyRequest("familyData", {ftoken:familyToken(),studentId:child.studentId}, function(res){
              F.childrenData[child.studentId]=res.data;
              next(index+1);
            });
          }
          next(0);
        }
        function familyLoadHome() {
          if (F.busy || !familyToken()) return;
          if (ssGet("sw_ft_v1:logout")) { F.step = "logout"; familyRender(); return; }
          F.childrenData = Object.create(null); F.confirm = null; notices.items=[];
          familyRequest("familyHome", { ftoken: familyToken() }, function (res) { F.home = res; F.step = "home"; var list = res.children || []; if (!list.some(function(c){return sameId(c.studentId,F.studentId);})) F.studentId=""; familyLoadChild(); });
        }
        function familyLogout() {
          notices.items=[];notices.open=false;++notices.seq;notices.busy=false;
          if (F.busy) return;
          if (!familyToken()) { familyClear(); familyRender(); return; }
          F.home = null; F.childrenData = Object.create(null); F.confirm = null; F.step = "logout"; ssSet("sw_ft_v1:logout", "1");
          familyRequest("familyLogout", { ftoken: familyToken() }, function () { familyClear(); F.message = "ログアウトしました。"; });
        }
        function familyReadChallenge() {
          if (location.hash.indexOf("#family?") !== 0) return;
          var q = new URLSearchParams(location.hash.slice(8)), invite=q.get("invite"), mode=q.get("mode"), verify = q.get("verify"), reset = q.get("reset");
          if(invite){F.invite=invite;F.step='register';F.home=null;F.message='';}
          else if(['requestReset','resend'].indexOf(mode)>=0){F.step=mode;F.home=null;}
          F.challenge = verify || reset || ""; F.challengeKind = verify ? "verify" : reset ? "reset" : "";
          if (F.challenge) { ++F.seq; F.busy = false; F.home = null; F.childrenData = Object.create(null); F.step = F.challengeKind; F.verificationInfo = null; F.verificationInvalid = false; F.message = ""; F.error = ""; }
          history.replaceState(null, "", location.pathname + "#family");
          if (verify) { var pendingProof=F.challenge; Promise.resolve().then(function () { if (F.challenge===pendingProof && F.step==='verify' && route()==='family') familyLoadVerification(); }); }
        }
        function familyLoadVerification() {
          F.verificationInfo=null; F.verificationInvalid=false;
          familyRequest("familyVerificationInfo", {challenge:F.challenge}, function (res) { F.verificationInfo=res; });
        }
        function familyMailMessage(res) { return res.mailStatus === "limited" ? "送信間隔の制限中です。1分以上待ってお試しください。1時間に5回まで再送できます。" : res.mailStatus === "suppressed" ? "テストのため確認メールの送信を省略しました。" : res.mailStatus === "failed" ? "登録は保存しましたが確認メールを送れませんでした。「確認メールを再送」からお試しください。メール変更の場合は現在のメールでログインして変更をやり直せます。" : res.mailStatus === "uncertain" ? "確認メールの送信結果が不明です。まず受信箱と迷惑メールをご確認ください。届かない場合は少し待って再送してください。" : res.message || "確認メールの手続きを受け付けました。メール内のリンクを開いて手続きを進めてください。"; }
        function familySubmit() {
          if (F.busy || route() !== "family") return;
          var step = F.step, email = val("fa-email").toLowerCase(), passEl = document.getElementById("fa-pass"), pass2 = document.getElementById("fa-pass2"), inviteEl = document.getElementById("fa-invite");
          var pass = passEl ? passEl.value : "", confirmation = pass2 ? pass2.value : "";
          if (step !== "reset" && step !== "setPassword" && !email) { F.error = "メールアドレスを入力してください。"; familyRender(); return; }
          if (["login", "reset", "setPassword", "emailChange"].indexOf(step) >= 0 && (!pass || (step === "setPassword" || step === "reset") && (pass.length < 12 || pass.length > 128 || pass !== confirmation))) { F.error = "パスワードを確認してください。新しいパスワードは12〜128文字で、確認欄と同じ内容を入力してください。"; familyRender(); return; }
          var invite = inviteEl ? inviteEl.value.trim() : F.invite || "";
          if (step === "register" && !invite) { F.error = "先生から受け取った招待コードを入力してください。"; familyRender(); return; }
          F.email = email || F.email;
          if (step === "register") F.invite = invite;
          if (passEl) passEl.value = ""; if (pass2) pass2.value = ""; if (inviteEl) inviteEl.value = "";
          if (step === "register") familyRequest("familyRegister", { inviteCode: invite, email: email }, function (res) { F.invite=invite; F.step = "waiting"; F.message = familyMailMessage(res); });
          else if (step === "setPassword") familyRequest("familyCompleteRegistration", { challenge: F.challenge, pass: pass }, function (res) { F.challenge=""; F.invite=""; F.step="login"; F.email=res.email; F.message="登録が完了しました。ログインしています…"; familyRequest("familyLogin", { email:res.email, pass:pass }, familyAcceptLogin); });
          else if (step === "reset") { if (!F.challenge) { F.error = "メール内の再設定リンクを開いてください。"; familyRender(); return; } familyRequest("familyResetConfirm", { challenge: F.challenge, pass: pass }, function () { familyClear(); F.challenge = ""; F.challengeKind = ""; F.message = "パスワードを変更しました。メールアドレスでログインしてください。"; }); }
          else if (step === "requestReset") familyRequest("familyResetRequest", { email: email }, function (res) { F.message = res.message || "登録されている場合は、再設定のメールを送ります。"; });
          else if (step === "resend") familyRequest("familyResendVerification", { email: email }, function (res) { F.step="waiting"; F.message = familyMailMessage(res); });
          else if (step === "emailChange") familyRequest("familyEmailChange", { ftoken: familyToken(), email: email, pass: pass }, function (res) { familyClear(); F.message = familyMailMessage(res); });
          else familyRequest("familyLogin", { email: email, pass: pass }, familyAcceptLogin);
        }
        function familyAcceptLogin(res) {
            if (!res.ftoken) { F.error = "ログインを確認できませんでした。"; return; }
            ssSet("sw_ft_v1", res.ftoken); ssDel("sw_ft_v1:logout");
            if (familyToken() !== res.ftoken) { apiPost({ action: "familyLogout", ftoken: res.ftoken }).catch(function () {}); F.error = "このブラウザではログインを保持できません。セッション保存を許可してお試しください。"; return; }
            F.home = res; F.step = "home"; F.message = ""; F.challenge = ""; var children = res.children || []; F.studentId=""; F.childrenData=Object.create(null); if (children.length) familyLoadChild(); else loadFamilyNotices();
        }
        function renderFamily() {
          var dis = F.busy ? " disabled" : "", h = '';
          if (F.error) h += '<p class="parent-error" role="alert">' + esc(F.error) + '</p>';
          if (F.message) h += '<p class="card" role="status">' + esc(F.message) + '</p>';
          if (F.step === "logout" || ssGet("sw_ft_v1:logout")) { app.innerHTML = h + '<div class="card"><p>ログアウトを完了するにはサーバーの確認が必要です。</p><button class="btn-primary" data-action="fa-logout"' + dis + '>ログアウトを再試行</button></div>'; return; }
          if (F.step === "verify") {
            var info=F.verificationInfo;
            h += '<div class="card parent-auth">';
            if (F.verificationInvalid) h += '<h2>このリンクでは登録を続けられません</h2><p>メールに届いた最新のリンクを開いてください。期限が切れた場合は、認証メールをもう一度お申し込みください。メールアドレスを変更する手続きの場合は、保護者ページの設定からやり直してください。</p><button class="btn-quiet" data-action="fa-mode" data-step="resend">認証メールをもう一度受け取る</button>';
            else if (!info) h += '<p>' + (F.busy ? '登録するメールアドレスを確認しています…' : '通信状況をご確認のうえ、もう一度お試しください。') + '</p>' + (F.busy ? '' : '<button class="btn-primary" data-action="fa-verification-retry">もう一度読み込む</button>');
            else h += '<h2>メールアドレスを確認してください</h2><p><strong style="overflow-wrap:anywhere">' + esc(info.email) + '</strong></p><p>' + (info.registration ? 'このメールアドレスで保護者ページに登録します。' : '保護者ページで使うメールアドレスを、このアドレスに変更します。') + 'よろしければ、下のボタンを押してください。</p><button class="btn-primary" data-action="fa-verify"' + dis + '>' + (F.busy ? '認証しています…' : info.registration ? 'このメールアドレスで認証して次へ' : 'このメールアドレスで認証する') + '</button>' + (info.registration ? '<p class="note">次に、ログイン用のパスワードを設定します。</p>' : '');
            app.innerHTML=h+'</div>'; return;
          }
          if (F.step === "waiting") { app.innerHTML = h + '<div class="card"><h2>メールを開いて登録を続けてください</h2><p>送信先：' + esc(F.email) + '</p><p>入力したメールアドレスの受信箱を開き、ステップワイズから届いたメールのリンクを押してください。次にパスワードを設定します。メールが見当たらない場合は、迷惑メールフォルダもご確認ください。</p><button class="btn-quiet" data-action="fa-mode" data-step="resend"' + dis + '>確認メールを再送</button>' + (F.invite ? '<button class="btn-quiet" data-action="fa-mode" data-step="register"' + dis + '>メールアドレスを修正</button>' : '<p>アドレスを間違えた場合は、先生からの登録リンクを開き直してください。使えない場合は先生へご相談ください。</p>') + '</div>'; return; }
          if (F.home && F.step === "home") {
            if(notices.open)h+=renderFamilyNotices();
            if(parentSection()==='settings') h += '<p><button class="btn-quiet btn-sm" data-action="fa-logout"'+dis+'>ログアウト</button></p>';
            if(parentSection()==='settings') h += '<div class="card"><p>'+esc((F.home.family||{}).email)+'・メール確認済み</p><button class="btn-quiet btn-sm" data-action="fa-home"'+dis+'>家族情報を更新</button> <button class="btn-quiet btn-sm" data-action="fa-mode" data-step="emailChange"'+dis+'>メールアドレスを変更</button></div>';
            else if((F.home.children||[]).length>1) h += '<p><select id="fa-child" aria-label="子どもで絞り込む"'+dis+'><option value=""'+(!F.studentId?' selected':'')+'>全員</option>'+F.home.children.map(function(c){return '<option value="'+esc(c.studentId)+'"'+(sameId(c.studentId,F.studentId)?' selected':'')+'>'+esc(c.name)+'</option>';}).join('')+'</select></p>';
            if(parentSection()==='home'||parentSection()==='schedule')h += renderFamilyCalendar();
            if(parentSection()==='billing')h += window.StepwiseReport.invoices(F.home.billing,F.home.family.label);
            if (!(F.home.children || []).length) h += '<p>子どもの紐付けを先生にご依頼ください。</p>';
            if(F.confirm&&parentSection()==='billing'){
              var confirmation=F.confirm;
              h+='<div class="card" role="region" aria-label="授業計画の回答確認"><strong>'+esc((F.childrenData[confirmation.studentId]||{}).name)+'・'+esc(confirmation.ym)+'</strong>';
              if(confirmation.stage==='reduce'){
                h+='<p>承認できる回数を選んでください。0回の場合は今回は見送ります。</p>';
                confirmation.rows.forEach(function(r,index){h+='<p><label>'+esc(lessonLabel(r))+' <select id="fa-reduce-'+index+'">';for(var n=0;n<=r.count;n++)h+='<option value="'+n+'"'+(n===confirmation.approvedCounts[index].count?' selected':'')+'>'+n+'回</option>';h+='</select></label></p>';});
                h+='<label>先生への伝言（任意）<textarea id="fa-plan-message" maxlength="500">'+esc(confirmation.memo||'')+'</textarea></label><p><button class="btn-primary" data-action="fa-plan-review">この内容を確認する</button></p>';
              }else{
                h+='<p>'+confirmation.approvedCounts.map(function(r){return esc(lessonLabel(r))+' '+r.count+'回まで';}).join('、')+'</p>';
                h+=confirmation.approve?'<p>この回数以内で授業の計画を立てることができます。授業実施前であれば、いつでもシステムまたはLINEから計画の見直しを申し出ることができます。承認しますか？</p>':'<p>今回は見送ります。先生にこの内容を伝えますか？</p>';
                if(confirmation.memo)h+='<p>'+esc(confirmation.memo)+'</p>';
                h+='<button class="btn-primary" data-action="fa-decide"'+dis+'>'+(confirmation.approve?'承認する':'今回は見送る')+'</button> ';
              }
              h+='<button class="btn-quiet" data-action="fa-cancel"'+dis+'>戻る</button></div>';
            }
            if(parentSection()!=='settings') familyVisibleChildren().forEach(function(c,index){
              h += '<section id="family-child-'+index+'" data-family-child="'+esc(c.studentId)+'"><h2>'+esc(c.name)+'</h2>';
              h += F.childrenData[c.studentId] ? renderParent(F.childrenData[c.studentId],true,c.studentId) : F.busy ? '<p>読み込んでいます…</p>' : '<button class="btn-quiet" data-action="fa-refresh" data-child="'+esc(c.studentId)+'">子どもの情報を再読み込み</button>';
              h += '</section>';
            });
            app.innerHTML = h; return;
          }
          if (familyToken() && F.step === "login") { app.innerHTML = h + '<div class="card"><button class="btn-primary" data-action="fa-home"' + dis + '>家族ページを開く</button> <button class="btn-quiet" data-action="fa-logout"' + dis + '>ログアウト</button></div>'; return; }
          var step = F.step, newPass = step === "setPassword" || step === "reset";
          var titles = { login: 'ログイン', register: '保護者ページで使うメールアドレスを入力してください', requestReset: 'パスワードを忘れた方', resend: '確認メールを再送', setPassword: 'パスワードを設定して登録完了', reset: '新しいパスワード', emailChange: 'メールアドレスを変更' };
          h += '<div class="card parent-auth"><h2>' + esc(titles[step] || titles.login) + '</h2><form id="family-auth-form">';
          if (step === "register") h += (F.invite ? '<p>このメールアドレスを、ログインと教室からの連絡に使います。</p><input type="hidden" id="fa-invite" value="' + esc(F.invite) + '">' : '<label for="fa-invite">先生から受け取った招待コード</label><input id="fa-invite" autocomplete="off" required' + dis + '>');
          if (step === "setPassword") h += '<p>メール確認済み：' + esc(F.email) + '</p>';
          if (step !== "reset" && step !== "setPassword") h += '<label for="fa-email">' + (step === "emailChange" ? '新しいメールアドレス' : step === "register" ? '登録するメールアドレス' : 'メールアドレス') + '</label><input type="email" id="fa-email" autocomplete="email" value="' + esc(F.email) + '" required' + dis + '>';
          if (["login", "reset", "setPassword", "emailChange"].indexOf(step) >= 0) h += '<label for="fa-pass">' + (newPass ? '新しい保護者用パスワード（12〜128文字）' : '保護者用パスワード') + '</label><input type="password" id="fa-pass" autocomplete="' + (newPass ? 'new-password' : 'current-password') + '" maxlength="128"' + (newPass ? ' minlength="12"' : '') + ' required' + dis + '>';
          if (newPass) h += '<label for="fa-pass2">新しいパスワード（確認）</label><input type="password" id="fa-pass2" autocomplete="new-password" minlength="12" maxlength="128" required' + dis + '>';
          if (step === 'resend') h += '<p class="note">登録途中のメールアドレスを入力してください。パスワードは不要です。届いたリンクから登録を再開できます。</p>';
          if (step === 'register') h += '<p class="note">入力したアドレスに認証メールを送ります。届いたメールのリンクを開き、パスワードを設定すると登録完了です。</p>';
          if (step === 'emailChange') h += '<p class="note">変更手続きでログアウトします。新しいメールの確認が完了するまで、登録先は現在のメールのままです。</p>';
          h += '<div class="row"><button type="submit" class="btn-primary"' + dis + '>' + (F.busy ? (['register','resend','requestReset','emailChange'].indexOf(step)>=0 ? 'メールを送信しています…' : '確認中…') : step === 'login' ? 'ログイン' : step === 'setPassword' ? 'パスワードを設定して利用開始' : step === 'reset' ? 'パスワードを変更する' : step === 'emailChange' ? '確認メールを送りログアウトする' : step === 'requestReset' ? 'パスワード再設定メールを送信する' : step === 'resend' ? '認証メールをもう一度送信する' : '認証メールを送信する') + '</button></div></form><div class="row" style="margin-top:16px">' + (step === 'login' ? [['requestReset', 'パスワードを忘れた方']] : step === 'setPassword' ? (F.error ? [['resend', '確認メールを再送']] : []) : [[F.home ? 'home' : 'login', F.home ? '家族ページに戻る' : 'ログインに戻る']]).map(function (x) { return '<button class="btn-quiet btn-sm" data-action="fa-mode" data-step="' + x[0] + '"' + dis + '>' + x[1] + '</button>'; }).join('') + '</div></div><p class="note">共用端末では、利用後にログアウトしてください。</p>';
          app.innerHTML = h;
        }
        function familyClick(action, btn) {
          if (route() !== "family") return;
          if(["fa-notices","fa-notice-refresh","fa-notice-open"].indexOf(action)>=0){familyNoticeClick(action,btn);return;}
          if(action==='fa-calprev'||action==='fa-calnext'){familyCalendarMonth.setMonth(familyCalendarMonth.getMonth()+(action==='fa-calnext'?1:-1));familyCalendarDay='';familyRender();return;}
          if(action==='fa-calday'){familyCalendarDay=btn.getAttribute('data-date');familyRender();return;}
          if (F.busy) return;
          if (action === "fa-home") familyLoadHome();
          else if (action === "fa-refresh") familyLoadChild(btn.getAttribute("data-child") || F.studentId);
          else if (action === "fa-logout") familyLogout();
          else if (action === "fa-mode") { F.step = btn.getAttribute("data-step"); F.error = ""; F.message = ""; F.confirm = null; if (F.step === 'emailChange') F.email = ''; familyRender(); }
          else if (action === "fa-verification-retry" && F.challenge) familyLoadVerification();
          else if (action === "fa-verify" && F.challenge && F.verificationInfo) familyRequest("familyVerify", { challenge: F.challenge }, function (res) { if (res.passwordRequired) { F.step="setPassword"; F.email=res.email; F.message="メールアドレスを確認しました。パスワードを設定すると登録完了です。"; } else { familyClear(); F.challenge = ""; F.challengeKind = ""; F.message = "メールアドレスを確認しました。ログインしてください。"; } });
          else if (action === "fa-planok" || action === "fa-planng") {
            var childId=btn.getAttribute("data-child"), childData=F.childrenData[childId], ym = btn.getAttribute("data-ym"), m = (childData && childData.planMonths || []).filter(function (x) { return x.ym === ym; })[0];
            if (!m || m.status !== 'proposed' || !m.termsKnown || !Number.isSafeInteger(m.revision)) { F.error = '最新の提案を確認してください。'; familyRender(); return; }
            F.confirm={studentId:childId,ym:ym,approve:action==='fa-planok',expectedRevision:m.revision,memo:'',stage:action==='fa-planok'?'review':'reduce',rows:m.rows,approvedCounts:m.rows.map(function(r){return {subject:r.subject,kind:r.kind,count:action==='fa-planok'?Number(r.count):Math.max(0,Number(r.count)-1)};})};familyRender();
          } else if(action==='fa-plan-review'&&F.confirm&&F.confirm.stage==='reduce'){
            var c=F.confirm,selected=c.rows.map(function(r,index){return {subject:r.subject,kind:r.kind,count:Number(val('fa-reduce-'+index))};});
            c.approvedCounts=selected;c.memo=val('fa-plan-message');
            if(selected.some(function(r,i){return !Number.isInteger(r.count)||r.count<0||r.count>Number(c.rows[i].count);})||!selected.some(function(r,i){return r.count<Number(c.rows[i].count);})){F.error='案内より少ない回数を選んでください。';familyRender();return;}
            c.approvedCounts=selected;c.approve=selected.some(function(r){return r.count>0;});c.memo=val('fa-plan-message');c.stage='review';F.error='';familyRender();
          } else if (action === "fa-cancel") { F.confirm = null; familyRender(); }
          else if (action === "fa-decide" && F.confirm && (F.home.children||[]).some(function(c){return sameId(c.studentId,F.confirm.studentId);})) {
            var confirmation = F.confirm;
            familyRequest("familyPlanDecide", {ftoken:familyToken(),studentId:confirmation.studentId,ym:confirmation.ym,approve:confirmation.approve,expectedRevision:confirmation.expectedRevision,memo:confirmation.memo,approvedCounts:confirmation.approvedCounts}, function (res) { F.confirm = null; F.childrenData[confirmation.studentId] = res.data; delete F.memos[confirmation.studentId + ':' + confirmation.ym]; F.message = res.notificationWarning || (confirmation.approve ? '承認しました。' : '先生に相談を伝えました。'); loadFamilyNotices(); });
          }
        }

        var familyPanels=Object.create(null);
        function renderFamilyPanels() {
          var active=Object.create(null), section=parentSection();
          (F.home.children||[]).forEach(function(c){active[JSON.stringify([familyToken(),c.studentId])]=true;});
          Object.keys(familyPanels).forEach(function(key){familyPanels[key].reads.clear();});
          familyVisibleChildren().forEach(function(c,index){
            var host=document.getElementById('family-child-'+index);
            if(!host || !F.childrenData[c.studentId])return;
            var key=JSON.stringify([familyToken(),c.studentId]);active[key]=true;
            var panel=familyPanels[key] || (familyPanels[key]={services:window.StepwiseServices.create(),reads:window.StepwiseLessonRead.create()});
            var token=familyToken(); var call=function(op,payload){return apiPost(Object.assign({},payload,{ftoken:token,studentId:c.studentId,action:'learningService',op:op}));};
            if(section==='records')panel.reads.mount(host,call,key);else panel.reads.clear();
            if(['contacts','grades','schedule'].indexOf(section)>=0)panel.services.mount(host,{key:key,teacher:false,panel:section==='grades'?'exams':section==='schedule'?'cancel':'messages',call:call});
          });
          Object.keys(familyPanels).forEach(function(key){if(!active[key]){familyPanels[key].services.clear();familyPanels[key].reads.clear();}});
        }
        function loadFamilyNotices(action,id,done){
          if(notices.busy||!familyToken()||!F.home)return;
          var token=familyToken(),seq=++notices.seq;notices.busy=true;notices.error='';familyRender();
          apiPost({action:action||'familyNotices',ftoken:token,noticeId:id}).then(function(r){
            if(seq!==notices.seq||token!==familyToken())return;
            notices.busy=false;
            if(r.error){if(r.familyAuthRequired)familyClear();notices.error=r.error;familyRender();return;}
            notices.items=r.notices||[];if(done)done();familyRender();
          }).catch(function(){if(seq!==notices.seq||token!==familyToken())return;notices.busy=false;notices.error='通知を読み込めませんでした。再試行してください。';familyRender();});
        }
        function renderFamilyNotices(){
          var h='<section class="card" id="family-notices" aria-label="通知"><div class="row between"><h2>お知らせ</h2><button class="btn-quiet btn-sm" data-action="fa-notices">閉じる</button></div><p class="note">既読になっても、必要な承認やお支払いは完了しません。</p><button class="btn-quiet btn-sm" data-action="fa-notice-refresh"'+(notices.busy?' disabled':'')+'>最新のお知らせを確認</button>';
          if(notices.busy)h+='<p role="status">確認しています…</p>';
          if(notices.error)h+='<p role="alert">'+esc(notices.error)+'</p>';
          notices.items.forEach(function(n){h+='<p><button class="btn-quiet" style="text-align:left;width:100%" data-action="fa-notice-open" data-notice="'+esc(n.id)+'"'+(notices.busy?' disabled':'')+'><span class="tag '+(n.required?'red':n.read?'gray':'blue')+'">'+(n.required?'要対応':n.read?'既読':'未読')+'</span> '+esc(n.name)+'<br>'+esc(n.title)+(n.required&&n.read?'（確認済み・未対応）':'')+'</button></p>';});
          if(!notices.items.length&&!notices.busy&&!notices.error)h+='<p>お知らせはありません。</p>';
          return h+'</section>';
        }
        function familyNoticeClick(action,btn){
          if(action==='fa-notices'){notices.open=!notices.open;familyRender();return;}
          if(action==='fa-notice-refresh'){loadFamilyNotices();return;}
          if(action==='fa-notice-open'){
            var n=notices.items.filter(function(n){return n.id===btn.getAttribute('data-notice');})[0];if(!n)return;
            loadFamilyNotices('familyNoticeRead',n.id,function(){F.studentId=n.studentId;F.confirm=null;notices.open=false;location.hash='#family/'+n.section;});
          }
        }
        var studentNoticesOpen=false;
        function studentNoticeItems(){
          if(!S||!S.me)return [];
          var items=[];
          (S.slots||[]).filter(function(x){return x.st==='offer';}).forEach(function(x){items.push({title:'授業の案内：'+fmtDateW(x.date)+' '+x.start+' '+(x.subject||''),url:'#home',required:true});});
          (S.lessonRecords||[]).slice(0,5).forEach(function(x){items.push({title:'授業の記録：'+fmtDateW(x.date)+' '+(x.subject||''),url:'#history'});});
          return items;
        }
        function studentNoticesHTML(){var items=studentNoticeItems();return '<section class="card" aria-label="生徒のお知らせ" style="margin-bottom:18px"><div class="row between"><h2 style="margin:0">お知らせ</h2><button class="btn-quiet btn-sm" data-action="student-notices">閉じる</button></div>'+ (items.length?items.map(function(x){return '<p>'+(x.required?'<span class="tag amber">要確認</span> ':'')+'<a href="'+x.url+'" data-action="student-notice-link">'+esc(x.title)+'</a></p>';}).join(''):'<p class="muted">お知らせはありません。</p>')+'</section>';}
        var parentHeaderActions=document.getElementById('parent-header-actions');
        if(parentHeaderActions)parentHeaderActions.addEventListener('click',function(ev){var btn=ev.target.closest('[data-action]');if(!btn)return;if(btn.getAttribute('data-action')==='student-notices'){studentNoticesOpen=!studentNoticesOpen;render();}else if(btn.getAttribute('data-action')==='fa-notices')familyNoticeClick('fa-notices',btn);});
        function render() {
          if(parentHeaderActions){var count=notices.items.filter(function(n){return n.required||!n.read;}).length;parentHeaderActions.innerHTML=route()==='family'&&F.home&&familyToken()?'<button class="btn-quiet btn-sm" data-action="fa-notices" aria-label="お知らせ '+count+'件" aria-expanded="'+notices.open+'"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'+(count?' <span class="tag red">'+count+'</span>':'')+(notices.error?' !':'')+'</button>':'';}
          if(parentHeaderActions&&route()!=='family'&&S&&S.me){var required=studentNoticeItems().filter(function(x){return x.required;}).length;parentHeaderActions.innerHTML='<button class="btn-quiet btn-sm" data-action="student-notices" aria-label="お知らせ 要確認'+required+'件" aria-expanded="'+studentNoticesOpen+'"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'+(required?' <span class="tag red">'+required+'</span>':'')+'</button>';}
          renderStudent(); if(studentNoticesOpen&&route()!=='family'&&S&&S.me)app.innerHTML=studentNoticesHTML()+app.innerHTML;
          if(!window.StepwiseServices)return;
          if(route()==='family' && F.home && F.step==='home') { renderFamilyPanels(); return; }
          Object.keys(familyPanels).forEach(function(key){familyPanels[key].services.clear();familyPanels[key].reads.clear();});
          var page=route(),auth=null;
          if(!previewK){
            if(page==='parent'&&parentStep==='data'&&P)auth={k:myKey(),ptoken:ssGet(parentSessionKey(myKey()))};
            else if(page==='student-email'&&S&&S.me)auth={k:myKey()}; // 成績票・振り返り・先生への連絡は「設定」タブにだけ出す(2026-09-11)
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
          if(act==='student-notices'){studentNoticesOpen=!studentNoticesOpen;render();return;}
          if(act==='student-notice-link'){studentNoticesOpen=false;render();return;}
          if(act==='approval-help'){var help=document.getElementById(btn.getAttribute('aria-controls'));if(help){help.hidden=!help.hidden;btn.setAttribute('aria-expanded',String(!help.hidden));}return;}
          if (act.indexOf("fa-") === 0) { ev.preventDefault(); familyClick(act, btn); return; }
          if (act === 'nl-item') return;
          if (act.indexOf('nl-') === 0) { ev.preventDefault(); if (act === 'nl-parse') nlParse(); else if (act === 'nl-clear') { NL.text = ''; NL.proposal = null; NL.error = ''; render(); } else if (act === 'nl-register') nlRegister(); return; }
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
            case "histopen": histFolder = btn.getAttribute("data-folder"); render(); window.scrollTo(0, 0); break;
            case "helptoff": helpToff = !helpToff; render(); break;
            case "histback": histFolder = null; render(); break;
            case "dayadd": dayAddOpen=!dayAddOpen;render();break;
            case "calday":
              dayAddOpen=false;
              if (selMode) { var nd = btn.getAttribute("data-date"); selDays[nd] = !selDays[nd]; render(); break; }
              selDate = btn.getAttribute("data-date"); selManual = true; pending = null; render(); break;
            case "dayact":
              selMode = btn.getAttribute("data-m"); panel = selMode; selDays = {}; selDays[btn.getAttribute("data-date")] = true; pending = null; dayAddOpen=false; render();
              var calEl2 = document.querySelector(route() === "home" ? ".selbar" : ".cal"); if (calEl2) calEl2.scrollIntoView({ behavior: "smooth", block: "start" });
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
                { var bwe = val("b-wend"); if (!bwe || bws >= bwe) { toast("時間帯は「開始 < 終了」で入れてください"); return; } body.end = bwe; }
                body.deliveryMode=val('b-wmode');studentAction(body, '授業可能日時を登録しました', function(){selMode='';selDays={};});
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
              studentAction({ action: "cancelReq", slotId: pending.slotId, requestId:pending.requestId, k: myKey(), reason: reason }, "キャンセル申請を受け付けました"); break;
            case "askwithdraw": pending = { kind: "withdraw", slotId: id }; render(); break;
            case "dowithdraw": studentAction({ action: "cancelReq", withdraw: true, slotId: pending.slotId, k: myKey() }, "依頼を取り下げました"); break;
            case "delwish": { var dw = (S.wishes || []).filter(function (w) { return String(w.id) === String(id); })[0]; pending = { kind: "remove", verb: "取り消す", text: "授業できる時間帯" + (dw ? " " + fmtDateW(dw.date) + " " + esc(dw.start) + "〜" + esc(dw.end) : "") + " の登録を取り消しますか?", body: { action: "unwish", k: myKey(), wishId: id }, ok: "授業可能日時を取り消しました" }; render(); break; }
            case "delevent": { var de = (S.events || []).filter(function (e) { return String(e.id) === String(id); })[0]; pending = { kind: "remove", verb: "削除する", text: "重要な予定" + (de ? "「" + esc(de.title) + "」（" + fmtDateW(de.date) + (de.dateTo && de.dateTo !== de.date ? "〜" + fmtDateW(de.dateTo) : "") + "）" : "") + " を削除しますか?", body: { action: "eventDel", k: myKey(), eventId: id }, ok: "予定を取り消しました" }; render(); break; }
            case "doremove": if (pending && pending.kind === "remove") studentAction(pending.body, pending.ok); break;
            case "taskadd":
              var tt = val("f-ttitle"), ty = val("f-ttype"), dm = val("f-tdue-mode"), td = dm === 'date' ? val("f-tdue") : '', ds = dm === 'nextLesson' ? val("f-tdue-subject") : '', taskKey = myKey();
              if (!tt) { toast("内容を入れてください"); return; }
              if (['date','nextLesson','none'].indexOf(dm) < 0) { toast('期限の種類を選んでください'); return; }
              if (dm === 'date' && !td) { toast('期限の日付を入れてください'); return; }
              if (dm === 'nextLesson' && !ds) { toast('期限にする授業の科目を入れてください'); return; }
              studentAction({ action: "taskAdd", k: taskKey, type: ty, title: tt, due: td, dueMode: dm, dueSubject: ds }, "追加しました", function () { delete taskDrafts[taskKey]; }); break;
            case "taskdel": studentAction({ action: "taskDel", k: myKey(), taskId: id }, "削除しました"); break;
            case "delblock": {
              var sids = btn.getAttribute("data-ids"), bids = sids ? sids.split(",") : [id], db = (S.blocked || []).filter(function (b) { return String(b.id) === String(bids[0]); })[0];
              pending = { kind: "remove", verb: "解除する", text: "授業できない日" + (db ? " " + fmtDateW(db.date) + (db.start ? " " + esc(db.start) + "〜" + esc(db.end) : "（終日）") : "") + " を解除しますか?<br><span class='small muted'>解除すると、この日時にも授業の案内が来るようになります。</span>", body: { action: "unblock", k: myKey(), blockIds: bids }, ok: "解除しました" }; render(); break; }
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

        app.addEventListener("toggle", function (ev) { var d = ev.target, key = d && d.getAttribute ? d.getAttribute("data-fold") : null; if (key && (Object.prototype.hasOwnProperty.call(folds, key) || key.indexOf('hist:') === 0)) folds[key] = !!d.open; }, true);
        app.addEventListener("change", function (ev) {
          var el = ev.target;
          if (el && el.id === "fa-child") { if(F.busy)return; F.studentId=el.value; F.confirm=null; familyRender(); return; }
          if (taskDraftInput(el)) { if (el.id === 'f-tdue-mode') render(); return; }
          if (el && el.getAttribute("data-accept-id")) { var b = acceptBatch(); if (!b.pending && !b.busy && !b.refreshRequired) { b.selected[el.getAttribute("data-accept-id")] = el.checked; b.review = null; render(); } return; }
          if (el && el.getAttribute("data-action") === "nl-item") { var nlIt = NL.proposal && NL.proposal.items[+el.getAttribute('data-i')]; if (nlIt && !nlIt.done) nlIt.sel = !!el.checked; return; }
          if (el && el.getAttribute("data-action") === "se-pref") { studentEmailPrefSend(el.getAttribute("data-kind"), !!el.checked); return; }
          if (!el || el.getAttribute("data-action") !== "taskdone") return;
          studentAction({ action: "taskDone", k: myKey(), taskId: el.getAttribute("data-id"), done: el.checked }, el.checked ? "できた! ✓" : "未完了に戻しました");
        });

        app.addEventListener("input", function (ev) { if (taskDraftInput(ev.target)) return; var ym = ev.target && ev.target.getAttribute("data-parent-plan-memo"); if (ym) { if (route() === 'family') { F.memos[ev.target.getAttribute('data-child') + ':' + ym] = ev.target.value; F.confirm = null; } else parentPlanMemos[myKey() + ":" + ym] = ev.target.value; } if (ev.target && ev.target.id === 'fa-email') F.email = ev.target.value; if (ev.target && ev.target.id === 'se-email') SE.email = ev.target.value; if (ev.target && ev.target.id === 'nl-text') NL.text = ev.target.value; });

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
        window.addEventListener("hashchange", function () { pending = null; selMode = ""; selDays = {}; histFolder = null; familyReadChallenge(); studentEmailReadChallenge(); if (route() === 'family') { render(); if (!F.challenge && !F.home && F.step==='login' && familyToken()) familyLoadHome(); } else if (route() === 'student-email' && SE.challenge) render(); else if (!S) loadState().catch(function () { toast('読み込めませんでした'); }); else render(); window.scrollTo(0, 0); });
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
        if (route() === 'family') { render(); if (!F.challenge && F.step==='login' && familyToken()) familyLoadHome(); }
        else if (route() === 'student-email' && SE.challenge) render();
        else loadState().catch(function () { app.innerHTML = '<div class="loading">読み込みに失敗しました。<br>電波の良いところで再読み込みしてください。</div>'; });
      })();
