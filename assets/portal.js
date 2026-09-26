
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
        var dayInputMode = 'manual'; // 共通見出しの＋は手動、AIアイコンは文章入力だけ
        var calNow = new Date(), calY = calNow.getFullYear(), calM = calNow.getMonth();
        var panel = "";          // "" | "wish" | "event" | "ng"
        var wishKind = "ok";   // 生徒の登録は授業可能時間帯に統一
        var selMode = "", selDays = {}; // 予定表で日付を選択中のモード("" | "ng" | "wish" | "event") と選んだ日付
        // 先生のプレビュー(2026-09-20): /yoyaku/?preview=student:<生徒ID>#home か ?preview=parent:<生徒ID>#family/home。
        // 同じオリジンの管理画面のログイン(localStorage sw_admt)を使って表示だけ取り出す。登録・変更の送信はすべて止める
        var PREVIEW = (function () { try { var m = /^(student|parent):([\w-]+)$/.exec(new URLSearchParams(location.search).get('preview') || ''); return m ? { view: m[1], studentId: m[2] } : null; } catch (e) { return null; } })();
        var previewK = PREVIEW ? 'preview' : null; // 旧プレビューURL(k 形式)は受け付けない
        var parentStep = "pass"; // "pass" | "setup" | "data" | "logout"
        var parentNotice = "";
        var parentPlanMemos = Object.create(null), parentPlanNotice = "";
        var P = null;            // 保護者向けデータ
        var gradeMode = "score", examMode = "dev";
        var G = null, GX = [], gLoading = false; // 成績・模試(成績タブで初回に取得)
        var tabs = document.getElementById("tabs");
        function parentSection(){var part=((location.hash||'').split('/')[1]||'home').split('?')[0];if(part==='learning')return (location.hash.split('/')[2]||'')==='grades'?'grades':'records';if(part==='billing'||part==='contacts'||part==='plans')return 'menu';return ['home','tasks','records','grades','menu','settings'].indexOf(part)>=0?part:'home';} // 旧 mypage / schedule は home、旧 billing / contacts は menu 扱い
        // 保護者ページ: ホームは子どもの生徒ページ(マイページ)を共用し、実施状況の末尾に月の実施合計を表示。旧「予定」ページは削除済み(2026-09-11)。残りの旧ページも順次削る
        function parentNavigation(family){var prefix=family?'#family/':'#parent/';return [['home','ホーム'],['tasks','宿題'],['learning','学習記録'],['menu','保護者メニュー'],['settings','設定']].map(function(x){return '<a href="'+prefix+x[0]+'"'+((parentSection()===x[0]||x[0]==='learning'&&['records','grades'].indexOf(parentSection())>=0)?' class="on" aria-current="page"':'')+'>'+x[1]+'</a>';}).join('');}
        function route() { var h = location.hash || "#home"; if (location.pathname.indexOf('/hogosha')===0 || h === "#family" || h.indexOf("#family?") === 0 || h.indexOf('#family/')===0) return "family"; if(h === '#parent' || h.indexOf('#parent/')===0)return 'family'; if (h === "#student-email" || h.indexOf("#student-email?") === 0) return "student-email"; if (h === '#tasks' || h.indexOf('#tasks?') === 0) return 'tasks'; return { "#learning":"history", "#learning/records":"history", "#learning/grades":"grades", "#grades": "grades", "#history": "history", "#parent": "parent" }[h] || "home"; }
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
          var p = route();if(p==='grades')p='history';
          tabs.innerHTML = [["#home", "home", "ホーム"], ["#tasks", "tasks", "宿題"], ["#learning", "history", "学習記録"], ["#student-email", "student-email", "設定"]]
            .map(function (t) { return '<a href="' + t[0] + '" class="' + (p === t[1] ? "on" : "") + '"' + (p === t[1] ? ' aria-current="page"' : '') + '>' + t[2] + "</a>"; }).join("");
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
        function lessonLabel(s, full) { if (!s) return ""; var k = String(s.kind || (full ? "通常" : "")); return String(s.subject || "") + (k && (full || k !== "通常") ? "（" + k + "）" : ""); } // 一覧では通常も表示
        function planName(r) { return String(r && r.subject || "") + "（" + (r && r.kind ? r.kind : "通常") + "）"; } // 授業計画では通常も明示
        function kindTag(kind) { return '<span class="tag gray">' + esc(kind || '通常') + '</span>'; }
        function planPeriod(l) { if (l && l.period) return l.period; var st = String(l && l.startDate || ""), en = String(l && l.endDate || ""); if (!st) return ""; function md(d) { return (+d.slice(5, 7)) + "/" + (+d.slice(8)); } return (+st.slice(0, 4)) + "/" + md(st) + "〜" + md(en); }
        function planShort(l) { var p = planPeriod(l), m = /^(\d+)年(\d+)月$/.exec(p); return m ? m[2] + "月" : p.replace(/^\d+\//, ""); } // 予定行用の短い期間: 9月 / 9/22〜10/5
        function planFee(l) { if (!l || !l.lessonMin) return ""; var fee = l.lessonFee != null ? Number(l.lessonFee) : Math.round((Number(l.rate30) || 0) * l.lessonMin / 30); return l.lessonMin + "分・1回 " + yen(fee); }
        function planLimit(l) { return l.status === "approved" && l.approvedCount != null ? Number(l.approvedCount) : Number(l.count) || 0; }
        function planCovers(l, date) { return !!date && date >= String(l.startDate || "") && date <= String(l.endDate || "\uffff"); }
        function endTime(start, min) { var p = start.split(":"); var t = (+p[0]) * 60 + (+p[1]) + (+min); return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60); }
        function addDaysStr(ds, n) { var p = ds.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
        function yen(n) { return (Number(n) || 0).toLocaleString() + "円"; }
        function deliveryLabel(mode) { return mode === "in_person" ? "対面" : mode === "online" ? "オンライン" : "形式は先生に確認"; }
        /* ---------- アプリの通知（プッシュ） ---------- */
        // 端末に通知を出すには、常駐プログラム（sw.js）と端末ごとの登録が要る。
        // 本文は端末の鍵で暗号化して送られるので、中継する配信サービスは中身を読めない。
        // iPhone では、ホーム画面に追加したアプリからでないと受け取れない。
        var PUSH = { supported: false, ready: false, enabled: false, busy: false, message: '', publicKey: '', denied: false };

        function pushSupported() {
          try { return !!(navigator.serviceWorker && window.PushManager && window.Notification); } catch (e) { return false; }
        }
        function pushKeyBytes(value) {
          var s = String(value).replace(/-/g, '+').replace(/_/g, '/');
          var bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
          var out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        function pushAuth() { return route() === 'family' ? { ftoken: familyToken() } : { k: myKey() }; }
        function pushScope() { return route() === 'family' ? '/hogosha/' : '/yoyaku/'; }

        function pushBoot() {
          if (!pushSupported() || previewK) return;
          PUSH.supported = true;
          PUSH.denied = window.Notification.permission === 'denied';
          navigator.serviceWorker.register(pushScope() + 'sw.js', { scope: pushScope() })
            .then(function (reg) { return reg.pushManager.getSubscription(); })
            .then(function (sub) { PUSH.enabled = !!sub; return apiPost({ action: 'pushInfo' }); })
            .then(function (res) {
              PUSH.publicKey = (res && res.publicKey) || '';
              PUSH.ready = !!(res && res.enabled && PUSH.publicKey);
              render();
            })
            .catch(function () { PUSH.supported = false; });
        }

        function pushToggle() {
          if (PUSH.busy || !PUSH.ready) return;
          PUSH.busy = true; PUSH.message = ''; render();
          var done = function (message) { PUSH.busy = false; PUSH.message = message || ''; render(); };
          navigator.serviceWorker.register(pushScope() + 'sw.js', { scope: pushScope() }).then(function (reg) {
            if (PUSH.enabled) {
              return reg.pushManager.getSubscription().then(function (sub) {
                if (!sub) { PUSH.enabled = false; return done('通知を止めました'); }
                var body = Object.assign({ action: 'pushUnsubscribe', subscription: { endpoint: sub.endpoint, p256dh: 'x', auth: 'x' } }, pushAuth());
                var keys = pushKeysOf(sub); if (keys) body.subscription = Object.assign({ endpoint: sub.endpoint }, keys);
                return apiPost(body).then(function () { return sub.unsubscribe(); }).then(function () { PUSH.enabled = false; done('通知を止めました'); });
              });
            }
            return window.Notification.requestPermission().then(function (permission) {
              PUSH.denied = permission === 'denied';
              if (permission !== 'granted') return done('端末の設定で通知が許可されていません');
              return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(PUSH.publicKey) })
                .then(function (sub) {
                  var keys = pushKeysOf(sub);
                  if (!keys) return done('この端末では通知を登録できませんでした');
                  return apiPost(Object.assign({ action: 'pushSubscribe', subscription: Object.assign({ endpoint: sub.endpoint }, keys) }, pushAuth()))
                    .then(function (res) {
                      if (!res || res.error) { return sub.unsubscribe().then(function () { done((res && res.error) || '通知を登録できませんでした'); }); }
                      PUSH.enabled = true; done('通知を受け取ります');
                    });
                });
            });
          }).catch(function () { done('通知の設定を変更できませんでした'); });
        }
        function pushKeysOf(sub) {
          try {
            var json = sub.toJSON ? sub.toJSON() : null;
            var keys = json && json.keys;
            return keys && keys.p256dh && keys.auth ? { p256dh: keys.p256dh, auth: keys.auth } : null;
          } catch (e) { return null; }
        }

        function pushSection() {
          if (!PUSH.supported) return '<h2>アプリの通知</h2><p class="sub">この端末では通知を受け取れません。ホーム画面に追加したアプリから開くと受け取れることがあります。</p>';
          if (!PUSH.ready) return '';
          var h = '<h2>アプリの通知</h2><p class="sub">授業の案内などを、この端末の通知で受け取れます。メールと違って見落としにくくなります。</p><div class="card">';
          h += '<p>' + (PUSH.enabled ? 'この端末で通知を受け取ります。' : 'この端末では通知を受け取りません。') + '</p>';
          if (PUSH.denied && !PUSH.enabled) h += '<p class="note">端末の設定で通知が拒否されています。ブラウザまたは端末の設定から許可してください。</p>';
          h += '<button class="btn-' + (PUSH.enabled ? 'quiet' : 'primary') + '" data-action="pushtoggle"' + (PUSH.busy ? ' disabled' : '') + '>'
            + (PUSH.busy ? '変更しています…' : PUSH.enabled ? '通知を止める' : 'この端末で通知を受け取る') + '</button>';
          if (PUSH.message) h += '<p role="status" style="margin-top:8px">' + esc(PUSH.message) + '</p>';
          h += '<p class="note">iPhone では、ホーム画面に追加したアプリから開いたときだけ通知を受け取れます。</p>';
          return h + '</div>';
        }

        // Meet は授業を確定したあと Google 側で少し遅れて発行される。確定を止めて待つと
        // その待ち時間がそのまま利用者の待ち時間になるので、届くまでは「準備中」と出し、
        // 少し置いてもう一度読みに行く（読みに行くと Worker 側が取り直す）
        function meetWaiting(s) { return s.deliveryMode === 'online' && !s.meet; }
        function meetControl(s, primary) {
          if (s.meet) return '<a class="btn-' + (primary ? 'primary' : 'ghost') + ' btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(s.meet) + '">Meet' + (primary ? 'に参加' : '') + '</a>';
          if (!meetWaiting(s)) return '';
          return '<span class="small muted" data-meet-waiting="' + esc(s.id) + '" role="status">Meetのリンクを準備しています…</span>';
        }
        var meetTimer = null, meetTries = 0;
        function meetWatch() {
          if (meetTimer || meetTries >= 5 || route() === 'family') return;
          if (!((S && S.slots) || []).some(function (s) { return s.st === 'mine' && meetWaiting(s); })) { meetTries = 0; return; }
          meetTries++;
          meetTimer = setTimeout(function () { meetTimer = null; loadState().catch(function () {}); }, 6000);
        }
        function deliveryTag(s) { if (s.deliveryMode === 'in_person') return ''; return ' <span class="tag gray">' + deliveryLabel(s.deliveryMode) + '</span>'; }
        function slotSnapshot(s) { return { id: String(s.id), date: s.date, start: s.start, min: Number(s.min), subject: s.subject || '', deliveryMode: s.deliveryMode || '' }; }
        function taskDueText(t) {
          if (t.dueMode === 'nextLesson') return '次回の' + (t.dueSubject || '同じ科目の') + '授業' + (t.due ? '（' + fmtDY(t.due) + (t.dueStart ? ' ' + t.dueStart : '') + '）まで' : '（予定未定）');
          return t.due ? fmtDY(t.due) + 'まで' : '期限なし';
        }
        function taskDoneDate(value) {
          var s = String(value || '');
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDY(s);
          var d = new Date(s);
          return isNaN(d.getTime()) ? '' : d.toLocaleDateString('ja-JP', {timeZone:'Asia/Tokyo'});
        }
        var taskDrafts = Object.create(null), taskNotices = Object.create(null);
        function taskScopeKey() { var c = route() === 'family' && familyMypageChild(); return c ? 'family:' + familyToken() + ':' + c.studentId : 'student:' + myKey(); }
        function taskPageHref(filter) { return (route() === 'family' ? '#family/tasks' : '#tasks') + (filter && filter !== 'open' ? '?filter=' + filter : ''); }
        function taskFilter() { var f = new URLSearchParams((location.hash.split('?')[1] || '')).get('filter'); return ['open','done','all'].indexOf(f) >= 0 ? f : 'open'; }
        function visibleTasks() {
          return ((S && S.tasks) || []).filter(function (t) { return !t.withdrawn && !t.withdrawnAt; }).slice().sort(function (a,b) {
            return Number(!!a.done) - Number(!!b.done) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || String(a.dueStart || '').localeCompare(String(b.dueStart || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ja') || String(a.id).localeCompare(String(b.id));
          });
        }
        function taskFeedback() {
          var n = taskNotices[taskScopeKey()]; if (!n) return '';
          return '<div class="task-feedback' + (n.error ? ' parent-error' : '') + '" role="' + (n.error ? 'alert' : 'status') + '">' + esc(n.message) + (n.retry ? ' <button class="btn-quiet" data-action="taskretry"' + (busy || previewK ? ' disabled' : '') + '>同じ内容で再試行</button>' : '') + '</div>';
        }
        function renderTaskRows(tasks) {
          var dis = busy || previewK ? ' disabled' : '', today = S.today || '';
          return '<ul class="homework-list">' + tasks.map(function (t) {
            var status = t.reviewedAt ? '<span class="tag green">確認済み</span>' : t.done ? '<span class="tag amber">先生の確認待ち</span>' : t.due && today && t.due < today ? '<span class="tag amber">期限を過ぎています</span>' : t.due && t.due === today ? '<span class="tag amber">今日まで</span>' : '';
            var verb = t.done ? '申告を取り消す' : 'できた';
            return '<li class="homework-row' + (t.done ? ' is-done' : '') + '"><div class="homework-content"><div class="homework-meta"><span class="tag ' + (t.type === '持ち物' ? 'coral' : t.type === 'メモ' ? 'gray' : 'blue') + '">' + esc(t.type || '宿題') + '</span>' + status + (t.createdBy === 'teacher' ? '<span class="small muted">先生から</span>' : '') + '</div><strong class="homework-title">' + esc(t.title) + '</strong>' + (t.reviewNote ? '<p>先生から：' + esc(t.reviewNote) + '</p>' : '') + '<div class="homework-due">' + esc(taskDueText(t)) + (t.done && taskDoneDate(t.doneAt) ? '・' + esc(taskDoneDate(t.doneAt)) + ' に申告' : '') + '</div></div><div class="homework-actions"><button class="' + (t.done ? 'btn-quiet' : 'btn-ghost') + '" data-action="tasktoggle" data-id="' + esc(t.id) + '" data-done="' + (!t.done) + '" aria-label="' + esc(t.title + '：' + verb) + '"' + dis + (t.reviewedAt ? ' disabled' : '') + '>' + verb + '</button>' + (t.createdBy === 'student' && !t.done ? '<button class="btn-quiet btn-sm" data-action="taskdel" data-id="' + esc(t.id) + '" aria-label="' + esc(t.title + 'を削除') + '"' + dis + '>削除</button>' : '') + '</div></li>';
          }).join('') + '</ul>';
        }
        function renderHomeHomeworkTable(tasks) {
          var dis = busy || previewK ? ' disabled' : '', today = S.today || '';
          return '<table class="portal-plan-table home-homework-table"><colgroup><col style="width:10%"><col style="width:42%"><col style="width:12%"><col style="width:20%"><col style="width:16%"></colgroup><thead><tr><th scope="col">科目</th><th scope="col">内容</th><th scope="col">期日</th><th scope="col">残り期間</th><th scope="col">状態</th></tr></thead><tbody>' + tasks.map(function(t) {
            var due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '';
            var days = due && today ? Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) : NaN;
            var status = isNaN(days) ? '' : days > 0 ? 'あと' + days + '日' : days === 0 ? '今日まで' : -days + '日超過';
            var dueLabel = due ? Number(due.slice(5, 7)) + '/' + Number(due.slice(8, 10)) : t.dueMode === 'nextLesson' ? '予定未定' : '期限なし';
            var source = (S.lessonRecords || []).filter(function(r) { return t.sourceRecordId && String(r.recordId) === String(t.sourceRecordId); })[0];
            var subject = t.subject || (source && source.subject) || t.dueSubject || '—';
            return '<tr><td>' + esc(subject) + '</td><td>' + esc(t.title) + (t.reviewNote ? '<br><span class="small">先生から：' + esc(t.reviewNote) + '</span>' : '') + '</td><td>' + esc(dueLabel) + '</td><td>' + esc(status || '—') + '</td><td class="home-homework-status"><button type="button" class="tag amber" aria-haspopup="dialog" data-action="tasktoggle" data-id="' + esc(t.id) + '" data-done="true" aria-label="' + esc(t.title + '：完了にする') + '"' + dis + '>未完了</button></td></tr>';
          }).join('') + '</tbody></table>';
        }
        function renderTasksPage() {
          var filter = taskFilter(), tasks = visibleTasks(), open = tasks.filter(function (t) { return !t.done; }), done = tasks.filter(function (t) { return t.done; });
          var shown = filter === 'done' ? done : filter === 'all' ? tasks : open;
          var h = '<h1>宿題</h1><p class="sub">「できた」で先生に申告し、先生の確認で確認済みになります。</p>' + taskFeedback();
          h += '<nav class="homework-filters" aria-label="宿題の表示">' + [['open','未完了',open.length],['done','確認待ち・確認済み',done.length],['all','すべて',tasks.length]].map(function (x) { return '<a href="' + taskPageHref(x[0]) + '"' + (filter === x[0] ? ' class="on" aria-current="page"' : '') + '>' + x[1] + '<span class="cnt">' + x[2] + '</span></a>'; }).join('') + '</nav>';
          h += '<section class="card homework-panel" aria-label="宿題一覧">' + (shown.length ? renderTaskRows(shown) : '<p class="empty">' + (filter === 'done' ? '確認待ち・確認済みの宿題はありません。' : filter === 'all' ? '登録されている宿題・持ち物・メモはありません。' : '未完了の宿題・持ち物・メモはありません。') + '</p>') + '</section>';
          if (filter !== 'open') h += '<p class="note">完了済みは現在取得できた範囲を表示しています。過去の全履歴ではありません。</p>';
          h += '<p class="note">持ち物・自分用メモもここで確認できます。「できた」は本人の申告です。先生が確認すると正式な完了になります。</p>';
          if (previewK) h += '<p class="note">先生のプレビューでは表示のみです。完了・削除はできません。</p>';
          return h;
        }
        var homeworkReview = null;
        function mountHomeworkReview() {
          if (!homeworkReview) return;
          if (route() !== 'home' || homeworkReview.scope !== taskScopeKey()) { homeworkReview = null; return; }
          var t = visibleTasks().filter(function(t) { return String(t.id) === homeworkReview.id && !t.done; })[0];
          if (!t) { homeworkReview = null; return; }
          app.innerHTML += window.StepwiseCalendar.dayDialog({id:'homework-review-dialog',title:'宿題のできた報告',close:'homework-close',busy:busy,content:'<p>' + esc(t.title) + '</p><p>この宿題ができたことを先生に報告しますか？</p>' + taskFeedback() + '<button class="btn-primary" data-action="homework-confirm"' + (busy || previewK ? ' disabled' : '') + '>できたと報告</button>'});
          var d = document.getElementById('homework-review-dialog');
          if (d) { d.oncancel=function(e){if(busy)e.preventDefault();else homeworkReview=null;}; if(d.showModal&&!d.open)d.showModal(); }
        }
        function taskToggle(id, done) {
          if (busy || previewK) return;
          var task = visibleTasks().filter(function (t) { return String(t.id) === String(id); })[0];
          if (!task || task.reviewedAt) { toast('現在の宿題一覧を確認してください'); return; }
          studentAction({action:'taskDone',k:myKey(),taskId:id,done:done}, done ? '先生の確認待ちになりました' : '未完了に戻しました');
        }
        function taskDraft() {
          var k = taskScopeKey(), next = S && schedData().next;
          if (!taskDrafts[k]) taskDrafts[k] = { type:'宿題', title:'', dueMode:'nextLesson', due:next ? next.date : '', dueSubject:next ? next.subject || '' : '', open:false };
          return taskDrafts[k];
        }
        function taskDraftInput(el) {
          var field = { 'f-ttype':'type', 'f-ttitle':'title', 'f-tdue-mode':'dueMode', 'f-tdue':'due', 'f-tdue-subject':'dueSubject' }[el && el.id];
          if (!field) return false;
          var d = taskDraft(); d[field] = el.value; d.open = true; return true;
        }
        function renderTaskAdd() {
          var d = taskDraft(), dis = busy || previewK ? ' disabled' : '', subjects = [];
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
          var trackRead = !editable && !PREVIEW;
          var h = '<details class="card"' + (trackRead ? ' data-parent-record="' + esc(r.recordId) + '" data-record-revision="' + esc(r.revision) + '"' : '') + '><summary>' + (trackRead ? '<span data-read-label class="tag">確認中</span> ' : '') + fmtDateW(r.date) + ' ' + esc(r.start) + ' ' + esc(lessonLabel(r)) + (rep.actualUnit ? ' <span class="small muted">' + esc(rep.actualUnit) + '</span>' : '') + '</summary>';
          h += window.StepwiseReport.position(r.outline);
          h += window.StepwiseReport.body(r,!editable);
          if ((r.homework || []).length) h += '<h3>宿題</h3><ul>' + r.homework.map(function (x) { return '<li>' + (editable && x.taskId && !x.withdrawn && !x.reviewedAt ? '<input type="checkbox" aria-label="' + esc(x.title) + 'の完了" data-action="taskdone" data-id="' + esc(x.taskId) + '"' + (x.done ? ' checked' : '') + '>' : x.done ? '☑ ' : '□ ') + esc(x.title) + ' <span class="small muted">' + esc(taskDueText(Object.assign({ dueSubject: r.subject }, x))) + '</span></li>'; }).join('') + '</ul>';
          return h + '</details>';
        }

        var SE = { challenge:'', busy:false, message:'', error:'', email:'', removeConfirm:false, seq:0 };
        var NL = { text: '', busy: false, proposal: null, error: '' }; // 文章で予定を伝える
        var folds = { tasks: true, offers: false, plan: false, progress: false }; // ホームの折り畳み(やることリスト・授業登録・授業計画の案内)。開閉は再描画をまたいで保持
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
          var h = '<h1>設定</h1>'+ (S&&S.me?'<h2>資料</h2><div data-student-documents="'+esc(PREVIEW?PREVIEW.studentId:'')+'"></div>':'')+'<h2>メール通知</h2><p class="sub">授業の案内・変更・取消をメールで受け取れます。</p>', dis = SE.busy || previewK ? ' disabled' : '', s = S && S.emailStatus || {};
          if (previewK) h += '<p class="note">先生のプレビューでは確認のみできます。メールアドレスの登録・変更は生徒専用ページから行ってください。</p>';
          if (SE.error) h += '<p class="parent-error" role="alert">' + esc(SE.error) + '</p>';
          if (SE.message) h += '<p class="card" role="status">' + esc(SE.message) + '</p>';
          if (SE.challenge) { app.innerHTML = h + '<p>このメールアドレスで受信できることを確認します。</p><button class="btn-primary" data-action="se-verify"' + dis + '>メールアドレスを確認する</button> <button class="btn-quiet" data-action="se-back"' + dis + '>登録画面に戻る</button><p class="note">リンクは30分間有効です。期限が切れた場合は、元の生徒専用ページから確認メールを送り直してください。</p>'; return; }
          if (!S || !S.me) { app.innerHTML = h + '<p>登録・変更は、先生から届いた生徒専用リンクを開いて「設定」から行ってください。</p>'; return; }
          if(S.permissions&&S.permissions.email===false)dis=' disabled';
          h += '<div class="card"><p>' + (s.verified ? '通知先：' + esc(s.email) + '（確認済み）' : '確認済みの通知先はありません。') + '</p>';
          if (s.pendingEmail) h += '<p>確認待ち：' + esc(s.pendingEmail) + '</p>' + (!SE.message && ['failed','uncertain','suppressed'].indexOf(s.mailStatus) >= 0 ? '<p role="status">' + studentEmailMailMessage(s.mailStatus) + '</p>' : '') + '<button class="btn-quiet" data-action="se-resend"' + dis + '>確認メールを再送</button>';
          h += '<form id="student-email-form"><label for="se-email">自分のメールアドレス</label><input type="email" id="se-email" autocomplete="email" maxlength="254" required value="' + esc(SE.email || s.pendingEmail || s.email || '') + '"' + dis + '><p class="note">確認メールのリンクを開くと通知先になります。変更の確認が終わるまでは、現在の確認済みアドレスを使います。</p><button class="btn-primary" type="submit"' + dis + '>確認メールを送る</button></form>';
          if (s.email || s.pendingEmail) h += SE.removeConfirm ? '<p>メール通知を解除します。</p><button class="btn-quiet" data-action="se-remove"' + dis + '>解除する</button> <button class="btn-quiet" data-action="se-cancel"' + dis + '>やめる</button>' : '<p><button class="btn-quiet" data-action="se-askremove"' + dis + '>通知先を解除する</button></p>';
          h += '</div>';
          h += pushSection();
          dis=SE.busy||previewK?' disabled':'';
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

        /* ---------- 読み取りの振り分け ----------
           読み取りだけ Worker(D1) に向ける。速いが、まだ載っていない操作や失敗のときは
           そのまま Apps Script に回す(READ_API が空なら最初から回す＝今までどおり)。
           書き込みは常に Apps Script。Worker は台帳に書けない。 */
        var READ_API = "https://stepwise-api.stepwise-edu.workers.dev";
        // 保護者ページの読み取りも Worker へ。書き込みを伴うもの（familyNoticeRead・
        // メール設定・ログイン/登録）は入れない。
        var READ_ACTIONS = { state: 1, familyHome: 1, familyNotices: 1, familyData: 1, familyStudentState: 1 };
        var READ_ADMIN_OPS = { state: 1, kanriDashboard: 1, kanriStudent: 1, billingPreview: 1 };
        // 台帳の正本が Worker に移ったら true にする。書き込みも Worker へ送る
        var WRITE_TO_WORKER = true;
        function readable(body) {
          if (!READ_API || !body) return false;
          if (WRITE_TO_WORKER) return true;   // 正本が Worker なら全部そちら
          var a = String(body.action || "");
          if (READ_ACTIONS[a]) return true;
          return a === "admin" && !!READ_ADMIN_OPS[String(body.op || "")];
        }
        // Worker に投げる。引き受けない(501)・失敗・通信不能なら null を返し、呼び出し側が Apps Script に回す
        function readFirst(body) {
          if (!readable(body)) return Promise.resolve(null);
          return fetch(READ_API, { method: "POST", body: JSON.stringify(body) }).then(function (r) {
            if (r.status === 501) return null;
            if (!r.ok) return null;
            return r.json().then(function (res) { return res && res.errorCode === "workerError" ? null : res; });
          }).catch(function () { return null; });
        }
        function apiGet(params) {
          var pv = previewRoute(params); if (pv) return pv;
          var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
          var fallback = function () { return fetch(API + "?" + q).then(function (r) { return r.json(); }); };
          // 正本が Worker なら、そちらが全部を扱う（Apps Script は書き込みを断るので回り道は意味がない）
          if (WRITE_TO_WORKER && READ_API) return fetch(READ_API + "?" + q).then(function (r) { return r.json(); });
          if (!readable(params)) return fallback(); // 振り分けが無効なら今までと同じ経路のまま
          return readFirst(params).then(function (res) { return res === null ? fallback() : res; });
        }
        // 保護者ページの「マイページ」では、生徒本人用の送信(k 付き)を保護者のログイン(ftoken)＋子どもの ID に置き換えて送る。GAS 側で家族の紐付きを確認して子ども本人と同じ扱いにする
        // プレビュー中の送信: 表示に必要な読み取りだけを先生のログインで取り、それ以外(登録・変更)は送らずに断る
        function previewRoute(body) {
          if (!PREVIEW || !body) return null;
          var a = String(body.action || ''), tok = lsGet('sw_admt') || '';
          function go(view) { return fetch(WRITE_TO_WORKER && READ_API ? READ_API : API, { method: 'POST', body: JSON.stringify({ action: 'preview', token: tok, studentId: body.studentId || PREVIEW.studentId, familyStudentId: PREVIEW.view === 'parent' ? PREVIEW.studentId : undefined, view: view }) }).then(function (r) { return r.json(); }); }
          if (a === 'state' || a === 'familyStudentState') return go('student');
          if (a === 'familyData') return go('parent');
          if(a==='grades')return go('grades');
          if (a === 'familyHome') return go('home');
          if (a === 'familyNotices' || a === 'familyNoticeRead') return Promise.resolve({ ok: true, notices: [] });
          return Promise.resolve({ error: '先生のプレビューでは表示だけできます（登録・変更はできません）', preview: true });
        }
        function apiPost(body) {
          var pv = previewRoute(body); if (pv) return pv;
          var proxied = null, proxiedToken = '';
          if (route() === 'family' && F.home && body && body.k !== undefined && !body.ftoken) { var pc = familyMypageChild(); body = Object.assign({}, body); delete body.k; body.ftoken = familyToken(); body.studentId = pc ? pc.studentId : ''; proxied = pc ? pc.studentId : ''; proxiedToken = body.ftoken; }
          var sent = body;
          var fallback = function () { return fetch(API, { method: "POST", body: JSON.stringify(sent) }).then(function (r) { return r.json(); }); };
          var first = (WRITE_TO_WORKER && READ_API)
            ? fetch(READ_API, { method: "POST", body: JSON.stringify(sent) }).then(function (r) { return r.json(); })
            : (readable(sent) ? readFirst(sent).then(function (res) { return res === null ? fallback() : res; }) : fallback());
          return first.then(function (res) { if (proxied && F.home && proxiedToken === familyToken() && res && res.state && res.state.me) F.childState[proxied] = res.state; return res; });
        }
        function myKey() { var c = route() === "family" && familyMypageChild(); return c ? "family:" + c.studentId : previewK || lsGet("sw_k") || ""; }
        function parentSessionKey(k) { return "sw_pt_v2:" + (k === undefined ? myKey() : k); }
        function clearParentSession(k) {
          ssDel(parentSessionKey(k)); ssDel(parentSessionKey(k) + ":logout"); ssDel("sw_pt");
          if (k === undefined || k === myKey()) { P = null; parentStep = "pass"; }
        }
        function loadState() {
          if (route() === 'family') { var fc = familyMypageChild(); if (fc) familyLoadChildState(fc.studentId); return Promise.resolve(); }
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
          var actionKey = myKey(), actionScope = taskScopeKey(), familyAction = route() === 'family', taskWrite = body.action === 'taskDone', actionOwner = {}, actionNotice = {message:'完了状態を保存しています…'};
          if (taskWrite) taskNotices[actionScope] = actionNotice;
          function clearOwnPendingNotice() { if (taskWrite && taskNotices[actionScope] === actionNotice) delete taskNotices[actionScope]; }
          // A later request or scope reset replaces this token. An old response cannot release its busy state.
          busy = actionOwner; render();
          apiPost(body).then(function (res) {
            if (busy !== actionOwner || !familyAction && actionKey !== myKey()) { clearOwnPendingNotice(); return; }
            busy = false; pending = null;
            if (actionScope !== taskScopeKey()) { clearOwnPendingNotice(); render(); return; }
            if (res.error) {
              if (taskWrite) taskNotices[actionScope] = {error:true,message:res.error,retry:Object.assign({},body)};
              toast(res.error);
              if (res.badCode) { S = { me: null, slots: [], today: "" }; render(); return; }
              if (res.refresh) return loadState();
              render(); return;
            }
            if (taskWrite) taskNotices[actionScope] = {message:okMsg};
            stateKey = actionKey; S = res.state; if (onSuccess) onSuccess(); render();
            if (okMsg) toast(okMsg);
          }).catch(function () { if (busy !== actionOwner || !familyAction && actionKey !== myKey()) { clearOwnPendingNotice(); return; } busy = false; if (actionScope !== taskScopeKey()) { clearOwnPendingNotice(); render(); return; } if (taskWrite) taskNotices[actionScope] = {error:true,message:'保存結果を確認できませんでした。通信状態を確認して、同じ内容で再試行してください。',retry:Object.assign({},body)}; toast("通信に失敗しました。電波の良いところでもう一度お試しください"); render(); });
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
        function renderBatch(b, sharedName) {
          var h = b.message ? '<p class="parent-error" role="status">' + esc(b.message) + '</p>' : '';
          if (b.refreshRequired) h += '<button class="btn-primary" data-action="batchrefresh"' + (b.busy ? ' disabled' : '') + '>' + (b.busy ? '読み込み中…' : '最新の案内を再読み込み') + '</button>';
          if (b.review) h += '<div class="card" role="region" aria-label="確定する日時の確認"><strong>次の' + b.review.length + '件を確定します</strong>' + b.review.map(function (s) { return '<p>' + fmtDateW(s.date) + ' ' + esc(s.start) + '〜' + endTime(s.start, s.min) + ' ' + esc(lessonLabel(s)) + (s.deliveryMode === 'in_person' ? '' : '・' + deliveryLabel(s.deliveryMode)) + '</p>'; }).join('') + '<p class="note">月間計画の承認と定員を確認します。カレンダー登録と通知を行い、オンライン授業にはMeetを発行します。</p>' + (b.pending ? '' : '<button class="btn-primary" data-action="batchsend">この日時で確定する</button> <button class="btn-quiet" data-action="batchcancel">選び直す</button>') + '</div>';
          if (b.results.length) h += '<ul>' + b.results.map(function (x) { var s = (b.review || b.rows || []).filter(function (r) { return sameId(r.id, x.slotId); })[0] || (S.slots || []).filter(function (r) { return sameId(r.id, x.slotId); })[0]; return '<li>' + (s ? fmtDateW(s.date) + ' ' + esc(s.start) : '選択した授業') + '：' + ({ booked: '確定済み', pending: '未完了', error: '確認が必要' }[x.status] || '確認中') + (x.error ? '・' + esc(x.error) : '') + '</li>'; }).join('') + '</ul>';
          if (b.pending) h += '<button class="btn-primary" data-action="batchsend"' + (b.busy ? ' disabled' : '') + '>' + (b.busy ? '処理中…' : '同じ処理を再試行') + '</button><p class="note">完了するまでこのタブを閉じないでください。</p>';
          return sharedName&&h?'<div aria-label="'+esc(sharedName)+'の授業登録"><strong>'+esc(sharedName)+'</strong>'+h+'</div>':h;
        }

        /* ---------- 予定表 ---------- */
        // 予定表の本体は共通部品 assets/calendar.js(管理画面の生徒カルテと同じ)
        function renderCal(info, today, showToff) {
          return window.StepwiseCalendar.render(info, { cancelLegend:true,compactAvailabilityLegend:true,toffLegend:"教室都合", offerLegend: "授業（未登録）", eventLegend: "イベント", year: calY, month: calM, today: today, selDate: selDate, selMode: selMode, selDays: selDays, showToff: !!showToff, minIdx: calNow.getFullYear() * 12 + calNow.getMonth() - 12, maxIdx: calNow.getFullYear() * 12 + calNow.getMonth() + 3 });
        }

        /* ---------- 画面: 専用リンクなし ---------- */
        // ホーム画面に追加したアプリから開くと、専用リンクの ?k= が付いていない。
        // 端末に覚えていればそのまま入れるが、覚えていないこともある（端末を替えた・
        // 保存領域が分かれている など）。そのときのために、リンクを貼り直せる入口を出す。
        var guardMessage = "";
        function guardKeyFrom(text) {
          var value = String(text || '').trim();
          if (!value) return '';
          if (/^https?:\/\//i.test(value)) {
            try { value = new URLSearchParams(new URL(value).search).get('k') || ''; } catch (e) { return ''; }
            value = value.trim();
          }
          return /^[A-Za-z0-9_-]{6,100}$/.test(value) ? value : '';
        }
        function guardOpen() {
          var field = document.getElementById('guard-link');
          var key = guardKeyFrom(field && field.value);
          if (!key) { guardMessage = 'リンクを読み取れませんでした。先生から届いたリンクをそのまま貼り付けてください'; render(); return; }
          lsSet('sw_k', key);
          S = null; P = null; guardMessage = '読み込んでいます…'; render();
          loadState().catch(function () { guardMessage = 'このリンクではひらけませんでした。先生に確認してください'; render(); });
        }
        function renderGuard() {
          app.innerHTML = '<div class="card" style="margin-top:26px;text-align:center;padding:28px 20px">' +
            '<div style="font-weight:700;font-size:16px;margin-bottom:8px">専用リンクからひらいてください</div>' +
            '<div style="font-size:13.5px;color:var(--muted)">このページは、先生からLINEで送られた<br>あなた専用のリンクからひらく必要があります。<br>リンクが分からないときは、LINEで先生に連絡してください。</div>' +
            '<div style="margin-top:18px;text-align:left">' +
              '<label for="guard-link" style="display:block;font-size:13px;margin-bottom:6px">リンクを貼り付けてひらくこともできます</label>' +
              '<input id="guard-link" type="url" inputmode="url" autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box" placeholder="https://www.stepwise-education.jp/yoyaku/?k=...">' +
              '<button class="btn-primary" data-action="guardopen" style="margin-top:10px;width:100%">このリンクでひらく</button>' +
              (guardMessage ? '<p class="parent-error" role="status" style="margin-top:8px">' + esc(guardMessage) + '</p>' : '') +
            '</div>' +
            '</div>' +
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
          var hist = (S.history || []).map(function (h) { return { teacherBooking:h.teacherBooking, id: h.id, date: h.date, start: h.start, min: h.min, subject: h.subject, deliveryMode: h.deliveryMode, st: h.done ? "done" : "past" }; });
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
          var info = window.StepwiseCalendar.buildInfo({ cancellations: S.cancellations || [], lessons: slots.concat(hist), events: events, blocked: blocked, teacherOff: S.teacherOff || [], wishes: S.wishes || [], lessonLabel: lessonLabel });
          var upcoming = mine.filter(function (s) { return s.date > today || (s.date === today && endTime(s.start, s.min) >= nowStr); });
          return { today: today, slots: slots, mine: mine, offers: offers, hist: hist, blocked: blocked, events: events, byDate: byDate, info: info, upcoming: upcoming, next: upcoming[0] };
        }

        function previewBanner(long) {
          if (!previewK) return "";
          if (PREVIEW) {
            var pname = S && S.me && S.me.name ? S.me.name : (F.home && F.home.children && F.home.children[0] ? F.home.children[0].name : '');
            return '<div class="preview-banner" role="status" style="background:var(--amber-soft);border:1px solid #d99a2b;color:var(--amber);border-radius:12px;padding:10px 14px;font-size:13.5px;margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1"><strong>' + esc(pname) + 'さんの' + (PREVIEW.view === 'parent' ? '保護者ページ' : 'マイページ') + 'を表示中</strong>（先生のプレビュー・表示のみ。登録や変更はできません）</span><a class="btn-quiet btn-sm" href="/kanri/#s=' + encodeURIComponent(PREVIEW.studentId) + '" style="text-decoration:none">管理画面の生徒ページへ</a></div>';
          }
          return '<div style="background:var(--amber-soft);border:1px solid #d99a2b;color:var(--amber);border-radius:12px;padding:10px 14px;font-size:13.5px;margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="flex:1"><strong>' + esc(S.me.name) + 'さんのページを表示中</strong>(先生プレビュー' + (long ? '。ここでの操作は本人として反映されます' : '') + ')</span><a class="btn-quiet btn-sm" href="../kanri/" style="text-decoration:none">管理画面へ</a></div>';
        }

        // 選んだ日の内訳。withActions=true なら「この日に:」のボタン(予定ページ)。登録不可(先生の休み)はホーム・予定の両方で出す(2026-09-11)
        var bookingReview=null;
        function bookingReviewButton(s){var b=s.teacherBooking;if(!b||b.status==='registering')return '';if(b.status==='pending')return ' <button type="button" class="plan-count-warning" data-action="booking-review" data-id="'+esc(s.id)+'" aria-label="先生の登録内容を確認" title="先生の登録内容を確認"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle class="warning-dot" cx="12" cy="17" r=".8"/></svg></button>';return ' <button class="tag '+(b.status==='confirmed'?'gray':b.status==='correction'?'red':'amber')+'" data-action="booking-review" data-id="'+esc(s.id)+'">'+({pending:'先生の登録内容を確認',confirmed:'先生が登録・確認済み',correction:'修正依頼中'}[b.status]||'確認')+'</button>';}
        function cancelReviewNotice(s){
          var amount=Number(s.amount),standard=Number(s.standardAmount),known=s.standardAmount!=null&&Number.isFinite(standard),at=Date.parse(s.receivedAt),start=Date.parse(s.date+'T'+s.start+':00+09:00'),deadline=Date.parse(s.date+'T23:00:00+09:00')-86400000;
          var reason=s.source==='teacher'?'教室都合のキャンセルのため':s.source==='noshow'?'無断欠席として登録されているため':Number.isFinite(at)&&at>=start?'授業開始後のキャンセルのため':Number.isFinite(at)&&at>deadline?'前日23時を過ぎて授業開始前までのキャンセルのため':Number.isFinite(at)?'前日23時までにご連絡いただいたため':'';
          var text='';
          if(known&&standard>amount)text=reason+'、規定のキャンセル料は'+yen(standard)+'ですが、'+(amount===0?'全額免除となり、キャンセル料は0円です。':yen(standard-amount)+'減額し、キャンセル料は'+yen(amount)+'となっています。');
          else if(amount===0)text=(reason?reason+'、':'')+'キャンセル料はかかりません。';
          else text=(reason?reason+'、':'')+'キャンセル料が'+yen(amount)+'発生します。';
          if(text.charAt(0)==='、')text=text.slice(1);
          var intro=s.confirmed?'キャンセル内容は確認済みです。':'キャンセル登録されました。内容をご確認の上、問題がなければ「承認する」ボタンを押してください。';
          var h='<p>'+intro+'</p><p>'+esc(text)+'</p>';
          if(s.relief&&s.relief.status==='pending')h+='<p>減額・免除の申請を確認中です。表示金額は審査前の金額です。</p>';
          else if(!s.relief&&amount>0)h+='<p>急病・災害などの事情があり、減額・免除を申請する場合は「減額・免除を申請する」から申請をお願いします。</p>';
          return h;
        }
        function cancelReviewDetails(s){
          var stamp='記録なし';if(s.source==='noshow')stamp='連絡なし';else if(s.source==='teacher')stamp='対象外（先生都合）';else if(s.receivedAt){var t=new Date(Date.parse(s.receivedAt)+9*3600000);if(!isNaN(t.getTime()))stamp=t.toISOString().slice(0,16).replace('T',' ').replace(/-/g,'/')+'（日本時間）';}
          var standard=Number(s.standardAmount),amount=Number(s.amount),known=s.standardAmount!=null,reduction=known&&standard>amount?standard-amount:0;
          var rows=[['授業日時',s.date.replace(/-/g,'/')+' '+s.start+'〜'+endTime(s.start,s.min)],['科目',s.subject||'—'],['状態','キャンセル済み'],['連絡受付日時',stamp],['連絡方法',({request:'マイページからの申請',external:'LINE・電話など',noshow:'連絡なし（無断欠席）',teacher:'先生都合'})[s.source]||'記録なし'],['規定のキャンセル料',known?yen(standard):'記録なし'],['減額・免除',reduction?(amount===0?'全額免除':'減額')+'（'+yen(reduction)+'）':'なし'],['適用中のキャンセル料',yen(amount)]];
          if(s.relief){rows.push(['減額・免除の申請',s.relief.status==='pending'?'確認中（請求確定を保留）':({unchanged:'規定どおり',reduced:'減額承認',waived:'免除承認'})[s.relief.status]||'審査済み']);rows.push(['申請理由',s.relief.reason]);if(s.relief.response)rows.push(['先生の回答',s.relief.response]);}
          return cancelReviewNotice(s)+'<table class="portal-plan-table" style="width:100%;table-layout:fixed"><tbody>'+rows.map(function(r){return '<tr><th scope="row" style="width:38%;text-align:left">'+esc(r[0])+'</th><td style="text-align:left;overflow-wrap:anywhere">'+esc(r[1])+'</td></tr>';}).join('')+'</tbody></table>';
        }
        function cancelReliefForm(d){var dis=busy||previewK?' disabled':'',s=d.slot;return (!s.confirmed?'<p><button class="btn-primary" data-action="cancel-confirm"'+dis+'>承認する</button></p>':'<p>確認済みです。</p>')+(!s.relief&&s.amount>0?'<details'+(d.reason?' open':'')+'><summary>減額・免除を申請する</summary><p>急病・災害など、やむを得ない事情がある場合は理由をご記入ください。確認済みでも申請できます。</p><textarea id="cancel-circumstances" maxlength="1000" style="width:100%;min-height:90px"'+dis+'>'+esc(d.reason||'')+'</textarea><button class="btn-quiet" data-action="cancel-relief-send"'+dis+'>減額・免除を申請する</button><p class="note">キャンセルは確定済みのまま、料金の請求確定を先生の審査まで保留します。</p></details>':'');}

        function changeHistoryTable(changes){return (changes||[]).map(function(c){
          var x=c.context||{},cell=' style="border:1px solid #b8c8df;padding:10px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere"';
          function lessonRow(label,v){return '<tr><th scope="row"'+cell+'>'+esc(label)+'</th><td'+cell+'>'+esc(v.date+' '+v.start+'〜'+endTime(v.start,v.min))+'</td><td'+cell+'>'+esc(v.subject||'—')+'</td><td'+cell+'>'+esc(v.kind||'通常')+'</td></tr>';}
          var rows=[['連絡受付日時',x.receivedAt?x.receivedAt.replace('T',' ')+'（日本時間）':'記録なし'],['変更理由',x.reason||'記録なし'],['経緯',x.note||'記録なし']];
          return '<table class="portal-plan-table" style="width:100%;border-collapse:collapse;margin:12px 0"><thead><tr><th>項目</th><th>日時</th><th>科目</th><th>種類</th></tr></thead><tbody>'+ (c.before?lessonRow('変更前',c.before):'')+lessonRow(c.before?'変更後':'授業',c.after)+(c.before?rows.map(function(r){return '<tr><th scope="row"'+cell+'>'+esc(r[0])+'</th><td colspan="3"'+cell+'>'+esc(r[1])+'</td></tr>';}).join(''):'')+'</tbody></table>';
        }).join('');}
        function bookingReviewHTML(){
          var d=bookingReview;if(!d)return '';if(d.scope!==taskScopeKey()){bookingReview=null;return '';}if(d.slot.st==='cancelled')return window.StepwiseCalendar.dayDialog({id:'booking-review-dialog',title:'キャンセル内容の確認',close:'booking-close',busy:busy,content:cancelReviewDetails(d.slot)+cancelReliefForm(d)});
          var s=d.slot,b=s.teacherBooking,dis=busy||previewK?' disabled':'',parent=route()==='family',perms=S.permissions||{};
          var changed=!!(b.previous||(b.changes&&b.changes.length));
          var content=b.status==='pending'?'<p>先生がこの授業を'+(changed?'変更':'登録')+'しました。内容に間違いはありませんか？</p><p>内容が正しければ「承認する」を押してください。誤りがある場合は、訂正してほしい内容を記入して「訂正を依頼する」を押してください。</p>':'';
          content+=changeHistoryTable(b.changes&&b.changes.length?b.changes:[{before:b.previous||null,after:s}]);
          if(b.status==='pending')content+='<p class="note">回答前も授業は確定済みです。修正依頼だけでは予定は取り消されません。</p><button class="btn-primary" data-action="booking-confirm"'+dis+(!parent&&perms.booking===false?' disabled':'')+'>承認する</button><label style="display:block;margin-top:16px">訂正してほしい内容<textarea id="booking-review-note" maxlength="500" style="width:100%"'+dis+'>'+esc(d.note||'')+'</textarea></label><button class="btn-quiet" data-action="booking-correct"'+dis+(!parent&&perms.reschedule===false?' disabled':'')+'>訂正を依頼する</button>'+(!parent&&(perms.booking===false||perms.reschedule===false)?'<p class="note">権限のない操作は保護者にご相談ください。</p>':'');
          else content+='<p>'+(b.status==='confirmed'?'内容に間違いないことを確認済みです。':'先生に修正をお願いしています。')+'</p>'+(b.note?'<p style="white-space:pre-wrap">'+esc(b.note)+'</p>':'');
          return window.StepwiseCalendar.dayDialog({id:'booking-review-dialog',title:'先生が登録した授業の確認',close:'booking-close',busy:busy,content:content});
        }
        function renderDayDetail(D, withActions, showToff, shared) {
          var rows=[], whoName=shared ? '<strong class="family-row-name">'+esc(shared.name)+'</strong> ' : '';
          function emitDayRow(markup,start){if(shared){rows.push({html:markup,start:/^\d{2}:\d{2}$/.test(start)?start:'00:00'});return "";}return markup;}
          var today = D.today;
          var ds2 = (D.byDate[selDate] || []).concat((S.cancellations||[]).filter(function(x){return x.date===selDate;})).sort(function (a, b) { return (a.start || "99") < (b.start || "99") ? -1 : 1; });
          var dayNg = D.blocked.filter(function (b) { return b.date === selDate; });
          var dayOffs = showToff ? (S.teacherOff || []).filter(function (o) { return o.date === selDate; }) : [];
          var dayWishes = (S.wishes || []).filter(function (w) { return w.date === selDate; });
          var canAdd=selDate>=today, canAI=!!S.nlEnabled || !!previewK;
          var html=shared ? "" : window.StepwiseCalendar.dayHeading({date:selDate,title:fmtDateW(selDate)+'の授業',disabled:busy||NL.busy,add:canAdd?{action:'dayadd',label:'この日に予定を追加'}:null,ai:canAdd&&canAI?{action:'dayai',label:'AIで予定登録'}:null});
          if (!ds2.length && !dayNg.length && !dayOffs.length && !dayWishes.length && !shared) html += '<div class="empty">この日の予定はありません</div>';
          else {
            // 授業登録の一覧と同じ行形式(左: 種類のタグ、時刻、内容 / 右: 操作)
            var dis = (acceptBatch().pending || acceptBatch().busy || acceptBatch().refreshRequired) ? ' disabled' : '';
            function dayRow(lead, time, who, actions, common) { return emitDayRow('<div class="slotline">' + lead + '<span class="time">' + time + '</span><span class="who">' + (common?'':whoName) + who + '</span>' + actions + '</div>',time.slice(0,5)); }
            if(!shared)html += '<div class="card daylist">';
            dayOffs.forEach(function (o) { html += dayRow('<span class="tag gray">' + (o.start ? '登録不可' : '登録不可（終日）') + '</span>', o.start ? esc(o.start) + '〜' + esc(o.end) : '', '', '<button class="btn-quiet btn-sm" data-action="helptoff" aria-label="登録不可の説明" aria-expanded="' + helpToff + '" style="border-radius:50%;width:30px;height:30px;padding:0;font-weight:700">？</button>',true); });
            if (dayOffs.length && helpToff) html += '<div class="note" style="margin:4px 0 8px">先生の予定があるため、この時間帯には授業を登録できません。別の日時を選ぶか、先生にご相談ください。</div>';
            ds2.forEach(function (s) {
              if (s.st === "event") { html += dayRow('<span class="tag coral">重要な予定</span>', '', esc(s.title), s.id ? '<button class="btn-quiet btn-sm" data-action="delevent" data-id="' + esc(s.id) + '">削除</button>' : ''); return; }
              var time = s.start + "〜" + endTime(s.start, s.min), who = (s.subject ? esc(lessonLabel(s, true)) : "") + (s.deliveryMode === 'in_person' ? '' : deliveryTag(s));
              if (s.st === "cancelled") html += dayRow('', time, esc(s.subject||'')+' <button class="tag gray" data-action="cancel-review" data-id="'+esc(s.id)+'">キャンセル済み</button>'+(!s.confirmed?bookingReviewButton({id:s.id,teacherBooking:{status:'pending'}}).replace('booking-review','cancel-review').replace(/先生の登録内容を確認/g,'キャンセル内容を確認'):''), '');
              else if (s.st === "mine") html += dayRow('', time, who + bookingReviewButton(s) + (s.req ? ' <span class="tag amber">キャンセル申請中</span>' : ''), meetControl(s, false) + cancelControl(s, true));
              else if (s.st === "done") {
                var records = (S.lessonRecords || []).filter(function (r) { return r.date === s.date && r.start === s.start && r.subject === (s.subject || '') && Number(r.min) === Number(s.min); });
                var record = records.length === 1 ? records[0] : null;
                var recordHtml = '<details class="slotline day-record"><summary><span class="time">' + time + '</span><span class="who">' + whoName + who + bookingReviewButton(s) + '</span><span class="btn-quiet btn-sm day-record-toggle">授業記録</span></summary><div style="padding:12px 4px">';
                if (record) {
                  recordHtml += window.StepwiseReport.view({actualUnit:(record.report || {}).actualUnit || '未記入'});
                  recordHtml += '<h3 style="font-size:15px;margin:10px 0 6px">コメント</h3><p style="white-space:pre-wrap;margin:0">' + esc(record.content || 'コメントはまだありません。') + '</p>';
                } else recordHtml += '<p class="muted" style="margin:0">授業の内容はまだ公開されていません。</p>';
                html += emitDayRow(recordHtml+'</div></details>',s.start);
              }
              else if (s.st === "past") html += dayRow('<span class="tag gray">授業</span>', time, who+bookingReviewButton(s), '');
              else if (s.st === "offer") html += dayRow('<label><input type="checkbox" data-accept-id="' + esc(s.id) + '"' + (acceptBatch().selected[s.id] ? ' checked' : '') + dis + ' aria-label="' + esc(fmtDateW(s.date) + ' ' + s.start + 'を選択') + '"></label><span class="tag amber">案内</span>', time, who, '<button class="btn-primary btn-sm" data-action="askaccept" data-id="' + esc(s.id) + '"' + dis + '>予定する</button><button class="btn-quiet btn-sm" data-action="askdecline" data-id="' + esc(s.id) + '">再調整</button>');
            });
            dayNg.forEach(function (b) { html += dayRow('<span class="tag gray">授業不可</span>', b.start ? esc(b.start) + '〜' + esc(b.end) : '終日', b.note ? esc(b.note) : '', b.id && selDate >= today ? '<button class="btn-quiet btn-sm" data-action="delblock" data-ids="' + esc(b.id) + '">解除</button>' : ''); });
            dayWishes.forEach(function (w) { html += dayRow('<span class="tag green">'+(w.kind==='want'?'希望日時':'授業可')+'</span>', esc(w.start) + '〜' + esc(w.end), (w.note ? esc(w.note) + ' ' : '') + '<span class="small muted">先生の返事待ち</span>', '<button class="btn-quiet btn-sm" data-action="helpwish" aria-label="希望日時・授業可能の説明" aria-expanded="' + helpWish + '" style="border-radius:50%;width:30px;height:30px;padding:0;font-weight:700">？</button><button class="btn-quiet btn-sm" data-action="delwish" data-id="' + esc(w.id) + '">取消</button>'); });
            if (dayWishes.length && helpWish) html += '<div class="note" style="margin:4px 0 8px">「希望日時」はその日時に1コマ受けたい希望、「授業可」は授業を受けられる時間帯です。先生が確認して授業を案内します。案内が届いたら「予定する」で登録してください。</div>';
            if(!shared)html += '</div>';
          }
          if (canAdd && dayAddOpen) {
            var content=dayInputMode==='text'&&canAI?renderNaturalHelp()+renderNaturalEntry():'<div class="row"><button class="btn-quiet" data-action="dayact" data-m="want" data-date="'+selDate+'">希望日時</button><button class="btn-quiet" data-action="dayavailability">授業可能・不可</button><button class="btn-quiet" data-action="dayact" data-m="event" data-date="'+selDate+'">イベント</button></div>';
            if(dayInputMode==='availability')content='<div class="row"><button class="btn-quiet" data-action="dayact" data-m="wish" data-date="'+selDate+'">授業可能</button><button class="btn-quiet" data-action="dayact" data-m="ng" data-date="'+selDate+'">授業不可</button></div>';
            html+=window.StepwiseCalendar.dayDialog({id:'schedule-day-editor',title:dayInputMode==='text'&&canAI?'AIで予定登録':dayInputMode==='availability'?'授業可能・不可':'予定を追加',close:'dayclose',busy:busy||NL.busy,content:content});
          }
          if ((route() === 'home' || route() === 'family') && selMode) html += window.StepwiseCalendar.dayDialog({id:"schedule-event-editor",title:({event:"イベントを登録",wish:"授業可能・不可を登録",want:"希望日時を登録",ng:"授業可能・不可を登録"})[selMode],close:"selcancel",busy:busy,content:renderSelBar(D, true)});
          if(shared)html=html.replace(/(<h2[^>]*>)([^<]*)/g,function(_,tag,title){return tag+esc(shared.name)+'：'+title;});
          return shared ? {rows:rows,dialogs:html} : html;
        }

        function renderNextLesson(D) {
          var today = D.today, next = D.next;
          var html = '<h2>次の授業</h2>';
          if (next) {
            var untilTxt = next.date === today ? "今日" : next.date === addDaysStr(today, 1) ? "明日" : Math.round((new Date(next.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5) + "日後";
            html += '<div class="card next"><div class="in">' + untilTxt + '</div><div class="when">' + fmtDateW(next.date) + " " + next.start + "〜" + endTime(next.start, next.min) + '</div>';
            html += '<div class="row" style="margin-top:4px">' + (next.subject ? '<span class="tag blue">' + esc(next.subject) + '</span>' : "") + deliveryTag(next) + '<span class="small muted">' + next.min + "分</span>" + (next.req ? '<span class="tag red">キャンセル申請中</span>' : "") + '</div>';
            html += '<div class="row" style="margin-top:10px">';
            html += meetControl(next, true);
            html += '<a class="btn-ghost btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="' + gcalUrl(next) + '">カレンダーに追加</a>';
            html += cancelControl(next) + '</div></div>';
          } else {
            html += '<div class="empty">次の授業はまだ決まっていません。' + (D.offers.length ? '下の「授業登録」から「予定する」を押してください。' : '先生から案内が届くとここに表示されます。') + '</div>';
          }
          return html;
        }

        // 授業計画(折り畳み)。案内=保護者の承認待ちの行、実施計画=承認済みの行と、その期間に当てはまる実施・予定の回数。GAS の planLines を使う
        function renderMonthSummary(D, sharedName) {
          var nameHead=sharedName ? '<th>名前</th>' : '', nameCell=sharedName ? '<td>'+esc(sharedName)+'</td>' : '';
          var today = D.today, mine = D.mine, lines = Array.isArray(S.planLines) ? S.planLines : [];
          var proposed = lines.filter(function (l) { return l.status === 'proposed'; }), approved = lines.filter(function (l) { return l.status === 'approved'; });
          function fits(l, x) { return lessonLabel(l) === lessonLabel(x) && planCovers(l, x.date); }
          function lessonsOf(l) { var n = { done: 0, plan: 0 }; (S.history || []).forEach(function (h) { if (h.done && fits(l, h)) n.done++; }); mine.forEach(function (s2) { if (fits(l, s2)) n.plan++; }); return n; }
          // 保護者は状態セルから共通モーダルで承認・回数調整する。
          var famChild = route() === 'family' ? familyMypageChild() : null, famLines = famChild && F.childrenData[famChild.studentId] ? (F.childrenData[famChild.studentId].planLines || []) : [];
          if (famChild && F.confirm && sameId(F.confirm.studentId, famChild.studentId)) folds.plan = true;
          function progressStatus(line,label) {
            if(!line)return esc(label);
            var items=[line].concat(lines.filter(function(a){return a.parentId===line.id&&a.id!==line.id;}));
            return items.map(function(l,i){return '<button type="button" class="tag '+(l.status==='approved'?'green':'amber')+'" aria-haspopup="dialog" data-action="'+(famChild?'fa-planopen':'student-planopen')+'"'+(famChild?' data-child="'+esc(famChild.studentId)+'"':'')+' data-line="'+esc(l.id)+'"'+(F.busy?' disabled':'')+'>'+(i?'追加：':'')+(l.status==='approved'?'承認済み':'承認待ち')+'</button>';}).join(' ');
          }
          var ymNow = today.slice(0, 7), extra = {};
          var planCols = (famChild ? 7 : 6)+(sharedName?1:0);
          function planTableHead(){return '<div class="portal-plan-wrap"><table class="portal-plan-table portal-proposal-table'+(sharedName?' family-plan-table':'')+'"><thead><tr>'+nameHead+'<th>期間</th><th>科目</th><th>種類</th><th>回数</th><th>時間</th>'+(famChild?'<th>1回の料金</th>':'')+'<th>状態</th></tr></thead><tbody>';}
          function planTableEnd(){return '</tbody></table></div>';}
          function planPeriod(l){function date(d){return d ? (d.slice(0,4)===today.slice(0,4)?'':d.slice(0,4)+'/')+Number(d.slice(5,7))+'/'+Number(d.slice(8,10)) : '未設定';}return date(l.startDate)+'〜'+date(l.endDate);}
          function planRow(l){
            var parentLine=famChild&&famLines.filter(function(x){return x.id===l.id;})[0];
            return '<tr>'+nameCell+'<td>'+esc(planPeriod(l))+'</td><td>'+esc(l.subject)+'</td><td>'+esc(l.kind||'通常')+(l.addon?'（追加）':'')+'</td><td>'+esc(l.status==='approved'?planLimit(l):l.count)+'回</td><td>'+(l.lessonMin?esc(l.lessonMin)+'分':'未設定')+'</td>'+(famChild?'<td>'+(parentLine?yen(parentLine.lessonFee!=null?parentLine.lessonFee:Math.round((Number(parentLine.rate30)||0)*parentLine.lessonMin/30)):'読み込み中')+'</td>':'')+'<td>'+(l.status==='approved'?'<span class="tag green">承認済み</span>':(famChild?'<button type="button" class="tag amber" aria-haspopup="dialog" data-action="fa-planopen" data-child="'+esc(famChild.studentId)+'" data-line="'+esc(l.id)+'"'+(F.busy?' disabled':'')+'>承認待ち</button>':'<button type="button" class="tag amber" data-action="approval-help" aria-expanded="false" aria-controls="plan-status-help-'+esc(l.id)+'">承認待ち</button>'))+'</td></tr>'+(l.status==='proposed'&&!famChild?'<tr id="plan-status-help-'+esc(l.id)+'" hidden><td class="portal-plan-info" colspan="'+planCols+'">'+(famChild?'「承認する」で計画が確定します。回数を減らしたいときや今回は見送るときは「回数を調整・見送る」から先生に伝えられます。':'保護者の方に伝えて、保護者ページから承認・調整をお願いしましょう。登録・実施の回数は「実施状況」で確認できます。')+'</td></tr>':'');
          }
          function planInfo(content){return '<tr><td class="portal-plan-info" colspan="'+planCols+'">'+content+'</td></tr>';}
          function planComment(l){return planInfo('<details class="portal-plan-comment"><summary><span>'+esc(l.comment||'コメントはありません')+'</span></summary><div>'+esc(l.comment||'コメントはありません')+'</div></details>');}

          // 先生が電話・LINEなどの承諾をもとに承認済みにした計画は、保護者が「内容を確認しました」を押すまで目立たせる(問い合わせもここから)
          function famAckBlock(x) {
            var fl = famChild ? famLines.filter(function (y) { return y.id === x.id; })[0] : null;
            if (!fl || !fl.teacherRecorded) return '';
            var famDis = F.busy ? ' disabled' : '', h = '<div class="note plan-ack" role="status" style="margin:4px 0 6px;border-left:3px solid var(--amber)"><strong>先生が記録した承認です。</strong>' + (fl.consentDate ? esc(fl.consentDate) + 'に' : '') + esc(fl.approvedVia || '') + 'で承諾いただいた内容として、先生がこの計画（' + esc(planName(fl)) + (fl.addon ? '・追加' : '') + ' ' + esc(planLimit(fl)) + '回' + (planFee(fl) ? '・' + esc(planFee(fl)) : '') + '）を承認済みにしました。心当たりがない場合や内容が違う場合は問い合わせてください。';
            if (fl.parentAck === 'confirmed') h += '<div class="small" style="margin-top:4px"><span class="tag green">確認済み</span> ' + esc(String(fl.parentAckAt || '').slice(0, 10)) + '</div>';
            else if (fl.parentAck === 'inquiry') h += '<div class="small" style="margin-top:4px;white-space:pre-wrap"><span class="tag amber">問い合わせ済み</span> 先生からの連絡をお待ちください。' + (fl.parentAckMemo ? '\n' + esc(fl.parentAckMemo) : '') + '</div>';
            if (fl.parentAck !== 'confirmed') h += '<div class="row" style="margin-top:6px;gap:8px"><button class="btn-primary btn-sm" data-action="fa-planack" data-child="' + esc(famChild.studentId) + '" data-line="' + esc(fl.id) + '" data-ack="confirmed"' + famDis + '>内容を確認しました</button><button class="btn-quiet btn-sm" data-action="fa-planack" data-child="' + esc(famChild.studentId) + '" data-line="' + esc(fl.id) + '" data-ack="inquiry"' + famDis + '>' + (fl.parentAck === 'inquiry' ? '問い合わせを追加する' : '先生に問い合わせる') + '</button></div>';
            return h + '</div>';
          }
          // 送信済みの未承認計画は、授業登録がなくても実施状況に表示する。
          proposed.forEach(function (l) {
            if (l.parentId && proposed.some(function (p) { return p.id === l.parentId; })) return;
            var count = Number(l.count) || 0;
            proposed.forEach(function (a) { if (a.parentId === l.id) count += Number(a.count) || 0; });
            extra['plan:' + l.id] = { label: lessonLabel(l) || 'その他', status: '未承認', line: l, count: count, done: 0, plan: 0 };
          });
          function addExtra(x, key) {
            if(approved.some(function(l){return fits(l,x);}))return;
            var matching=proposed.filter(function(l){return fits(l,x);}),line=matching[0]||null;
            if(line&&line.parentId){line=proposed.filter(function(l){return l.id===line.parentId;})[0]||line;}
            if(!line&&String(x.date||'').slice(0,7)!==ymNow)return;
            var label=lessonLabel(x)||'その他',status=line?'未承認':'計画外',k=line?'plan:'+line.id:label+'|'+status;
            var count=line?Number(line.count)||0:null;
            if(line)proposed.forEach(function(l){if(l.parentId===line.id)count+=Number(l.count)||0;});
            var c=extra[k]||(extra[k]={label:label,status:status,line:line,count:count,done:0,plan:0});c[key]++;
          }
          (S.history || []).forEach(function (h) { if(h.done)addExtra(h, 'done'); }); mine.forEach(function (s2) { addExtra(s2, 'plan'); });
          var extraKeys = Object.keys(extra);
          if (!lines.length && !extraKeys.length && !famChild) return { plan: '', progress: '' };
          var html = foldHead('plan', '授業計画', proposed.length ? proposed.length + '件の案内' : '新しい案内なし') + '<div class="card">';
          if (famChild && F.confirm && sameId(F.confirm.studentId, famChild.studentId)) html += renderFamilyPlanConfirm(F.busy ? ' disabled' : '');
          html += '<h3 style="margin:0 0 6px;font-size:15px">案内</h3>';
          if (!proposed.length) html += '<div class="empty">新しい案内はありません</div>';
          var confirmHtml=famChild&&F.confirm&&sameId(F.confirm.studentId,famChild.studentId)?renderFamilyPlanConfirm(F.busy?' disabled':''):'';
          if (proposed.length) html += planTableHead();
          var proposalStart=html.length;
          proposed.forEach(function(l){
            html += planRow(l)+planComment(l);
            var outline=window.StepwiseReport.outline(l.outline);if(outline)html+=planInfo(outline);

          });
          var proposalRows=html.slice(proposalStart), proposalHead=planTableHead();
          if (proposed.length) html += planTableEnd();
          html += '</div></details>';
          var planHtml = html, progressCount = (approved.length + proposed.length) ? (approved.length + proposed.length)+'件の計画' : '送信済みの計画なし';
          html = (famChild ? '<section class="parent-progress"><h2>実施状況 <span class="cnt">'+esc(progressCount)+'</span></h2>' : '<section class="student-progress family-student-progress"><h2>授業計画・実施状況 <span class="cnt">'+esc(progressCount)+'</span></h2>') + '<div class="card">';
          var remainTotal = 0, shown = 0;
          planCols=7+(sharedName?1:0);
          var progressHead='<div class="portal-plan-wrap"><table class="portal-plan-table'+(sharedName?' family-plan-table':'')+'"><thead><tr>'+nameHead+'<th>期間</th><th>科目</th><th>種類</th><th>計画回数</th><th>登録回数</th><th>実施回数</th><th>状態</th></tr></thead><tbody>';
          if(approved.length||extraKeys.length)html+=progressHead;
          var progressStart=html.length;
          var approvedIds={};approved.forEach(function(l){approvedIds[l.id]=true;});
          approved.filter(function(l){return !(l.addon&&approvedIds[l.parentId]);}).forEach(function(l){
            var addons=approved.filter(function(a){return a.addon&&a.parentId===l.id;}),goal=planLimit(l);addons.forEach(function(a){goal+=planLimit(a);});
            var n=lessonsOf(l),remain=Math.max(0,goal-n.done-n.plan);remainTotal+=remain;shown++;
            html+='<tr>'+nameCell+'<td>'+esc(planPeriod(l))+'</td><td>'+esc(l.subject)+'</td><td>'+esc(l.kind||'通常')+'</td><td>'+goal+'回</td><td>'+(n.done+n.plan)+'回</td><td>'+n.done+'回</td><td>'+progressStatus(l,'承認済み')+'</td></tr>'+planComment(l);
            var outline=window.StepwiseReport.outline(l.outline);if(outline)html+=planInfo(outline);
            var ack=famAckBlock(l);if(ack)html+=planInfo(ack);
            addons.forEach(function(a){html+=planComment(a);var ack=famAckBlock(a);if(ack)html+=planInfo(ack);});
          });
          extraKeys.forEach(function(label){var n=extra[label],mm=/^(.*)（(.+)）$/.exec(n.label);shown++;var endDay=new Date(Number(ymNow.slice(0,4)),Number(ymNow.slice(5)),0).getDate();html+='<tr>'+nameCell+'<td>'+(n.line?esc(planPeriod(n.line)):Number(ymNow.slice(5))+'/1〜'+Number(ymNow.slice(5))+'/'+endDay)+'</td><td>'+esc(mm?mm[1]:n.label)+'</td><td>'+esc(mm?mm[2]:'通常')+'</td><td><span class="plan-count-value"><span>'+(n.count==null?'—':n.count+'回')+'</span>'+(n.line?'<button type="button" class="plan-count-warning" data-action="approval-help" aria-label="未承認の授業計画について" aria-expanded="false" aria-controls="progress-approval-'+esc(n.line.id)+'"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle class="warning-dot" cx="12" cy="17" r=".8"/></svg></button>':'')+'</span></td><td>'+(n.done+n.plan)+'回</td><td>'+n.done+'回</td><td>'+progressStatus(n.line,n.status)+'</td></tr>'+(n.line?'<tr id="progress-approval-'+esc(n.line.id)+'" hidden><td class="portal-plan-info" colspan="'+planCols+'">'+(famChild?'この授業計画は未承認です。状態の「承認待ち」を押して内容をご確認ください。':'この授業計画の授業回数は、保護者の承認を得ていません。保護者の方に連絡し、確認していただくようにお願いします。')+'</td></tr>':'');});
          var progressRows=html.slice(progressStart);
          if(approved.length||extraKeys.length)html+=planTableEnd();
          if (!shown) html += '<div class="empty">送信済みの計画はありません</div>';
          if (remainTotal) html += '<div class="small" style="color:var(--primary);margin-top:8px">あと ' + remainTotal + ' 回、日程調整が必要です。予定表で日付を選び、＋から授業可能日時を送れます。</div>';
          if (famChild && F.childrenData[famChild.studentId]) html += renderParentThisMonth(F.childrenData[famChild.studentId]);
          return { plan: planHtml, progress: html + '</div>' + '</section>', proposalRows:proposalRows,proposalHead:proposalHead,progressRows:progressRows,progressHead:progressHead,confirm:confirmHtml,proposalCount:proposed.length,planCount:approved.length+proposed.length,remain:remainTotal };
        }

        function renderOffers(D, sharedName) {
          var offers = D.offers, b = acceptBatch(), html = renderBatch(b,sharedName);
          var selectable = offers.slice(0, 31), allSelected = selectable.every(function (s) { return b.selected[s.id]; });
          if (!offers.length) return html;
          html += (sharedName ? '' : foldHead('offers', '授業登録', offers.length + '件・返事をお願いします'));
          html += '<div class="card" style="border-color:#d99a2b">';
          html += '<div class="row"><button class="btn-quiet btn-sm" data-action="' + (allSelected ? 'batchclear' : 'batchall') + '"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>' + (allSelected ? '選択解除' : '一括選択') + '</button>' + (offers.length > 31 ? '<span class="small muted">一括選択は31件まで</span>' : '') + '</div>';
          offers.forEach(function (s) {
            html += '<div class="slotline"><label><input type="checkbox" data-accept-id="' + esc(s.id) + '"' + (b.selected[s.id] ? ' checked' : '') + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + ' aria-label="' + esc(fmtDateW(s.date) + ' ' + s.start + 'を選択') + '"></label><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (sharedName?'<strong class="family-row-name">'+esc(sharedName)+'</strong> ':'') + (s.subject ? esc(lessonLabel(s, true)) : "") + deliveryTag(s) + "</span>";
            html += '<button class="btn-primary btn-sm" data-action="askaccept" data-id="' + esc(s.id) + '"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>予定する</button><button class="btn-quiet btn-sm" data-action="askdecline" data-id="' + esc(s.id) + '">再調整</button></div>';
          });
          html += '<button class="btn-primary" data-action="batchreview"' + (b.pending || b.busy || b.refreshRequired ? ' disabled' : '') + '>選んだ日時を確認する</button></div><div class="note">日時を確認してから予定します。日時が合わないときは「再調整」で先生に別の日時をお願いできます。</div>'+(sharedName?'':'</details>');
          return html;
        }

        function renderUpcoming(D, hasNextCard) {
          var upcoming = D.upcoming, next = D.next;
          var html = '<h2>今後の予定 <span class="cnt">' + upcoming.length + '件</span></h2>';
          if (upcoming.length > 1 || (upcoming.length === 1 && !(hasNextCard && next))) {
            html += '<div class="card">';
            upcoming.forEach(function (s) {
              html += '<div class="slotline"><span class="time">' + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min) + '</span><span class="who">' + (s.subject ? esc(lessonLabel(s, true)) : "") + (s.req ? ' <span class="tag red">キャンセル申請中</span>' : "") + "</span>";
              html += deliveryTag(s);
              html += meetControl(s, false);
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
        function renderPendingBar(D, sharedName) {
          if (!pending) return "";
          if (pending.kind === "remove") {
            return '<div class="confirmbar"><div class="inner"><div class="msg">' + (sharedName?esc(sharedName)+'さん：':'') + pending.text + '</div><div class="row"><button class="btn-danger" data-action="doremove"' + (busy ? ' disabled' : '') + '>' + (busy ? '処理しています…' : esc(pending.verb)) + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div></div></div>';
          }
          var s = null, slots = D.slots;
          for (var i = 0; i < slots.length; i++) if (sameId(slots[i].id, pending.slotId)) s = slots[i];
          if (!s) return "";
          var when = (sharedName?sharedName+'さん：':'') + fmtDateW(s.date) + " " + s.start + "〜" + endTime(s.start, s.min);
          if (pending.kind === "accept") {
            return '<dialog id="schedule-accept-dialog" class="schedule-day-dialog" aria-labelledby="schedule-accept-title" aria-describedby="schedule-accept-message"><div class="schedule-dialog-heading"><h2 id="schedule-accept-title">授業を予定する</h2></div><p id="schedule-accept-message">' + esc(when) + ' の授業を予定しますか？</p><div class="row"><button type="button" class="btn-primary" data-action="doaccept">OK</button><button type="button" class="btn-quiet" data-action="closebar" autofocus>やめる</button></div></dialog>';
          }
          var html = '<div class="confirmbar"><div class="inner">';
          if (pending.kind === "decline") {
            html += '<div class="msg">' + esc(when) + " の日時の再調整を先生にお願いしますか?<br><span class='small muted'>この案内は取り下げられ、先生が別の日時を登録します。</span></div>";
            html += '<div class="row"><button class="btn-danger" data-action="dodecline"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "再調整をお願いする") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "cancel") {
            var deadline = Date.parse(s.date+'T23:00:00+09:00')-86400000;
            var late = Date.now()>deadline;
            html = '<dialog id="schedule-accept-dialog" class="schedule-day-dialog" aria-label="キャンセル申請"><div class="inner">';
            html += '<div class="msg">' + esc(when) + ' のキャンセル申請</div>';
            html += '<p><strong>キャンセル料は、申請理由を確認したうえで確定します。</strong></p>';
            html += '<p>前日23時を過ぎて授業開始前までのキャンセルは、原則として1回1,000円、授業開始後・無断欠席は授業料相当額がかかります。</p><p>急病・災害などの事情がある場合は、理由を記入してください。先生が事情を確認し、キャンセル料の減額・免除を含めて判断します。</p><p>申請後、先生の確認をもってキャンセルが確定します。</p>';
            html += '<input type="text" id="f-creason" maxlength="1000" required value="' + esc(pending.reason || '') + '" placeholder="理由（必須）" style="width:100%;margin:6px 0 8px">';
            html += '<div class="row"><button class="btn-danger" data-action="docancel"' + (busy ? " disabled" : "") + '>' + (busy ? '申請しています…' : 'キャンセルを申請する') + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          } else if (pending.kind === "withdraw") {
            html += '<div class="msg">' + esc(when) + " の取消依頼を取り下げて、予定どおり授業を受けますか?</div>";
            html += '<div class="row"><button class="btn-primary" data-action="dowithdraw"' + (busy ? " disabled" : "") + ">" + (busy ? "送信しています…" : "依頼を取り下げる") + '</button><button class="btn-quiet" data-action="closebar">やめる</button></div>';
          }
          return html + (pending.kind==='cancel'?' </div></dialog>':'</div></div>');
        }

        // 予定ページの画面下: 日付を選択中のバー(授業できない日・希望・予定共有)
        function renderSelBar(D, inline) {
          if (!selMode) return "";
          var blocked = D.blocked;
          var selDates = Object.keys(selDays).filter(function (d) { return selDays[d]; }).sort();
          var selTxt = selDates.length ? selDates.map(fmtDateW).join("、") : "予定表の日付をタップすると選べます(もう一度タップで取り消し)";
          var html = '<div class="confirmbar selbar ' + selMode + ((selMode==='wish'||selMode==='ng')?' availability-form':'') + '"' + (inline ? ' style="position:static;margin-top:14px;padding:14px 0 0;box-shadow:none"' : '') + '><div class="inner">';
          if(selMode === "wish" || selMode === "ng")html += '<div class="row" role="group" aria-label="授業可能・不可" style="margin-bottom:12px">'+['wish','ng'].map(function(mode){return '<button type="button" class="'+(selMode===mode?'btn-primary':'btn-quiet')+'" aria-pressed="'+(selMode===mode)+'" data-action="dayact" data-m="'+mode+'" data-date="'+esc(selDates[0]||D.today)+'">'+(mode==='wish'?'授業可能':'授業不可')+'</button>';}).join('')+'</div>';
          if (selMode === "ng" || selMode === "wish") {
            var unavailable=selMode==='ng',prefix=unavailable?'b-ng':'b-w';
            if(!unavailable)html+=wishModeField('b');
            html += '<div class="row"><label>日付 <input type="date" id="'+(unavailable?'b-ngdate':'b-wishdate')+'" min="'+esc(D.today)+'" value="'+esc(selDates[0]||D.today)+'"></label><label'+(unavailable?'':' style="visibility:hidden" aria-hidden="true"')+'><input type="checkbox" '+(unavailable?'id="b-ngall" checked':'disabled tabindex="-1"')+'> 終日</label></div><div class="row" style="margin:12px 0"><label>開始 <input type="time" id="'+prefix+'start" step="900" '+(unavailable?'disabled':'value="13:00"')+'></label><span>〜</span><label>終了 <input type="time" id="'+prefix+'end" step="900" '+(unavailable?'disabled':'value="18:00"')+'></label></div>';
            html += '<div class="row"><input type="text" id="'+prefix+'note" placeholder="メモ（任意）" maxlength="'+(unavailable?50:100)+'" style="flex:1;min-width:140px"><button class="btn-primary" data-action="selapply"'+(busy||previewK||!selDates.length?' disabled':'')+'>'+(busy?'登録しています…':'登録')+'</button></div>';
          } else if (selMode === "want") {
            html += wishModeField('b');
            var wishLessons=[];
            (S.planLines||[]).concat(S.slots||[]).forEach(function(l){if(l.subject){var label=lessonLabel(l,true);if(wishLessons.indexOf(label)<0)wishLessons.push(label);}});
            html += '<div class="row"><label>日付 <input type="date" id="b-wdate" min="'+esc(D.today)+'" value="'+esc(selDates[0]||D.today)+'"></label><label>授業（任意） <select id="b-wlesson"><option value="">指定なし</option>'+wishLessons.map(function(label){return '<option value="'+esc(label)+'">'+esc(label)+'</option>';}).join('')+'</select></label></div><p class="note">この日時に1コマの授業を希望します。先生からの案内をお待ちください。</p><div class="row"><label>開始時刻 <input type="time" id="b-wstart" value="17:00" step="900"></label><label>授業時間 <select id="b-wmin"><option value="30">30分</option><option value="45">45分</option><option value="60">60分</option><option value="90" selected>90分</option><option value="120">120分</option></select></label></div><p><input type="text" id="b-wnote" maxlength="100" placeholder="メモ（任意）" style="width:100%;box-sizing:border-box"></p><button class="btn-primary" data-action="selapply"'+(busy||previewK?' disabled':'')+'>希望を送る</button>';
          } else if (selMode === "event") {
            html += '<p><label>日付 <input type="date" id="b-edate" min="'+esc(D.today)+'" value="'+esc(selDates[0]||D.today)+'"></label></p>';
            html += '<div class="row"><input type="text" id="b-etitle" placeholder="内容(例: 大会、高校見学)" maxlength="40" style="flex:1;min-width:160px"><button class="btn-primary" data-action="selapply"' + (busy || previewK || !selDates.length ? " disabled" : "") + '>' + (busy ? "送信中…" : "登録") + '</button></div>';
          }
          return html + (previewK?'<p class="note">プレビューでは登録・送信できません。</p>':'') + '</div></div>';
        }

        /* ---------- 文章で予定を登録(「選んだ日の予定」の＋を押すと既定で表示。GAS が AI で候補に変換 → ここで確認 → 既存の登録処理へ) ---------- */
        var NL_LABEL = { wish: '授業できる時間帯', block: '授業できない日', event: 'イベント' };
        function nlDates(dates) { return groupDays(dates).map(function (g) { return g.date === g.dateTo ? fmtDateW(g.date) : fmtDateW(g.date) + '〜' + fmtDateW(g.dateTo); }).join('、'); }
        // ＋の中の入力方法の切り替え(文章で予定を登録 / 手動で入力)
        function renderNaturalHelp(){return '<button class="btn-quiet btn-sm" data-action="helpnl" aria-expanded="'+helpNl+'">使い方</button>'+(helpNl?'<p class="note">文章を書いて「内容を確認」を押すと、AIが「授業できる時間帯」「授業できない日」「イベント」に分けて登録の下書きを作ります。内容を確認し、チェックした項目だけ登録してください。</p>':'');}
        function renderNaturalEntry() {
          var dis = NL.busy || busy ? ' disabled' : '';
          var h = '<div>';
          h += '<textarea id="nl-text" rows="3" maxlength="400" placeholder="予定を文章で入力。AIが予定に変換し、下書きを作ります" style="width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px"' + dis + '>' + esc(NL.text) + '</textarea>';
          h += '<div class="row" style="margin-top:8px"><button class="btn-primary btn-sm" data-action="nl-parse"' + (previewK?' disabled':dis) + '>' + (NL.busy ? '読み取っています…' : '内容を確認') + '</button>' + (NL.proposal || NL.text ? '<button class="btn-quiet btn-sm" data-action="nl-clear"' + dis + '>消す</button>' : '') + '</div>';
          if(previewK)h+='<p class="note">プレビューでは入力画面を確認できます。AIの解析・登録は実行しません。</p>';
          if (NL.error) h += '<p role="alert" style="color:var(--danger);margin:8px 0 0">' + esc(NL.error) + '</p>';
          if (NL.proposal) h += renderNaturalProposal(NL.proposal, dis);
          return h + '</div>';
        }
        function renderNaturalProposal(p, dis) {
          var h = '<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">';
          if (p.summary) h += '<p style="margin:0 0 6px">' + esc(p.summary) + '</p>';
          if (!p.items.length) h += '<div class="empty">登録できる予定を読み取れませんでした。日付と時間を入れて書き直してください。</div>';
          p.items.forEach(function (it, i) {
            var head = NL_LABEL[it.kind] + (it.kind === 'event' ? '：' + esc(it.title) + (it.test ? '（テスト・模試）' : '') : '');
            h += '<label class="task" style="align-items:flex-start"><input type="checkbox" data-action="nl-item" data-i="' + i + '"' + (it.sel ? ' checked' : '') + (it.done ? ' disabled' : dis) + '><span class="tt"><strong>' + head + '</strong>' + (it.done ? ' <span class="tag green">登録済み</span>' : '') + '<br>' + esc(nlDates(it.dates));
            if (it.kind === 'wish') {
              if (it.needsTime) h += '<br><span class="small" style="color:var(--danger)">時間帯を入れてください</span>';
              h += '<br><input type="time" id="nl-start-' + i + '" value="' + esc(it.start || '') + '" step="900"' + dis + '><span class="muted">〜</span><input type="time" id="nl-end-' + i + '" value="' + esc(it.end || '') + '" step="900"' + dis + '>';
            } else if (it.start && it.end) h += ' ' + esc(it.start) + '〜' + esc(it.end);
            else if (it.kind === 'block') h += ' 終日';
            if (it.note) h += '<br><span class="small muted">' + esc(it.note) + '</span>';
            if (it.confidence === 'low') h += '<br><span class="small" style="color:var(--amber)">読み取りに自信がありません。内容を確認してください</span>';
            h += '</span></label>';
            if (it.kind === 'event') h += '<label class="small"><input type="checkbox" data-action="nl-event-block" data-i="' + i + '"' + (it.alsoBlock ? ' checked' : '') + (it.done ? ' disabled' : dis) + '>授業できない日にもする</label>';
          });
          if (p.questions && p.questions.length) h += '<ul class="small" style="margin:8px 0 0 18px;padding:0">' + p.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>';
          if (p.items.some(function (it) { return !it.done; })) h += '<div class="row" style="margin-top:10px"><button class="btn-primary" data-action="nl-register"' + dis + '>チェックした内容で登録する</button></div><p class="note">授業できる時間帯は先生への希望です。登録だけでは授業は確定しません。</p>';
          return h + '</div>';
        }
        function nlParse() {
          if (previewK || NL.busy || busy) return;
          var text = String(NL.text || '').trim(); if (!text) { toast('予定の文章を入れてください'); return; }
          var k = myKey(); NL.busy = true; NL.error = ''; NL.proposal = null; render();
          apiPost({ action: 'scheduleParse', k: k, text: text }).then(function (res) {
            if (k !== myKey()) return; NL.busy = false;
            if (res.error) NL.error = res.error;
            else { (res.items || []).forEach(function (it) { it.sel = true; if (it.kind === 'event') it.alsoBlock = false; if (it.kind === 'wish' && it.needsTime) { it.start = it.start || '13:00'; it.end = it.end || '18:00'; } }); NL.proposal = { items: res.items || [], questions: res.questions || [], summary: res.summary || '' }; }
            render();
          }).catch(function () { if (k !== myKey()) return; NL.busy = false; NL.error = '通信に失敗しました。電波の良いところでもう一度お試しください'; render(); });
        }
        function nlRegister() {
          var p = NL.proposal; if (previewK || !p || busy || NL.busy) return;
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

        function learningNavigation(family,grades) {
          var prefix=family?'#family/learning':'#learning';
          return '<h1>学習記録</h1><nav class="learning-navigation" aria-label="学習記録の種類"><a href="'+prefix+'"'+(!grades?' class="on" aria-current="page"':'')+'>授業の記録</a><a href="'+prefix+'/grades"'+(grades?' class="on" aria-current="page"':'')+'>成績</a></nav>';
        }
        function renderStudent() {
          if (route() === 'student-email') { renderTabs(); renderStudentEmail(); return; }
          renderTabs();
          if (route() === "family") { renderFamily(); return; }
          if (!S || !S.me) { renderGuard(); return; }
          var page = route();
          if (page !== "home") {
            var hh = previewBanner(false);if(page==='history'||page==='grades')hh+=learningNavigation(false,page==='grades');
            if (page === "grades") hh += renderGradesPage();
            else if (page === "tasks") hh += renderTasksPage();
            else if (page === "history") hh += renderHistoryPage();
            else hh += renderParentPage();
            hh += '<footer class="app"><span></span><span></span></footer>';
            app.innerHTML = hh;
            return;
          }
          app.innerHTML = renderHomePage();
        }

        /* ---------- ホーム: 予定表を最優先に、予定の編集・授業登録・授業計画の案内。宿題は専用メニューへ ---------- */
        var studentPlanId='';
        function renderStudentPlanDialog(){
          var l=(S&&S.planLines||[]).filter(function(x){return String(x.id)===studentPlanId;})[0];if(!l)return '';
          var content='<p>'+esc(planPeriod(l))+'・'+esc(lessonLabel(l))+'</p><p>'+esc(l.status==='approved'?planLimit(l):l.count)+'回・'+esc(l.lessonMin||'未設定')+(l.lessonMin?'分':'')+'</p><p>'+(l.status==='approved'?'承認済み':'承認待ち：承認・回数の調整・見送りは、保護者ページから行ってください。')+'</p>'+(l.comment?'<p style="white-space:pre-wrap">'+esc(l.comment)+'</p>':'')+window.StepwiseReport.outline(l.outline);
          return window.StepwiseCalendar.dayDialog({id:'student-plan-dialog',title:'授業計画の詳細',close:'student-planclose',content:content});
        }
        function renderHomePage(sharedCalendar) {
          var D = schedData(), today = D.today, mine = D.mine, events = D.events;
          var html = previewBanner(true);

          // 予定表と日付ごとの登録。日を選ぶモード中は見出しに案内を出す
          if (!sharedCalendar) { html += '<h2>予定表</h2>'; html += renderCal(D.info, today, true); }
          html += renderDayDetail(D, true, true);
          if (route() !== 'family') {
            var homework = visibleTasks().filter(function (t) { return !t.done && (!t.type || t.type === '宿題'); });
            html += '<h2>宿題 <span class="cnt">' + homework.length + '件</span></h2>' + taskFeedback();
            html += '<section class="card homework-panel" aria-label="未完了の宿題">' + (homework.length ? renderHomeHomeworkTable(homework) : '<p class="empty">未完了の宿題はありません。</p>') + '</section>';
            var waiting=visibleTasks().filter(function(t){return t.done&&!t.reviewedAt&&(!t.type||t.type==='宿題');});
            if(waiting.length)html+='<details><summary>先生の確認待ち '+waiting.length+'件</summary><div class="card">'+renderTaskRows(waiting)+'</div></details>';
          }

          var summary = renderMonthSummary(D);
          html += summary.progress;
          html += renderOffers(D);
          if(route()!=='family')html+=renderStudentPlanDialog();

          html += renderPendingBar(D);
          return html;
        }

        function cancelControl(s, compact) {
          if (s.req) return '<button class="btn-quiet btn-sm" data-action="askwithdraw" data-id="' + esc(s.id) + '">依頼を取り下げる</button>';
          if (typeof s.hours === "number" && s.hours < (S.cancelDeadlineH || 24)) return '<button class="btn-quiet btn-sm" data-action="askcancel" data-id="' + esc(s.id) + '">' + (compact ? 'キャンセル' : 'キャンセル') + '</button>';
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
        var helpToff = false, helpWish = false, helpNl = false; // 「登録不可」「授業可」「文章で予定を登録」の説明(？ボタン)の開閉
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
              if (it.record) h += publishedRecordItem(it.record, route() !== 'family'); // 保護者ページでは既読ラベル付き(操作なし)
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

        // 保護者の実施状況の末尾に、当月の実施合計だけを表示する。
        function renderParentThisMonth(d) {
          var tm = d.thisMonth || {};
          return '<div class="parent-progress-total" style="margin-top:16px">' + (d.month ? '<span class="small muted">' + esc(d.month) + '</span> ' : '') + '実施合計：' + esc(tm.count || 0) + '回 / ' + esc(tm.minutes || 0) + '分</div>';
        }
        function renderParent(data, family, childId, sectionOverride) {
          var d = data || P, activeBusy = family ? F.busy : busy, memoKey = family ? childId : myKey(), memos = family ? F.memos : parentPlanMemos;
          var html = family ? '' : '<div style="display:flex;justify-content:flex-end"><button class="btn-quiet btn-sm" data-action="parentclose"' + (activeBusy ? ' disabled' : '') + '>ログアウト</button></div>';
          var tm = d.thisMonth || {}, bill = d.billing, section=sectionOverride||parentSection();
          if (!family && parentPlanNotice) html += '<p class="parent-error" role="alert">' + esc(parentPlanNotice) + '</p>';
          if(!family)html += '<p><button class="btn-sm" data-action="' + (family ? 'fa-refresh' : 'parentrefresh') + '"' + (activeBusy ? " disabled" : "") + '>最新の情報を確認</button></p>';
          if(section==='home'){
          html += renderParentThisMonth(d);
          html += '<p>授業報告・請求・連絡は上のメニューから確認できます。</p>';
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
            pays.forEach(function (p) { html += '<tr><td>' + esc(p.ym) + '</td><td>' + yen(p.amount) + '</td><td>' + (p.status === "取消" ? '<span class="tag gray">キャンセル済みみ</span>' : p.status === "入金済" ? '<span class="tag green">入金済</span>' : '<span class="tag red">未入金</span>') + '</td><td>' + (p.paidDate ? fmtDY(p.paidDate) : "—") + '</td></tr>'; });
            html += '</table></div>';
          }

          }
          if(section==='plans'){
          var pls = d.planLines || [];
          var approvalHelpId='approval-help-'+encodeURIComponent(childId||'parent');
          html += '<h2>授業計画の案内<button type="button" class="approval-help-button" data-action="approval-help" aria-label="授業計画の案内について" aria-expanded="false" aria-controls="'+approvalHelpId+'">?</button></h2><div id="'+approvalHelpId+'" class="card note" hidden><p>この承認は、契約上、その期間に実施できる授業回数の上限を確認するものです。案内は科目・種類・期間ごとに届き、それぞれ承認できます。</p><p>授業料は、実際に実施した授業の分だけ発生します。承認した回数分の料金が、すべて発生するわけではありません。</p><p>予定を入れなかった分や、キャンセルは連絡の時刻に応じてキャンセル料がかかる場合があります。キャンセルには理由の記入と先生の承認が必要です。</p></div>';
          if (!pls.length) html += '<div class="empty">承認をお願いする予定はいまありません</div>';
          else {
            html += '<div class="card">';
            if (pls.some(function(l){return l.status==='proposed';})) html += '<div class="plan-invitation-intro"><p><strong>先生から、以下の回数・料金で授業を進めたいという案内が届いています。</strong></p><p>期間・科目・1回の授業時間・回数・料金をご確認いただき、内容がよろしければ「承認する」を押してください。承認いただいた回数を上限に、授業を計画・実施します。</p><p><strong>授業料が発生するのは、実際に実施した授業の分だけです。</strong>承認した回数をすべて受ける必要はなく、実施しなかった分の授業料はかかりません。</p></div>';
            pls.forEach(function (l) {
              html += '<div style="padding:12px 0;border-bottom:1px solid var(--line)"><strong>'+esc(planPeriod(l))+'</strong>'+(l.status==='approved'?' <span class="tag green">承認済み</span>':l.status==='declined'?' <span class="tag gray">見送り</span>':' <span class="tag amber">承認待ち</span>');
              html += '<p>'+esc(planName(l))+(l.addon?' <span class="tag gray">追加</span>':'')+'　'+(l.lessonMin?esc(l.lessonMin)+'分 × ':'')+(l.addon?'＋':'')+esc(planLimit(l))+'回まで</p>'+(l.comment?'<p class="note" style="white-space:pre-wrap"><strong>先生から：</strong>'+esc(l.comment)+'</p>':'')+'<p><strong>'+(planFee(l)?'1回 '+yen(l.lessonFee!=null?l.lessonFee:Math.round((Number(l.rate30)||0)*l.lessonMin/30)):'授業時間・料金は先生に確認してください')+'</strong></p>';
              html += window.StepwiseReport.outline(l.outline);
              if(l.status==='proposed'&&l.revision!=null)html+='<div class="row"><button class="btn-primary btn-sm" data-action="'+(family?'fa-planok':'planok')+'" data-line="'+esc(l.id)+'"'+(activeBusy?' disabled':'')+'>承認する</button><button class="btn-quiet btn-sm" data-action="'+(family?'fa-planng':'planng')+'" data-line="'+esc(l.id)+'"'+(activeBusy?' disabled':'')+'>'+(family?'回数を調整・見送る':'見送る')+'</button></div>';
              if(l.memo)html+='<p class="note">'+esc(l.memo)+'</p>';
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
        var F = { step: "login", invite: "", email: "", home: null, childrenData: Object.create(null), childState: Object.create(null), stateBusy: '', stateSeq: 0, mypageTab: 'home', studentId: "", busy: false, message: "", error: "", seq: 0, challenge: "", challengeKind: "", verificationInfo: null, verificationInvalid: false, confirm: null, memos: Object.create(null) };
        function familyToken() { return PREVIEW ? "preview" : (ssGet("sw_ft_v1") || ""); }
        function familyMypageChild() { var list = F.home && F.home.children || []; if (!list.length) return null; return list.filter(function (x) { return sameId(x.studentId, F.studentId); })[0] || list[0]; }
        // 子どものマイページ状態は他の読み込み(旧データ・お知らせ)と並行して取る(F.busy とは別枠)。ホームはこれが届いた時点で表示できる
        function familyLoadChildState(id) {
          if (!F.home || !id || F.stateBusy === id) return;
          var token = familyToken(), seq = ++F.stateSeq; F.stateBusy = id;
          apiPost({ action: 'familyStudentState', ftoken: token, studentId: id }).then(function (res) {
            if (seq !== F.stateSeq || token !== familyToken()) return;
            F.stateBusy = '';
            if (res.error) { if (res.familyAuthRequired) familyClear(); F.error = res.error; familyRender(); return; }
            F.childState[id] = res; var c = familyMypageChild(); if (c && sameId(c.studentId, id)) S = res; familyRender();
          }).catch(function () { if (seq !== F.stateSeq || token !== familyToken()) return; F.stateBusy = ''; F.error = '通信に失敗しました。通信状態を確認して再試行してください。'; familyRender(); });
        }
        function familySelectChild(id) { F.studentId = id; F.confirm = null; G = null; GX = []; gLoading = false; selDate = null; selManual = false; selMode = ''; selDays = {}; dayAddOpen = false; pending = null; histFolder = null; NL = { text: '', busy: false, proposal: null, error: '' }; var c = familyMypageChild(); S = c && F.childState[c.studentId] || null; if (c && !S) familyLoadChildState(c.studentId); }
        // fixedTab: 'grades'=成績、'history'=授業の記録(既読機能付き)。空ならホーム。いずれも上のナビから
        // メール通知の種類別オン・オフ(保護者)。変更はすぐ保存
        function renderFamilyMailPrefs(dis) {
          var prefs = (F.home && F.home.emailPrefs) || {}, kinds = [['planProposed', '月の回数・料金の確認依頼'], ['invoiceCreated', '請求の記録'], ['invoiceVoided', '請求の取消']];
          var h = '<div class="card" style="margin-top:12px"><h3 style="margin:0 0 6px;font-size:16px">メール通知</h3>';
          kinds.forEach(function (kv) { h += '<label style="display:block;padding:6px 0"><input type="checkbox" data-action="fa-mailpref" data-kind="' + kv[0] + '"' + (prefs[kv[0]] === false ? '' : ' checked') + dis + '> ' + kv[1] + '</label>'; });
          return h + '<p class="note">オフにした項目はメールを送りません（保護者ページのお知らせでは引き続き確認できます）。変更はすぐに保存されます。メールアドレスの確認や再設定のメールは対象外です。</p></div>';
        }
        // 授業計画の回答(承認・回数調整)の確認カード。保護者メニューとマイページの授業計画で共用
        function renderFamilyPlanConfirm(dis) {
          if (!F.confirm) return '';
          var c = F.confirm, l = c.line || {}, h = '<div class="card" role="region" aria-label="授業計画の回答確認"><strong>' + esc((F.childrenData[c.studentId] || {}).name) + '・' + esc(planPeriod(l)) + '</strong>';
          function dialog(content){return window.StepwiseCalendar.dayDialog({id:'family-plan-dialog',title:'授業計画の回答確認',help:['期間・科目・回数・授業時間・料金をご確認ください。','「承認する」は案内された回数で承認します。「回数を調整」は承認できる回数を選びます。「見送る」は今回の計画を承認せず、先生に伝えます。いずれも確認画面のあとに送信されます。','承認する回数は、その期間に実施できる授業回数の上限です。授業料は実際に実施した授業の分だけ発生します。','承認しても授業日時は登録されません。授業の案内から、別途「予定する」を押してください。'],close:'fa-cancel',busy:F.busy,content:(F.error?'<p role="alert">'+esc(F.error)+'</p>':'')+content});}
          if(c.stage==='detail')return dialog(h+'<p>'+esc(planName(l))+' '+esc(planLimit(l))+'回・'+esc(l.lessonMin)+'分'+(planFee(l)?'（'+esc(planFee(l))+'）':'')+'</p><p>承認済み</p>'+(l.comment?'<p style="white-space:pre-wrap">'+esc(l.comment)+'</p>':'')+'</div>');
          if(c.stage==='choose'){
            h+='<p>'+esc(planName(l))+' '+esc(l.count)+'回・'+esc(l.lessonMin)+'分'+(planFee(l)?'（'+esc(planFee(l))+'）':'')+'</p>'+(l.comment?'<p style="white-space:pre-wrap">'+esc(l.comment)+'</p>':'');
            h+='<div class="row"><button class="btn-primary" data-action="fa-planok" data-child="'+esc(c.studentId)+'" data-line="'+esc(l.id)+'"'+dis+'>承認する</button><button class="btn-quiet" data-action="fa-planng" data-child="'+esc(c.studentId)+'" data-line="'+esc(l.id)+'"'+dis+'>回数を調整</button><button class="btn-quiet" data-action="fa-planskip" data-child="'+esc(c.studentId)+'" data-line="'+esc(l.id)+'"'+dis+'>見送る</button></div></div>';
            return dialog(h);
          }
          if (c.stage === 'ack') {
            h += '<p>先生が記録した承認（' + esc(planName(l)) + ' ' + esc(planLimit(l)) + '回）について、先生に伝える内容を書いてください。先生に通知が届き、折り返し連絡があります。</p><label>先生への伝言<textarea id="fa-plan-message" maxlength="500" placeholder="例: 電話で話した回数と違うようです">' + esc(c.memo || '') + '</textarea></label><p><button class="btn-primary" data-action="fa-ack-send"' + dis + '>問い合わせを送る</button> <button class="btn-quiet" data-action="fa-cancel"' + dis + '>戻る</button></p></div>';
            return h;
          }
          if (c.stage === 'reduce') {
            h += '<p>承認できる回数を選んでください。</p><p><label>' + esc(planName(l)) + ' <select id="fa-reduce-0">';
            for (var n = 1; n <= Number(l.count || 0); n++) h += '<option value="' + n + '"' + (n === c.approvedCount ? ' selected' : '') + '>' + n + '回</option>';
            h += '</select></label></p><label>先生への伝言（任意）<textarea id="fa-plan-message" maxlength="500">' + esc(c.memo || '') + '</textarea></label><p><button class="btn-primary" data-action="fa-plan-review">この内容を確認する</button></p>';
          } else {
            h += '<p>' + esc(planName(l)) + (l.addon ? '（追加）' : '') + ' ' + (l.addon ? '＋' : '') + c.approvedCount + '回まで' + (planFee(l) ? '（' + esc(planFee(l)) + '）' : '') + '</p>' + (l.comment ? '<p class="note" style="white-space:pre-wrap"><strong>先生から：</strong>' + esc(l.comment) + '</p>' : '');
            h += c.approve ? '<p>この回数以内で授業の計画を立てることができます。授業実施前であれば、いつでもシステムまたはLINEから計画の見直しを申し出ることができます。承認しますか？</p>' : '<p>今回は見送ります。先生にこの内容を伝えますか？</p>';
            if (c.memo) h += '<p>' + esc(c.memo) + '</p>';
            h += '<button class="btn-primary" data-action="fa-decide"' + (previewK?' disabled':dis) + '>' + (c.approve ? '承認する' : '今回は見送る') + '</button> ';
          }
          h += '</div>';
          return dialog(h);
        }
        var familyHomeViews = Object.create(null);
        function homeView() { return {calY:calY,calM:calM,selDate:selDate,selManual:selManual,dayAddOpen:dayAddOpen,dayInputMode:dayInputMode,selMode:selMode,selDays:selDays,pending:pending,NL:NL}; }
        function useHomeView(v) { calY=v.calY;calM=v.calM;selDate=v.selDate;selManual=v.selManual;dayAddOpen=v.dayAddOpen;dayInputMode=v.dayInputMode;selMode=v.selMode;selDays=v.selDays;pending=v.pending;NL=v.NL; }
        function freshHomeView() { return {calY:calNow.getFullYear(),calM:calNow.getMonth(),selDate:null,selManual:false,dayAddOpen:false,dayInputMode:'manual',selMode:'',selDays:{},pending:null,NL:{text:'',busy:false,proposal:null,error:''}}; }
        function familyHomeTarget(el) {
          var owner=el&&el.getAttribute&&el.getAttribute('data-home-child')?el:el&&el.closest&&el.closest('[data-home-child]');
          if(!owner)return true;
          var id=owner.getAttribute('data-home-child'),current=familyMypageChild();
          if(current&&sameId(current.studentId,id))return true;
          if(busy||F.busy||NL.busy)return false;
          if(current){familyHomeViews[current.studentId]=homeView();familyHomeViews[current.studentId].dayAddOpen=false;familyHomeViews[current.studentId].selMode='';familyHomeViews[current.studentId].pending=null;}
          F.studentId=id;S=F.childState[id];useHomeView(familyHomeViews[id]||freshHomeView());return !!S;
        }
        var familyDayChooser='';
        function familyChildName(c) {
          var children=F.home.children||[],given=c.givenName||(F.childState[c.studentId]||{}).me?.givenName;
          return given&&children.filter(function(x){return (x.givenName||(F.childState[x.studentId]||{}).me?.givenName)===given;}).length===1?given:c.name;
        }
        function familyOwnedHtml(html,id,scopeActions){
          return html.replace(/<[^>]+>/g,function(tag){
            if(scopeActions!==false&&/\sdata-(?:action|accept-id)=/.test(tag))tag=tag.replace(/(?=\sdata-(?:action|accept-id)=)/,' data-home-child="'+esc(id)+'"');
            return tag.replace(/((?:id|aria-controls)=")(plan-status-help-|progress-approval-)/g,'$1$2'+esc(id)+'-');
          });
        }
        var familyCalendar = {year:calNow.getFullYear(),month:calNow.getMonth(),date:null,hidden:{}};
        function renderFamilyCalendar(children) {
          var src={lessons:[],events:[],blocked:[],wishes:[],teacherOff:[]},offs={},today='',missing=false;
          children.forEach(function(c){
            var st=F.childState[c.studentId];if(!st||!st.me){missing=true;return;}
            today=today||st.today;
            (st.teacherOff||[]).forEach(function(x){var key=x.date+'|'+x.start+'|'+x.end;if(!offs[key]){offs[key]=true;src.teacherOff.push(x);}});
            if(children.length>1&&familyCalendar.hidden[c.studentId])return;
            var name=familyChildName(c);
            (st.slots||[]).concat(st.cancellations||[]).concat((st.history||[]).map(function(x){return Object.assign({},x,{st:x.done?'done':'past'});})).forEach(function(x){src.lessons.push(Object.assign({},x,{studentLabel:name}));});
            (st.events||[]).forEach(function(x){src.events.push(Object.assign({},x,{title:name+' '+(x.title||'イベント')}));});
            (st.blocked||[]).forEach(function(x){src.blocked.push(Object.assign({},x,{label:name+' 授業不可'}));});
            (st.wishes||[]).forEach(function(x){src.wishes.push(Object.assign({},x,{label:name+' '+(x.start||'')+'〜'+(x.end||'')+' 授業可'}));});
          });
          if(!today)return '<h2>予定表</h2><p role="status">予定を読み込んでいます…</p>';
          if(!familyCalendar.date){familyCalendar.date=today;familyCalendar.year=+today.slice(0,4);familyCalendar.month=+today.slice(5,7)-1;}
          src.lessonLabel=function(x){return x.studentLabel+' '+lessonLabel(x);};
          var filters=children.length>1?'<div class="family-calendar-filter" role="group" aria-label="カレンダーに表示する生徒"><span class="small muted">表示する生徒</span>'+children.map(function(c){var visible=!familyCalendar.hidden[c.studentId];return '<button type="button" class="btn-quiet btn-sm" data-action="family-calfilter" data-child="'+esc(c.studentId)+'" aria-pressed="'+visible+'">'+esc(familyChildName(c))+'<span class="small"> '+(visible?'表示中':'非表示')+'</span></button>';}).join('')+'</div>':'';
          var h='<h2>予定表</h2>'+filters+window.StepwiseCalendar.render(window.StepwiseCalendar.buildInfo(src),{year:familyCalendar.year,month:familyCalendar.month,today:today,selDate:familyCalendar.date,showToff:true,overlapLanes:true,cancelLegend:true,compactAvailabilityLegend:true,toffLegend:"教室都合",offerLegend:'授業（未登録）',eventLegend:'イベント'});
          h=h.replace(/data-action="cal/g,'data-action="family-cal');
          return h+(missing?'<p role="status">ほかのお子さんの予定を読み込んでいます…</p>':'');
        }
        function renderFamilyProposalTable(head,rows,confirms) {
          return '<div class="card">'+(confirms||'')+(rows?head+rows+'</tbody></table></div>':'<div class="empty">新しい案内はありません</div>')+'</div>';
        }
        function renderFamilyTuition() {
          var months=[];(F.home.children||[]).forEach(function(c){var d=F.childrenData[c.studentId],st=F.childState[c.studentId],ym=d&&d.month||String(st&&st.today||'').slice(0,7);if(ym&&months.indexOf(ym)<0)months.push(ym);});
          var monthLabel=months.sort().map(function(ym){return ym.slice(0,4)+'年'+Number(ym.slice(5,7))+'月';}).join('・');
          var h='<h2>授業料</h2><div class="card"><p class="small">今月の金額の目安です。未承認の計画も含みます。請求額は「請求・お支払い」でご確認ください。</p><p class="tuition-month">'+esc(monthLabel)+'</p><div class="tbwrap"><table class="tb"><thead><tr><th>名前</th><th>内訳</th><th>実施済み</th><th>登録分</th><th>計画分</th></tr></thead><tbody>',total=[0,0,0],complete=[true,true,true];
          function money(v){return v==null?'確認が必要':yen(v);}
          (F.home.children||[]).forEach(function(c){
            var d=F.childrenData[c.studentId],st=F.childState[c.studentId];
            if(!st&&!F.stateBusy&&!F.error)familyLoadChildState(c.studentId);
            if(!d||!st){h+='<tr><td>'+esc(familyChildName(c))+'</td><td colspan="4">'+(F.error?'料金を読み込めませんでした'+(!d?'<button class="btn-quiet" data-action="fa-refresh" data-child="'+esc(c.studentId)+'">再試行</button>':''):'読み込み中…')+'</td></tr>';complete=[false,false,false];return;}
            var ym=d.month||String(st.today||'').slice(0,7),lines=(d.planLines||[]).filter(function(l){return l.status==='approved'||l.status==='proposed';});
            function rate(l){return l.rate30!=null&&Number.isFinite(Number(l.rate30))&&Number(l.rate30)>=0?Number(l.rate30):l.lessonFee!=null&&Number(l.lessonMin)>0?Number(l.lessonFee)*30/Number(l.lessonMin):null;}
            function sum(items,calc){var n=0;for(var i=0;i<items.length;i++){var v=calc(items[i]);if(v==null||!Number.isFinite(v))return null;n+=v;}return n;}
            function fee(x){var matches=lines.filter(function(l){return lessonLabel(l)===lessonLabel(x)&&planCovers(l,x.date);}),rates=matches.map(rate);if(!rates.length||rates.some(function(r){return r==null||r!==rates[0];})||!Number(x.min))return null;return Math.round(Number(x.min)*rates[0]/30);}
            var done=(st.history||[]).filter(function(x){return x.done&&String(x.date).slice(0,7)===ym;}),ids=done.map(function(x){return x.id;}),booked=(st.slots||[]).filter(function(x){return x.st==='mine'&&String(x.date).slice(0,7)===ym&&ids.indexOf(x.id)<0;});
            var plans=lines.filter(function(l){return String(l.startDate||'').slice(0,7)<=ym&&String(l.endDate||'').slice(0,7)>=ym;});
            var values=[sum(done,fee),sum(done.concat(booked),fee),sum(plans,function(l){var r=rate(l);return r==null||!Number(l.lessonMin)?null:Math.round(Number(l.lessonMin)*r/30)*planLimit(l);})];
            var cancellations=(st.cancellations||[]).filter(function(x){return String(x.date).slice(0,7)===ym;});
            values.push(sum(cancellations,function(x){return x.amount==null||String(x.amount).trim()===''?null:Number(x.amount);}));
            if(d.thisMonth&&d.thisMonth.count!=null&&Number(d.thisMonth.count)!==done.length){values[0]=null;values[1]=null;}
            var cancellationFee=values.pop(),subtotals=values.map(function(v){return v==null||cancellationFee==null?null:v+cancellationFee;});
            subtotals.forEach(function(v,i){if(v==null)complete[i]=false;else total[i]+=v;});
            h+='<tr><td rowspan="2">'+esc(familyChildName(c))+'</td><th scope="row">授業</th>'+values.map(function(v){return '<td>'+money(v)+'</td>';}).join('')+'</tr>';
            h+='<tr><th scope="row">キャンセル料</th>'+values.map(function(){return '<td>'+money(cancellationFee)+'</td>';}).join('')+'</tr>';
          });
          h+='</tbody><tfoot><tr><th colspan="2">合計</th>'+total.map(function(v,i){return '<td>'+money(complete[i]?v:null)+'</td>';}).join('')+'</tr></tfoot></table></div><p class="small">実施済み：実施した授業 ／ 登録分：実施済み＋今後の登録済み授業（返事前の案内は含みません） ／ 計画分：今月にかかる送信済み計画の全回数分。合計は各列の授業料にキャンセル料を加えた金額です。列同士は足し合わせません。キャンセル料は当月の授業について、減額・免除を反映した現在の金額です。減額・免除の申請中は審査前の金額を表示します。</p><p class="small">計画の単価と授業時間で計算します。単価が未設定・特定できない場合は「確認が必要」と表示します。</p></div>';return h;
        }
        function renderFamilyPlans() {
          var children=F.home.children||[],savedId=F.studentId,savedS=S,rows='',head='',confirms='',missing=[];
          if(!children.length)return '<h2>授業計画</h2><p>子どもの紐付けを先生にご依頼ください。</p>';
          children.forEach(function(c){
            var data=F.childrenData[c.studentId];if(!data){missing.push(c);return;}
            // Use the current parent response so an approval immediately disappears from the proposals.
            F.studentId=c.studentId;
            S={me:{name:c.name},planLines:data.planLines||[],history:[]};
            var today=(F.childState[c.studentId]||{}).today||(data.month?data.month+'-01':new Date().toISOString().slice(0,10));
            var summary=renderMonthSummary({today:today,mine:[]},familyChildName(c));
            head=summary.proposalHead;rows+=familyOwnedHtml(summary.proposalRows||'',c.studentId,false);confirms+=summary.confirm||'';
          });
          F.studentId=savedId;S=savedS;
          var h='<h2>授業計画</h2>';
          if(rows||!missing.length)h+=renderFamilyProposalTable(head,rows,confirms);
          missing.forEach(function(c){h+=F.busy?'<p role="status">計画を読み込んでいます…</p>':'<p>'+esc(familyChildName(c))+'の計画を読み込めませんでした。<button class="btn-quiet btn-sm" data-action="fa-refresh" data-child="'+esc(c.studentId)+'">再試行</button></p>';});
          return h;
        }
        function renderFamilyHomeAll() {
          var children=F.home.children||[],current=familyMypageChild(),savedId=F.studentId,savedS=S,savedView=homeView(),h=previewBanner(true);
          if(!children.length)return '<p>子どもの紐付けを先生にご依頼ください。</p>';
          if(current)familyHomeViews[current.studentId]=savedView;
          h+=renderFamilyCalendar(children);
          var rows=[],dialogs='',progress='',confirms='',offers='',offerCount=0,planCount=0,remain=0,total={count:0,minutes:0},month='',today='',canAI=false,offsShown=false;
          children.forEach(function(c){
            var st=F.childState[c.studentId];
            if(!st||!st.me){if(!F.stateBusy)familyLoadChildState(c.studentId);return;}
            F.studentId=c.studentId;S=st;useHomeView(familyHomeViews[c.studentId]||freshHomeView());
            if(familyCalendar.date){selDate=familyCalendar.date;selManual=true;}
            var name=familyChildName(c),D=schedData(),day=renderDayDetail(D,true,!offsShown,{name:name}),summary=renderMonthSummary(D);
            offsShown=true;today=today||D.today;canAI=canAI||!!st.nlEnabled||!!previewK;
            function owned(markup){return familyOwnedHtml(markup,c.studentId);}
            day.rows.forEach(function(row){rows.push({start:row.start,html:owned(row.html)});});
            dialogs+=owned(day.dialogs)+owned(renderPendingBar(D,name));
            progress+='<section class="family-student-progress"><h3>'+esc(name)+'</h3>'+ (summary.progressRows?owned(summary.progressHead+summary.progressRows+'</tbody></table></div>'):'<div class="empty">送信済みの計画はありません</div>')+'</section>';confirms+=owned(summary.confirm||'');
            planCount+=summary.planCount||0;remain+=summary.remain||0;
            offers+=owned(renderOffers(D,name));offerCount+=D.offers.length;
            var data=F.childrenData[c.studentId];if(data){month=month||data.month;var tm=data.thisMonth||{};total.count+=Number(tm.count)||0;total.minutes+=Number(tm.minutes)||0;}
            familyHomeViews[c.studentId]=homeView();
          });
          F.studentId=savedId;S=savedS;useHomeView(current&&familyHomeViews[current.studentId]||savedView);
          if(!today)return h;
          var canAdd=familyCalendar.date>=today;
          h+=window.StepwiseCalendar.dayHeading({date:familyCalendar.date,title:fmtDateW(familyCalendar.date)+'の授業',disabled:busy||NL.busy,add:canAdd?{action:'family-dayadd',label:'この日に予定を追加'}:null,ai:canAdd&&canAI?{action:'family-dayai',label:'AIで予定登録'}:null});
          h+=rows.length?'<div class="card daylist">'+rows.sort(function(a,b){return a.start.localeCompare(b.start);}).map(function(r){return r.html;}).join('')+'</div>':'<div class="empty">この日の予定はありません</div>';
          h+='<section class="parent-progress"><h2>授業計画・実施状況 <span class="cnt">'+planCount+'件の計画</span></h2><div class="card">';
          h+=progress||'<div class="empty">送信済みの計画はありません</div>';
          if(remain)h+='<p class="small">あと '+remain+' 回、日程調整が必要です。</p>';
          h+=renderParentThisMonth({month:month,thisMonth:total})+'</div></section>';
          if(offers)h+=foldHead('offers','授業登録',offerCount+'件・返事をお願いします')+offers+'</details>';
          h+=confirms+dialogs;
          if(familyDayChooser){
            var choices=children.filter(function(c){return F.childState[c.studentId]&&(familyDayChooser!=='dayai'||previewK||F.childState[c.studentId].nlEnabled);}).map(function(c){return '<button class="btn-quiet" data-home-child="'+esc(c.studentId)+'" data-action="'+familyDayChooser+'">'+esc(familyChildName(c))+'</button>';}).join('');
            h+=window.StepwiseCalendar.dayDialog({id:'schedule-day-editor',title:'登録するお子さんを選択',close:'family-dayclose',content:'<div class="row">'+choices+'</div>'});
          }
          return h;
        }
        var familyHistoryFolders=Object.create(null);
        function renderFamilyRecords(){
          var savedS=S,savedFolder=histFolder,h='<p class="sub">授業の記録（'+(PREVIEW?'プレビューでは既読を付けません':'開くと既読になります')+'）</p>';
          (F.home.children||[]).forEach(function(c){
            h+='<h2>'+esc(familyChildName(c))+'</h2>';
            var st=F.childState[c.studentId];
            if(!st||!st.me){if(!F.stateBusy&&!F.error)familyLoadChildState(c.studentId);h+='<p>授業の記録を読み込んでいます…</p>';return;}
            S=st;histFolder=familyHistoryFolders[c.studentId]||null;
            h+='<section id="family-records-'+esc(c.studentId)+'" data-family-child="'+esc(c.studentId)+'">'+familyOwnedHtml(renderHistoryPage(),c.studentId)+'</section>';
          });S=savedS;histFolder=savedFolder;return h;
        }
        var familyGrades=Object.create(null);
        function renderFamilyGrades(){
          var h=previewBanner(true),savedG=G,savedGX=GX;
          (F.home.children||[]).forEach(function(c){
            var id=c.studentId,token=familyToken(),key=JSON.stringify([token,id]),cache=familyGrades[key];
            h+='<h2>'+esc(familyChildName(c))+'</h2>';
            if(!cache){cache=familyGrades[key]={busy:true};apiPost({action:'grades',ftoken:token,studentId:id}).then(function(res){if(familyGrades[key]!==cache||token!==familyToken()||!F.home)return;cache.busy=false;if(res.error){cache.error=res.error;if(res.familyAuthRequired)familyClear();}else{cache.grades=res.grades||[];cache.exams=res.exams||[];}familyRender();}).catch(function(){if(familyGrades[key]!==cache)return;cache.busy=false;cache.error='成績を読み込めませんでした。';familyRender();});}
            if(cache.busy)h+='<p role="status">成績を読み込んでいます…</p>';
            else if(cache.error)h+='<p role="alert">'+esc(cache.error)+' <button data-action="fa-grades-retry" data-child="'+esc(id)+'">再試行</button></p>';
            else{G=cache.grades;GX=cache.exams;h+=renderGradesPage();}
            h+='<section id="family-grades-'+esc(id)+'" data-family-child="'+esc(id)+'" style="margin-top:18px"></section>';
          });G=savedG;GX=savedGX;return h;
        }
        function renderFamilyMypage(fixedTab) {
          var c = familyMypageChild(), h = previewBanner(true);
          if (!c) return h + '<p>子どもの紐付けを先生にご依頼ください。</p>';
          if ((F.home.children || []).length > 1) h += '<p><label class="small">表示する子ども <select id="fa-mychild">' + F.home.children.map(function (x) { return '<option value="' + esc(x.studentId) + '"' + (sameId(x.studentId, c.studentId) ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label></p>';
          var st = F.childState[c.studentId];
          if (!st || !st.me) { familyLoadChildState(c.studentId); return h + '<div class="loading"><div class="spinner"></div>' + esc(c.name) + 'さんのページを読み込んでいます…</div>'; }
          S = st;
          var tab = fixedTab || 'home';
          h += '<p class="sub">' + esc(c.name) + 'さんの' + (tab === 'grades' ? '成績' : tab === 'history' ? (PREVIEW ? '授業の記録（プレビューでは既読を付けません）' : '授業の記録（開くと既読になります）') : 'マイページ') + (PREVIEW ? '（表示のみ）' : '（保護者が代わりに操作できます）') + '</p>';
          if (tab === 'grades') h += renderGradesPage() + '<section id="family-grades-panel" data-family-child="' + esc(c.studentId) + '" style="margin-top:18px"></section>';
          else if (tab === 'tasks') h += renderTasksPage();
          else if (tab === 'history') h += '<section id="family-records-host" data-family-child="' + esc(c.studentId) + '">' + renderHistoryPage() + '</section>';
          else h += renderHomePage();
          return h;
        }
        function familyClear() { familyGrades=Object.create(null); F.studentChooser=false; F.profileEdit=null; familyHistoryFolders=Object.create(null); F.transferConfirm=null; familyDayChooser=''; familyCalendar={year:calNow.getFullYear(),month:calNow.getMonth(),date:null,hidden:{}}; familyHomeViews=Object.create(null); notices.items=[]; notices.open=false; ++notices.seq; notices.busy=false; ssDel("sw_ft_v1"); ssDel("sw_ft_v1:logout"); F.home = null; F.childrenData = Object.create(null); F.childState = Object.create(null); F.stateBusy = ''; ++F.stateSeq; F.studentId = ""; F.confirm = null; F.memos = Object.create(null); F.step = "login"; }
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
          if (!PREVIEW && ssGet("sw_ft_v1:logout")) { F.step = "logout"; familyRender(); return; }
          familyHomeViews=Object.create(null); F.childrenData = Object.create(null); F.childState = Object.create(null); F.stateBusy = ''; ++F.stateSeq; F.confirm = null; notices.items=[];
          familyRequest("familyHome", { ftoken: familyToken() }, function (res) { F.home = res; F.step = "home"; var list = res.children || []; if (!list.some(function(c){return sameId(c.studentId,F.studentId);})) F.studentId=""; var first = familyMypageChild(); if (first) familyLoadChildState(first.studentId); familyLoadChild(); });
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
            if(parentSection()==='home'){ app.innerHTML = h + renderFamilyHomeAll(); mountDayDialog(); mountAcceptDialog(); return; }
            if(parentSection()==='tasks'){ app.innerHTML = h + renderFamilyMypage('tasks'); return; }
            if(parentSection()==='grades'){ app.innerHTML = h + learningNavigation(true,true) + renderFamilyGrades(); return; }
            if(parentSection()==='records'){ app.innerHTML = h + learningNavigation(true,false) + renderFamilyRecords(); return; }
            if(parentSection()==='settings'){
            h += '<h2>保護者の設定</h2>';
            h += '<h2>資料</h2>'+(F.home.children||[]).map(function(c){return '<h3>'+esc(c.name)+'</h3><div data-student-documents="'+esc(c.studentId)+'"></div>';}).join('');
            var account=F.home.family||{},children=F.home.children||[];
            function infoCell(value,span,person,kind){var filled=!!String(value||'').trim();return '<td'+(span?' colspan="2"':'')+(!filled?' class="is-missing"':'')+'>'+(filled?esc(value):'<button class="family-info-empty" data-action="fa-profile-open" data-child="'+esc(person.studentId||'')+'" data-kind="'+kind+'">未登録</button>')+'</td>';}
            function personRows(label,person){return '<tr><th scope="row">'+esc(label)+'</th>'+infoCell(person.familyName,false,person,'name')+infoCell(person.givenName,false,person,'name')+'</tr><tr><th scope="row">メールアドレス</th>'+infoCell(person.email,true,person,'email')+'</tr>';}
            h += '<div class="card"><table class="family-info-table"><thead><tr><th scope="col">項目</th><th scope="col">姓</th><th scope="col">名</th></tr></thead><tbody>'+personRows('保護者名',account)+children.map(function(c){return personRows('生徒名',c);}).join('')+'</tbody></table><div class="row" style="margin-top:18px"><button class="btn-quiet btn-sm" data-action="fa-mode" data-step="emailChange"'+dis+'>メールアドレスを変更</button></div></div>';
            if(F.profileEdit){var pe=F.profileEdit;h+=window.StepwiseCalendar.dayDialog({id:'family-profile-dialog',title:pe.kind==='email'?'生徒の連絡用メールアドレスを登録':'姓・名を登録',close:'fa-profile-cancel',busy:F.busy,content:(F.error?'<p role="alert">'+esc(F.error)+'</p>':'')+(pe.studentId?'<p>'+esc(pe.name)+'</p>':'')+(pe.kind==='email'?'<label>メールアドレス<input id="fa-profile-email" type="email" value="'+esc(pe.email||'')+'"></label><p class="note">確認メールを送信します。届いたリンクを開くと登録が完了します。</p>':'<div class="row"><label>姓<input id="fa-profile-family" maxlength="80" value="'+esc(pe.familyName||'')+'"></label><label>名<input id="fa-profile-given" maxlength="80" value="'+esc(pe.givenName||'')+'"></label></div>')+(previewK?'<p class="note">プレビューでは保存・送信できません。</p>':'')+'<div class="row"><button class="btn-primary" data-action="fa-profile-save"'+(F.busy||previewK?' disabled':'')+'>'+(pe.kind==='email'?'確認メールを送る':'保存')+'</button></div>'});}
            h += '<div class="card"><h3>権限</h3><p class="note">生徒ページでできる操作を、生徒ごとに設定します。「保護者のみ」の操作は保護者ページから行ってください。</p><div style="overflow-x:auto"><table class="family-permissions"><thead><tr><th scope="col">操作</th>'+(F.home.children||[]).map(function(c){return '<th scope="col">'+esc(c.name)+'</th>';}).join('')+'</tr></thead><tbody>';
            [['booking','授業の登録'],['reschedule','授業の再調整・キャンセル'],['request','希望日時の登録'],['availability','授業可能・不可の登録'],['events','イベントの登録'],['email','連絡用メールアドレスの変更']].forEach(function(kv){h+='<tr><th scope="row">'+kv[1]+'</th>'+(F.home.children||[]).map(function(c){var allowed=!c.permissions||c.permissions[kv[0]]!==false;return '<td><select id="permission-'+esc(c.studentId)+'-'+kv[0]+'" data-action="fa-permission" data-child="'+esc(c.studentId)+'" data-permission="'+kv[0]+'" aria-label="'+esc(c.name)+' '+kv[1]+'"'+(F.busy||previewK?' disabled':'')+'><option value="true"'+(allowed?' selected':'')+'>許可する</option><option value="false"'+(!allowed?' selected':'')+'>保護者のみ</option></select></td>';}).join('')+'</tr>';});
            h += '</tbody></table></div><p class="note">授業計画の承認・調整・見送り、お支払いの報告、権限の変更は保護者のみ行えます。</p></div>';
            h += renderFamilyMailPrefs(dis);
            h += '<p class="note">共用端末では利用後にログアウトしてください。</p><p><button class="btn-quiet btn-sm" data-action="fa-logout"'+dis+'>ログアウト</button></p>';
              app.innerHTML=h;mountDayDialog();return;
            }
            // 保護者メニュー: 授業計画、授業料、請求・お支払い。
            h += renderFamilyPlans();
            h += renderFamilyTuition();
            h += '<h2>請求・お支払い</h2>';
            h += window.StepwiseReport.invoices(F.home.billing,F.home.family.label,{report:true,disabled:F.busy||!!previewK});
            if (!(F.home.children || []).length) h += '<p>子どもの紐付けを先生にご依頼ください。</p>';
            if(F.transferConfirm){h+=window.StepwiseCalendar.dayDialog({id:'family-transfer-dialog',title:'振込の報告',close:'fa-transfer-cancel',busy:F.busy,content:'<p>'+esc(F.transferConfirm.ym)+'月分 '+yen(F.transferConfirm.amount)+'の振込が完了したことを先生に報告しますか？</p>'+(F.error?'<p role="alert">'+esc(F.error)+'</p>':'')+'<button class="btn-primary" data-action="fa-transfer-send"'+(F.busy||previewK?' disabled':'')+'>報告する</button>'});}
            app.innerHTML = h; mountDayDialog(); return;
          }
          if (PREVIEW && F.step === 'login') { app.innerHTML = previewBanner(true) + '<div class="card">' + (F.busy ? '<p role="status">保護者ページを読み込んでいます…</p>' : '<p role="alert">' + esc(F.error || '保護者ページを読み込めませんでした。') + '</p><button class="btn-primary" data-action="fa-home">再試行</button>') + '</div>'; return; }
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
        function familyOpenStudent(id){if(!(F.home.children||[]).some(function(c){return sameId(c.studentId,id);}))return;if(PREVIEW){location.href='/yoyaku/?preview=student:'+encodeURIComponent(id)+'#home';return;}familyRequest('familyStudentLink',{ftoken:familyToken(),studentId:id},function(res){if(res.url)location.href=res.url;});}
        function familyClick(action, btn) {
          if (route() !== "family") return;
          if(["fa-notices","fa-notice-refresh","fa-notice-open"].indexOf(action)>=0){familyNoticeClick(action,btn);return;}
          if (F.busy) return;
          if(action==='fa-student-pages'){var kids=F.home&&F.home.children||[];if(kids.length===1)familyOpenStudent(kids[0].studentId);else{F.studentChooser=true;familyRender();}}
          else if(action==='fa-student-pick')familyOpenStudent(btn.getAttribute('data-child'));
          else if(action==='fa-student-close'){F.studentChooser=false;familyRender();}
          else if(action==='fa-profile-open'){
            var id=btn.getAttribute('data-child')||'',kind=btn.getAttribute('data-kind'),person=id?(F.home.children||[]).filter(function(c){return sameId(c.studentId,id);})[0]:F.home.family;if(!person)return;
            if(kind==='email'&&!id){F.step='emailChange';F.email='';}else F.profileEdit={studentId:id,kind:kind,name:person.name||'',familyName:person.familyName||'',givenName:person.givenName||'',email:''};F.error='';familyRender();
          }
          else if(action==='fa-profile-cancel'){F.profileEdit=null;F.error='';familyRender();}
          else if(action==='fa-profile-save'&&F.profileEdit&&!previewK){
            var pe=F.profileEdit;pe.familyName=pe.kind==='name'?document.getElementById('fa-profile-family').value:pe.familyName;pe.givenName=pe.kind==='name'?document.getElementById('fa-profile-given').value:pe.givenName;pe.email=pe.kind==='email'?document.getElementById('fa-profile-email').value:'';
            familyRequest('familyProfileSave',Object.assign({ftoken:familyToken()},pe),function(res){if(res.family)F.home.family=res.family;if(res.children)F.home.children=res.children;F.message=pe.kind==='email'?(res.mailStatus==='sent'?'確認メールを送りました。メールのリンクを開いて登録を完了してください。':'確認メールを送信できませんでした。時間をおいて再申請してください。'):'登録しました。';F.profileEdit=null;});
          }
          else if (action === "fa-home") familyLoadHome();
          else if (action === "fa-refresh") familyLoadChild(btn.getAttribute("data-child") || F.studentId);
          else if (action === "fa-logout") familyLogout();
          else if (action === "fa-mode") { F.step = btn.getAttribute("data-step"); F.error = ""; F.message = ""; F.confirm = null; if (F.step === 'emailChange') F.email = ''; familyRender(); }
          else if (action === "fa-verification-retry" && F.challenge) familyLoadVerification();
          else if (action === "fa-verify" && F.challenge && F.verificationInfo) familyRequest("familyVerify", { challenge: F.challenge }, function (res) { if (res.passwordRequired) { F.step="setPassword"; F.email=res.email; F.message="メールアドレスを確認しました。パスワードを設定すると登録完了です。"; } else { familyClear(); F.challenge = ""; F.challengeKind = ""; F.message = "メールアドレスを確認しました。ログインしてください。"; } });
          else if(action==='fa-transfer') {var invoice=(F.home.billing||[]).filter(function(m){return m.ym===btn.getAttribute('data-ym');})[0];if(invoice&&invoice.status==='waiting'){F.transferConfirm={ym:invoice.ym,amount:invoice.amount,signature:invoice.signature};familyRender();}}
          else if(action==='fa-transfer-cancel'){F.transferConfirm=null;familyRender();}
          else if(action==='fa-transfer-send'&&F.transferConfirm&&!previewK){familyRequest('familyReportTransfer',{ftoken:familyToken(),ym:F.transferConfirm.ym,signature:F.transferConfirm.signature},function(res){F.transferConfirm=null;F.home.billing=res.billing;F.message='振込の報告を受け付けました。';});}
          else if(action==='fa-grades-retry'){delete familyGrades[JSON.stringify([familyToken(),btn.getAttribute('data-child')])];familyRender();}
          else if (action === "fa-planopen" || action === "fa-planok" || action === "fa-planng" || action === "fa-planskip") {
            var childId=btn.getAttribute("data-child"), childData=F.childrenData[childId], lineId=btn.getAttribute("data-line"), m=(childData && childData.planLines || []).filter(function (x) { return x.id === lineId; })[0];
            if(action==='fa-planopen'&&m&&m.status==='approved'){F.confirm={studentId:childId,lineId:lineId,line:m,stage:'detail'};familyRender();return;}
            if (!m || m.status !== 'proposed' || !Number.isSafeInteger(m.revision)) { F.error = '最新の案内を確認してください。'; familyRender(); return; }
            F.confirm={studentId:childId,lineId:lineId,line:m,approve:action==='fa-planok',expectedRevision:m.revision,memo:'',stage:action==='fa-planopen'?'choose':action==='fa-planng'?'reduce':'review',approvedCount:action==='fa-planskip'?0:action==='fa-planok'?Number(m.count):Math.max(1,Number(m.count)-1)};familyRender();
          } else if(action==='fa-plan-review'&&F.confirm&&F.confirm.stage==='reduce'){
            var c=F.confirm,n=Number(val('fa-reduce-0'));c.memo=val('fa-plan-message');
            if(!Number.isInteger(n)||n<1||n>Number(c.line.count)){F.error='1回から案内の回数までで選んでください。';familyRender();return;}
            c.approvedCount=n;c.approve=n>0;c.stage='review';F.error='';familyRender();
          } else if (action === "fa-planack") {
            var akChild = btn.getAttribute("data-child"), akLine = btn.getAttribute("data-line"), akKind = btn.getAttribute("data-ack"), akM = ((F.childrenData[akChild] || {}).planLines || []).filter(function (x) { return x.id === akLine; })[0];
            if (!akM || !akM.teacherRecorded || !Number.isSafeInteger(akM.revision)) { F.error = '最新の内容を確認してください。'; familyRender(); return; }
            if (akKind === 'inquiry') { F.confirm = { studentId: akChild, lineId: akLine, line: akM, stage: 'ack', expectedRevision: akM.revision, memo: '' }; familyRender(); return; }
            familyRequest("familyPlanAck", { ftoken: familyToken(), studentId: akChild, lineId: akLine, ack: 'confirmed', expectedRevision: akM.revision, memo: '' }, function (res) { F.childrenData[akChild] = res.data; F.message = '確認を記録しました。ありがとうございます。'; loadFamilyNotices(); });
          } else if (action === "fa-ack-send" && F.confirm && F.confirm.stage === 'ack') {
            var ac = F.confirm, acMemo = String(val('fa-plan-message') || '').trim();
            if (!acMemo) { F.error = '問い合わせの内容を入力してください。'; ac.memo = ''; familyRender(); return; }
            familyRequest("familyPlanAck", { ftoken: familyToken(), studentId: ac.studentId, lineId: ac.lineId, ack: 'inquiry', expectedRevision: ac.expectedRevision, memo: acMemo }, function (res) { F.confirm = null; F.childrenData[ac.studentId] = res.data; F.message = '先生に問い合わせを送りました。折り返しの連絡をお待ちください。'; loadFamilyNotices(); });
          } else if (action === "fa-cancel") { F.confirm = null; familyRender(); }
          else if (action === "fa-decide" && F.confirm && (F.home.children||[]).some(function(c){return sameId(c.studentId,F.confirm.studentId);})) {
            var confirmation = F.confirm;
            familyRequest("familyPlanDecide", {ftoken:familyToken(),studentId:confirmation.studentId,lineId:confirmation.lineId,approve:confirmation.approve,expectedRevision:confirmation.expectedRevision,memo:confirmation.memo,approvedCount:confirmation.approvedCount}, function (res) { F.confirm = null; F.childrenData[confirmation.studentId] = res.data; delete F.memos[confirmation.studentId + ':' + confirmation.lineId]; F.message = res.notificationWarning || (confirmation.approve ? '承認しました。' : '先生に相談を伝えました。'); familyLoadChildState(confirmation.studentId); loadFamilyNotices(); });
          }
        }

        var familyPanels=Object.create(null);
        function renderFamilyPanels() {
          var active=Object.create(null), section=parentSection();
          (F.home.children||[]).forEach(function(c){active[JSON.stringify([familyToken(),c.studentId])]=true;});
          Object.keys(familyPanels).forEach(function(key){familyPanels[key].reads.clear();});
          if(!PREVIEW&&section==='records') (F.home.children||[]).forEach(function(c){
            var host=document.getElementById('family-records-'+c.studentId);if(!host)return;
            var rkey=JSON.stringify([familyToken(),c.studentId]);active[rkey]=true;
            var rpanel=familyPanels[rkey]||(familyPanels[rkey]={services:window.StepwiseServices.create(),reads:window.StepwiseLessonRead.create()});
            var rtoken=familyToken();rpanel.reads.mount(host,function(op,payload){return apiPost(Object.assign({},payload,{ftoken:rtoken,studentId:c.studentId,action:'learningService',op:op}));},rkey);
          });
          if(!PREVIEW&&section==='grades')(F.home.children||[]).forEach(function(gc){
            var gradesHost=document.getElementById('family-grades-'+gc.studentId);if(!gradesHost)return;
            var gkey=JSON.stringify([familyToken(),gc.studentId]);active[gkey]=true;
            var gpanel=familyPanels[gkey] || (familyPanels[gkey]={services:window.StepwiseServices.create(),reads:window.StepwiseLessonRead.create()});
            var gtoken=familyToken();gpanel.services.mount(gradesHost,{key:gkey,teacher:false,panel:'exams',call:function(op,payload){return apiPost(Object.assign({},payload,{ftoken:gtoken,studentId:gc.studentId,action:'learningService',op:op}));}});
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
        if(parentHeaderActions)parentHeaderActions.addEventListener('click',function(ev){var btn=ev.target.closest('[data-action]');if(!btn)return;if(btn.getAttribute('data-action')==='student-notices'){studentNoticesOpen=!studentNoticesOpen;render();}else if(btn.getAttribute('data-action')==='fa-student-pages')familyClick('fa-student-pages',btn);else if(btn.getAttribute('data-action')==='fa-notices')familyNoticeClick('fa-notices',btn);});
        function mountDayDialog(){var sp=document.getElementById("student-plan-dialog");if(sp){sp.oncancel=function(){studentPlanId="";};if(sp.showModal&&!sp.open)sp.showModal();}var chooser=document.getElementById("family-student-dialog");if(chooser){chooser.oncancel=function(e){if(F.busy)e.preventDefault();else F.studentChooser=false;};if(chooser.showModal&&!chooser.open)chooser.showModal();}var profile=document.getElementById("family-profile-dialog");if(profile){profile.oncancel=function(e){if(F.busy)e.preventDefault();else F.profileEdit=null;};if(profile.showModal&&!profile.open)profile.showModal();}var transfer=document.getElementById("family-transfer-dialog");if(transfer){transfer.oncancel=function(e){if(F.busy)e.preventDefault();else F.transferConfirm=null;};if(transfer.showModal&&!transfer.open)transfer.showModal();}var plan=document.getElementById("family-plan-dialog");if(plan){plan.oncancel=function(e){if(F.busy)e.preventDefault();else F.confirm=null;};if(plan.showModal&&!plan.open)plan.showModal();}var ev=document.getElementById("schedule-event-editor");if(ev){ev.oncancel=function(e){if(busy)e.preventDefault();else{selMode="";selDays={};}};if(ev.showModal&&!ev.open)ev.showModal();}var d=document.getElementById('schedule-day-editor');if(d){d.oncancel=function(e){if(busy||NL.busy)e.preventDefault();else {dayAddOpen=false;familyDayChooser='';}};if(d.showModal&&!d.open)d.showModal();}}
        function mountAcceptDialog(){var d=document.getElementById('schedule-accept-dialog');if(d){d.oncancel=function(e){if(busy)e.preventDefault();else pending=null;};if(d.showModal&&!d.open)d.showModal();}}

        function applyStudentPermissions() {
          if(route()==='family'||route()==='parent'||!S||!S.permissions)return;
          var p=S.permissions;
          app.innerHTML=app.innerHTML.replace(/<(button|input)\b[^>]*>/g,function(tag){var a=(tag.match(/data-action="([^"]+)"/)||[])[1],key='';
            if(/data-accept-id=/.test(tag)||['askaccept','doaccept','batchall','batchreview','batchsend'].indexOf(a)>=0)key='booking';
            if(['askdecline','askcancel','askwithdraw','dodecline','docancel','dowithdraw'].indexOf(a)>=0)key='reschedule';
            if(a==='dayavailability'||a==='delblock')key='availability';
            if(a==='delevent')key='events';
            if(a==='dayact'){var mode=(tag.match(/data-m="([^"]+)"/)||[])[1];key=mode==='want'?'request':mode==='event'?'events':'availability';}
            if(a==='delwish'){var id=(tag.match(/data-id="([^"]+)"/)||[])[1],w=(S.wishes||[]).filter(function(x){return String(x.id)===id;})[0];key=w&&w.kind==='want'?'request':'availability';}
            if(['se-resend','se-askremove','se-remove'].indexOf(a)>=0||/id="se-email"/.test(tag))key='email';
            return key&&p[key]===false&&!/\sdisabled(?:[\s=>])/.test(tag)?tag.slice(0,-1)+' disabled title="この操作は保護者のみ行えます">':tag;
          });
          if(Object.keys(p).some(function(k){return p[k]===false;}))app.innerHTML='<p class="note">一部の操作は保護者のみ行えます。変更が必要な場合は保護者にご相談ください。</p>'+app.innerHTML;
        }
        function render() {
          if(parentHeaderActions){var count=notices.items.filter(function(n){return n.required||!n.read;}).length;parentHeaderActions.innerHTML=route()==='family'&&F.home&&familyToken()?'<button class="btn-quiet btn-sm" data-action="fa-notices" aria-label="お知らせ '+count+'件" aria-expanded="'+notices.open+'"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'+(count?' <span class="tag red">'+count+'</span>':'')+(notices.error?' !':'')+'</button>':'';}
          if(parentHeaderActions&&route()!=='family'&&S&&S.me){var required=studentNoticeItems().filter(function(x){return x.required;}).length;parentHeaderActions.innerHTML='<button class="btn-quiet btn-sm" data-action="student-notices" aria-label="お知らせ 要確認'+required+'件" aria-expanded="'+studentNoticesOpen+'"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'+(required?' <span class="tag red">'+required+'</span>':'')+'</button>';}
          renderStudent(); applyStudentPermissions(); if(studentNoticesOpen&&route()!=='family'&&S&&S.me)app.innerHTML=studentNoticesHTML()+app.innerHTML;
          var entry=document.getElementById('parent-page-link');if(entry)entry.hidden=route()==='family';
          if(route()==='family'&&F.home&&F.step==='home'){
            if(parentHeaderActions)parentHeaderActions.innerHTML='<button class="student-page-link" data-action="fa-student-pages">生徒ページへ ↗</button>'+parentHeaderActions.innerHTML;
            if(F.studentChooser)app.innerHTML+=window.StepwiseCalendar.dayDialog({id:'family-student-dialog',title:'生徒ページを選択',close:'fa-student-close',busy:F.busy,content:(F.error?'<p role="alert">'+esc(F.error)+'</p>':'')+'<div class="row">'+(F.home.children||[]).map(function(c){return '<button class="btn-quiet" data-action="fa-student-pick" data-child="'+esc(c.studentId)+'"'+(F.busy?' disabled':'')+'>'+esc(c.name)+'</button>';}).join('')+'</div>'});
          }
          app.innerHTML+=bookingReviewHTML();var reviewDialog=document.getElementById('booking-review-dialog');if(reviewDialog){reviewDialog.oncancel=function(e){if(busy)e.preventDefault();else bookingReview=null;};if(reviewDialog.showModal&&!reviewDialog.open)reviewDialog.showModal();}
          mountHomeworkReview(); mountDayDialog(); mountAcceptDialog();
          meetWatch();
          if(window.StepwiseDocuments)window.StepwiseDocuments.mount(app,{teacher:false,auth:PREVIEW?{token:lsGet('sw_admt')||''}:route()==='family'?{ftoken:familyToken()}:{k:myKey()}});
          if(!window.StepwiseServices)return;
          if(route()==='family' && F.home && F.step==='home') { renderFamilyPanels(); return; }
          Object.keys(familyPanels).forEach(function(key){familyPanels[key].services.clear();familyPanels[key].reads.clear();});
          var page=route(),auth=null;
          if(!previewK){
            if(page==='parent'&&parentStep==='data'&&P)auth={k:myKey(),ptoken:ssGet(parentSessionKey(myKey()))};
          }
          if(window.StepwiseLessonRead){
            if(auth&&(auth.ftoken||auth.ptoken))window.StepwiseLessonRead.mount(app,function(op,payload){return apiPost(Object.assign({},payload,auth,{action:'learningService',op:op}));},JSON.stringify(auth));
            else window.StepwiseLessonRead.clear();
          }
          if(!auth){window.StepwiseServices.clear();return;}
          var parentPanel=auth.ftoken||auth.ptoken;if(parentPanel&&['grades','schedule'].indexOf(parentSection())<0){return;}
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
          if (!familyHomeTarget(btn)) return;
          var act = btn.getAttribute("data-action"), id = btn.getAttribute("data-id");
          if(act==='cancel-review'){if(busy)return;var cs=(S.cancellations||[]).filter(function(x){return String(x.id)===id;})[0];if(cs){bookingReview={slot:cs,scope:taskScopeKey()};render();}return;}
          if(act==='cancel-confirm'||act==='cancel-relief-send'){if(!bookingReview||busy||previewK||bookingReview.scope!==taskScopeKey()||bookingReview.slot.st!=='cancelled')return;var review=bookingReview,body={action:'cancelAcknowledge',k:myKey(),cancellationId:review.slot.id};if(act==='cancel-relief-send'){review.reason=val('cancel-circumstances');if(!review.reason){toast('申請理由を入力してください');return;}review.requestId=review.requestId||'relief-'+Date.now()+'-'+Math.random().toString(36).slice(2);body.action='cancelReliefRequest';body.reason=review.reason;body.requestId=review.requestId;}studentAction(body,act==='cancel-confirm'?'確認済みにしました':'減額・免除を申請しました',function(){bookingReview=null;render();});return;}
          if(act==='booking-review'){if(busy)return;var slot=(S.slots||[]).concat(S.history||[]).filter(function(x){return String(x.id)===id;})[0];if(slot&&slot.teacherBooking){bookingReview={slot:slot,scope:taskScopeKey(),note:''};render();}return;}
          if(act==='booking-close'){if(!busy){bookingReview=null;render();}return;}
          if(act==='booking-confirm'||act==='booking-correct'){
            var review=bookingReview;if(!review||busy||previewK||review.scope!==taskScopeKey())return;
            var note=act==='booking-correct'?String((document.getElementById('booking-review-note')||{}).value||'').trim():'';review.note=note;
            if(act==='booking-correct'&&!note){toast('修正してほしい内容を入力してください');return;}
            var receipt=review.slot.teacherBooking;
            studentAction({action:'teacherBookingRespond',k:myKey(),slotId:review.slot.id,requestId:receipt.requestId,expectedSnapshot:receipt.snapshot,expectedRevision:receipt.revision,response:act==='booking-confirm'?'confirmed':'correction',note:note},act==='booking-confirm'?'確認済みにしました':'先生に修正をお願いしました',function(){bookingReview=null;render();});return;
          }
          if(act==='family-calfilter'){
            if(busy||NL.busy)return;
            var childId=btn.getAttribute('data-child');
            if(!(F.home.children||[]).some(function(c){return c.studentId===childId;}))return;
            familyCalendar.hidden[childId]=!familyCalendar.hidden[childId];familyRender();return;
          }
          if(act==='family-dayadd'||act==='family-dayai'){
            if(busy||NL.busy)return;
            familyDayChooser=act==='family-dayadd'?'dayadd':'dayai';
            familyRender();return;
          }
          if(act==='family-dayclose'){familyDayChooser='';familyRender();return;}
          if(act==='dayadd'||act==='dayai')familyDayChooser='';
          if(act==='family-calprev'||act==='family-calnext'||act==='family-calday'){
            if(busy||NL.busy)return;
            if(act==='family-calday'){familyCalendar.date=btn.getAttribute('data-date');}
            else {familyCalendar.month+=act==='family-calnext'?1:-1;if(familyCalendar.month<0){familyCalendar.month=11;familyCalendar.year--;}if(familyCalendar.month>11){familyCalendar.month=0;familyCalendar.year++;}}
            familyRender();return;
          }
          if(act==='student-notices'){studentNoticesOpen=!studentNoticesOpen;render();return;}
          if(act==='student-notice-link'){studentNoticesOpen=false;render();return;}
          if(act==='student-planopen'){studentPlanId=btn.getAttribute('data-line');render();return;}
          if(act==='student-planclose'){studentPlanId='';render();return;}
          if(act==='approval-help'){var help=document.getElementById(btn.getAttribute('aria-controls'));if(help){help.hidden=!help.hidden;btn.setAttribute('aria-expanded',String(!help.hidden));}return;}
          if (act.indexOf("fa-") === 0) { ev.preventDefault(); familyClick(act, btn); return; }
          if (act === 'nl-item' || act === 'nl-event-block') return;
          if (act.indexOf('nl-') === 0) { ev.preventDefault(); if (act === 'nl-parse') nlParse(); else if (act === 'nl-clear') { NL.text = ''; NL.proposal = null; NL.error = ''; render(); } else if (act === 'nl-register') nlRegister(); return; }
          if (act.indexOf('se-') === 0) { ev.preventDefault(); if (act === 'se-askremove') { SE.removeConfirm = true; render(); } else if (act === 'se-cancel') { SE.removeConfirm = false; render(); } else if (act === 'se-back') { ++SE.seq; SE.challenge = ''; SE.error = ''; SE.message = ''; render(); if (myKey() && !S) loadState().catch(function () { toast('元の生徒専用ページを開き直してください'); }); } else studentEmailSend({'se-verify':'studentEmailVerify','se-resend':'studentEmailResend','se-remove':'studentEmailRemove'}[act]); return; }
          switch (act) {
            case "batchall": if (!acceptBatch().pending) { acceptBatch().selected = Object.create(null); acceptBatch().review = null; schedData().offers.slice(0, 31).forEach(function (s) { acceptBatch().selected[s.id] = true; }); render(); } break;
            case "batchclear": if (!acceptBatch().pending) { acceptBatch().selected = Object.create(null); render(); } break;
            case "pushtoggle": pushToggle(); break;
            case "guardopen": guardOpen(); break;
            case "batchreview": batchReview(); break;
            case "batchcancel": if (!acceptBatch().pending) { acceptBatch().review = null; render(); } break;
            case "batchsend": batchSend(); break;
            case "batchrefresh": batchRefresh(myKey(), acceptBatch()); break;
            case "closebar": pending = null; render(); break;
            case "calprev": calM--; if (calM < 0) { calM = 11; calY--; } pending = null; render(); break;
            case "calnext": calM++; if (calM > 11) { calM = 0; calY++; } pending = null; render(); break;
            case "histopen": histFolder = btn.getAttribute("data-folder"); if(route()==='family')familyHistoryFolders[btn.getAttribute('data-home-child')||F.studentId]=histFolder; render(); window.scrollTo(0, 0); break;
            case "helptoff": helpToff = !helpToff; render(); break;
            case "helpwish": helpWish = !helpWish; render(); break;
            case "helpnl": helpNl = !helpNl; render(); break;
            case "histback": histFolder = null; if(route()==='family')delete familyHistoryFolders[btn.getAttribute('data-home-child')||F.studentId]; render(); break;
            case "dayavailability": if(busy||NL.busy)break;selMode="wish";selDays={};selDays[selDate]=true;pending=null;dayAddOpen=false;render();break;
            case "dayadd": if(busy||NL.busy)break;dayInputMode='manual';dayAddOpen=true;render();break;
            case "dayai": if(busy||NL.busy||(!S.nlEnabled&&!previewK))break;dayInputMode='text';dayAddOpen=true;render();break;
            case "dayclose": if(busy||NL.busy)break;dayAddOpen=false;render();break;
            case "calday":
              dayAddOpen=false;
              if (selMode) { var nd = btn.getAttribute("data-date"); selDays[nd] = !selDays[nd]; render(); break; }
              selDate = btn.getAttribute("data-date"); selManual = true; pending = null; render(); break;
            case "dayact":
              var switching=(selMode==='wish'||selMode==='ng')&&(btn.getAttribute('data-m')==='wish'||btn.getAttribute('data-m')==='ng');
              var keepDate=switching?val(selMode==='ng'?'b-ngdate':'b-wishdate'):'',keepNote=switching?val(selMode==='ng'?'b-ngnote':'b-wnote'):'';
              var keepStart=switching?val(selMode==="ng"?"b-ngstart":"b-wstart"):"",keepEnd=switching?val(selMode==="ng"?"b-ngend":"b-wend"):"";
              selMode = btn.getAttribute("data-m"); panel = selMode; selDays = {}; selDays[keepDate||btn.getAttribute("data-date")] = true; pending = null; dayAddOpen=false; render();
              if(switching){var noteInput=document.getElementById(selMode==="ng"?"b-ngnote":"b-wnote");if(noteInput)noteInput.value=keepNote;if(keepStart&&keepEnd){var st=document.getElementById(selMode==="ng"?"b-ngstart":"b-wstart"),en=document.getElementById(selMode==="ng"?"b-ngend":"b-wend");if(st&&en){st.value=keepStart;en.value=keepEnd;st.disabled=false;en.disabled=false;}var all=document.getElementById("b-ngall");if(all)all.checked=false;}}
              break;
            case "selstart":
              selMode = btn.getAttribute("data-m"); selDays = {}; pending = null; render();
              var calEl1 = document.querySelector(".cal"); if (calEl1) calEl1.scrollIntoView({ behavior: "smooth", block: "start" });
              break;
            case "selcancel": if(busy)break; selMode = ""; selDays = {}; render(); break;
            case "selapply":
              if(previewK)return;
              var chosen = Object.keys(selDays).filter(function (d) { return selDays[d]; }).sort();
              if(selMode === "want" || selMode === "ng" || selMode === "wish" || selMode === "event"){var wd=val(selMode === "wish" ? "b-wishdate" : selMode === "event" ? "b-edate" : selMode === "ng" ? "b-ngdate" : "b-wdate");if(!/^\d{4}-\d{2}-\d{2}$/.test(wd)||wd<S.today){toast("今日以降の日付を選んでください");return;}chosen=[wd];}
              if (!chosen.length) { toast("日付をえらんでください"); return; }
              if (selMode === "ng") {
                var addD2 = chosen, remIds2 = [];
                var ngNote2 = val("b-ngnote"), ngSt = val("b-ngstart"), ngEn = val("b-ngend");
                if((document.getElementById("b-ngall")||{}).checked){ngSt="";ngEn="";}else if(!ngSt||!ngEn){toast("開始と終了の時刻を入れてください");return;}
                if ((ngSt && !ngEn) || (!ngSt && ngEn)) { toast("時間帯は開始と終了の両方を入れてください(終日なら両方空欄)"); return; }
                if (ngSt && ngSt >= ngEn) { toast("時間帯は「開始 < 終了」で入れてください"); return; }
                selMode = ""; selDays = {};
                studentAction({ action: "blockSet", k: myKey(), add: addD2, removeIds: remIds2, note: ngNote2, start: ngSt, end: ngEn }, "登録しました");
              } else if (selMode === "wish" || selMode === "want") {
                var bws = val("b-wstart"), bwn = val("b-wnote");
                if(selMode === "want" && val("b-wlesson")){bwn=val("b-wlesson")+(bwn?"："+bwn:"");if(bwn.length>100){toast("メモをもう少し短くしてください");return;}}
                if (!bws) { toast("開始時刻を入れてください"); return; }
                var body = { action: "wishMany", k: myKey(), kind: selMode === "want" ? "want" : wishKind, dates: chosen, start: bws, note: bwn };
                if (selMode === "want") { body.min=Number(val("b-wmin")); if([30,45,60,90,120].indexOf(body.min)<0){toast("授業時間を選んでください");return;} } else { var bwe = val("b-wend"); if (!bwe || bws >= bwe) { toast("時間帯は「開始 < 終了」で入れてください"); return; } body.end = bwe; }
                body.deliveryMode=val('b-wmode');studentAction(body, selMode === 'want' ? '希望日時を送りました' : '授業可能日時を登録しました', function(){selMode='';selDays={};});
              } else if (selMode === "event") {
                var bet = val("b-etitle"), beb = false;
                if (!bet) { toast("予定の内容を入れてください"); return; }
                var ranges = groupDays(chosen);
                selMode = ""; selDays = {};
                var bkind = "event";
                studentAction({ action: "eventAddMany", k: myKey(), ranges: ranges, title: bet, alsoBlock: beb, kind: bkind }, "イベントを登録しました");
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
              var tt = val("f-ttitle"), ty = val("f-ttype"), dm = val("f-tdue-mode"), td = dm === 'date' ? val("f-tdue") : '', ds = dm === 'nextLesson' ? val("f-tdue-subject") : '', taskKey = taskScopeKey();
              if (!tt) { toast("内容を入れてください"); return; }
              if (['date','nextLesson','none'].indexOf(dm) < 0) { toast('期限の種類を選んでください'); return; }
              if (dm === 'date' && !td) { toast('期限の日付を入れてください'); return; }
              if (dm === 'nextLesson' && !ds) { toast('期限にする授業の科目を入れてください'); return; }
              studentAction({ action: "taskAdd", k: myKey(), type: ty, title: tt, due: td, dueMode: dm, dueSubject: ds }, "追加しました", function () { delete taskDrafts[taskKey]; }); break;
            case "tasktoggle": if(route()==='home'&&btn.getAttribute('data-done')==='true'){if(!busy){homeworkReview={id:String(id),scope:taskScopeKey()};render();}}else taskToggle(id, btn.getAttribute('data-done') === 'true'); break;
            case "homework-close": if(!busy){homeworkReview=null;render();} break;
            case "homework-confirm": if(homeworkReview && homeworkReview.scope===taskScopeKey())taskToggle(homeworkReview.id,true); break;
            case "taskretry": { var tn = taskNotices[taskScopeKey()]; if (tn && tn.retry && !previewK) studentAction(Object.assign({},tn.retry), tn.retry.done ? '先生の確認待ちになりました' : '未完了に戻しました'); break; }
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
              var pym = btn.getAttribute("data-line"), approve = act === "planok", pmemo = val("pl-memo-" + pym);
              var proposedMonth = (P && P.planLines || []).filter(function (m) { return m.id === pym; })[0];
              if (!proposedMonth || proposedMonth.revision == null || proposedMonth.status !== 'proposed') { toast("最新の案内を確認してください"); return; }
              parentPlanMemos[myKey() + ":" + pym] = pmemo;
              if (!confirm(approve ? planPeriod(proposedMonth) + " " + planName(proposedMonth) + " " + proposedMonth.count + "回の案内を承認しますか？" : "この案内を見送り(相談)として先生に伝えますか?")) return;
              var approvalKey = myKey();
              busy = true; render();
              apiPost({ action: "parentPlanDecide", k: approvalKey, ptoken: ssGet(parentSessionKey(approvalKey)) || "", lineId: pym, expectedRevision: proposedMonth.revision, approve: approve, memo: pmemo }).then(function (res) {
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
          if (!familyHomeTarget(el)) return;
          if(el && el.id === "b-ngall"){["b-ngstart","b-ngend"].forEach(function(id){var input=document.getElementById(id);if(input)input.disabled=el.checked;});return;}
          if (el && el.id === "fa-child") { if(F.busy)return; F.studentId=el.value; F.confirm=null; familyRender(); return; }
          if (el && el.id === "fa-mychild") { if(F.busy)return; familySelectChild(el.value); familyRender(); return; }
          if(el&&el.getAttribute("data-action")==="fa-permission") { if(F.busy||previewK||!F.home){render();return;} var child=(F.home.children||[]).filter(function(c){return c.studentId===el.getAttribute('data-child');})[0];if(!child)return;familyRequest('familyPermissionsSave',{ftoken:familyToken(),studentId:child.studentId,permission:el.getAttribute('data-permission'),allowed:el.value==='true',expectedRevision:child.permissionsRevision||0},function(res){child.permissions=res.permissions;child.permissionsRevision=res.permissionsRevision;if(F.childState&&F.childState[child.studentId])F.childState[child.studentId].permissions=res.permissions;F.message='権限を保存しました。';});return; }
          if (el && el.getAttribute("data-action") === "fa-mailpref") { if(F.busy||!F.home)return; var mp = Object.assign({}, F.home.emailPrefs || {}); mp[el.getAttribute("data-kind")] = !!el.checked; familyRequest('familyEmailPrefs', { ftoken: familyToken(), prefs: mp }, function (res) { F.home.emailPrefs = res.emailPrefs || mp; F.message = 'メール通知の設定を保存しました。'; }); return; }
          if (taskDraftInput(el)) { if (el.id === 'f-tdue-mode') render(); return; }
          if (el && el.getAttribute("data-accept-id")) { var b = acceptBatch(); if (!b.pending && !b.busy && !b.refreshRequired) { b.selected[el.getAttribute("data-accept-id")] = el.checked; b.review = null; render(); } return; }
          if (el && el.getAttribute("data-action") === "nl-event-block") { var item=NL.proposal && NL.proposal.items[+el.getAttribute('data-i')]; if(item&&!item.done&&!busy&&!NL.busy)item.alsoBlock=!!el.checked; return; }
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
          else if (qp && !PREVIEW) { history.replaceState(null, "", location.pathname + location.hash); }
          else if (qs.toString() && !PREVIEW) history.replaceState(null, "", location.pathname + location.hash);
        } catch (e) {}
        if (PREVIEW && PREVIEW.view === 'parent' && route() !== 'family') location.hash = '#family/home';
        window.addEventListener("hashchange", function () { pending = null; F.studentChooser=false; F.profileEdit=null; F.transferConfirm=null; selMode = ""; selDays = {}; histFolder = null; familyReadChallenge(); studentEmailReadChallenge(); if (route() === 'family') { render(); if (!F.challenge && !F.home && F.step==='login' && familyToken()) familyLoadHome(); } else if (route() === 'student-email' && SE.challenge) render(); else if (!S) loadState().catch(function () { toast('読み込めませんでした'); }); else render(); window.scrollTo(0, 0); });
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
        pushBoot();
        if (route() === 'family') { render(); if (!F.challenge && F.step==='login' && familyToken()) familyLoadHome(); }
        else if (route() === 'student-email' && SE.challenge) render();
        // 鍵が無いときは問い合わせない。ホーム画面のアプリから開くと ?k= が付かないので、
        // ここで通信を試すと「読み込みに失敗しました」という見当違いの案内になる
        else if (!myKey()) render();
        else loadState().catch(function () { app.innerHTML = '<div class="loading">読み込みに失敗しました。<br>電波の良いところで再読み込みしてください。</div>'; });
      })();
