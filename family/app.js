// 保護者の画面（作り直し v2）。入口は ホーム・予定・学習・お支払い（docs/UX_STRUCTURE.md 4）。子どもが2人以上なら上で切り替える。
// ログイン・招待・再設定、予定と「変更・お休みの連絡」、テスト・行事を知らせる、記録と宿題・成績、計画の承認とお支払い（family/money.js）、アカウント（右上）。
// 切り替えまでは準備中（今までの保護者ページ /hogosha/ を使う）。
import { call, session, esc } from '/assets/v2/api.js';
import { familyLessonList, changeDialog, eventList, eventForm } from '/assets/v2/schedule-view.js?v=20261003-ux23';
import { learningView } from '/assets/v2/learning-view.js?v=20261003-ux23';
import { moneyView } from '/family/money.js?v=20261003-ux23';
import { gradesView, uploadFile, openFile } from '/assets/v2/grades-view.js?v=20261003-ux23';

// スタッフのプレビュー（#preview=pv2.…）: 本物のログイン（sw2_family）には触れず、このタブだけで使う。書き込みはサーバーが断る
const PV_KEY = 'sw2_family_preview';
if (location.hash.startsWith('#preview=')) { try { sessionStorage.setItem(PV_KEY, decodeURIComponent(location.hash.slice(9))); } catch {} history.replaceState(null, '', location.pathname + '#home'); }
const previewToken = (() => { try { return sessionStorage.getItem(PV_KEY) || ''; } catch { return ''; } })();
const store = previewToken ? { get: () => previewToken, set: () => {} } : session('sw2_family');
const previewBar = () => previewToken && me ? `<p class="notice" style="background:#fff3c4;color:#5a4300"><strong>プレビュー中</strong>：${esc(me.name)}の保護者ページ（表示だけです。押しても変更はされません。1時間で切れます）</p>` : '';
const app = document.getElementById('app'), nav = document.getElementById('nav');
let me = null, busy = false, notice = null, sched = null, change = null, inviteInfo = null, learning = null, money = null, grades = null;

function route() {
  const h = location.hash;
  if (h.startsWith('#invite=')) return { page: 'invite', token: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#reset=')) return { page: 'reset', token: decodeURIComponent(h.slice(7)) };
  return { page: h.slice(1) || 'home' };
}
const say = (m, k = '') => { notice = m ? { m, k } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.k}" role="${notice.k === 'error' ? 'alert' : 'status'}">${esc(notice.m)}</p>` : '';
const dis = () => busy ? ' disabled' : '';
async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }
const prep = '<p class="notice small">準備中の新しい保護者ページです。今は今までの <a href="/hogosha/">保護者ページ</a> をお使いください。</p>';

function newPasswordForm(kind, label) {
  return `<form class="stack" data-form="${kind}"><label>新しいパスワード（12文字以上）<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="primary"${dis()}>${label}</button></form>`;
}
function loginPage() {
  return `${prep}<h1>保護者ページ</h1>${noticeHtml()}<form class="stack" data-form="login"><label>メールアドレス<input type="email" name="email" autocomplete="username" required></label>
    <label>パスワード<input type="password" name="password" autocomplete="current-password" required></label><button class="primary"${dis()}>${busy ? 'ログインしています…' : 'ログイン'}</button></form><p><a href="#forgot">パスワードを忘れたとき</a></p>`;
}
function invitePage(token) {
  if (!inviteInfo || inviteInfo.token !== token) { inviteInfo = { token, loading: true }; call('family/invite/info', { token }).then(r => { inviteInfo = { token, ...(r.ok ? r : { error: r.error.message }) }; render(); }); }
  if (inviteInfo.loading) return '<p class="muted">確かめています…</p>';
  if (inviteInfo.error) return `<h1>保護者ページの登録</h1><p class="notice error">${esc(inviteInfo.error)}</p>`;
  return `<h1>保護者ページの登録</h1><p>${esc(inviteInfo.name)}（${esc(inviteInfo.email)}）のパスワードを決めてください。</p>${noticeHtml()}<input type="email" value="${esc(inviteInfo.email)}" autocomplete="username" hidden>${newPasswordForm('invite', '登録してはじめる')}`;
}
// ---- 入口（docs/UX_STRUCTURE.md 4）: ホーム・予定・学習・お支払い。スマホでは画面の下。アカウントは右上 ----
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  learning: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>',
  money: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
};
const TABS = [['home', 'ホーム'], ['schedule', '予定'], ['learning', '学習'], ['money', 'お支払い']];
// 前の URL（#events・#grades）も開けるように
const pageOf = p => p === 'events' ? 'schedule' : p === 'grades' ? 'learning' : p;

// 子どもの切り替え（2人以上のとき）。予定は「全員」も選べる。選んだ子どもはこのタブで覚える
const KID_KEY = 'sw2_family_kid';
let kid = (() => { try { return sessionStorage.getItem(KID_KEY) || ''; } catch { return ''; } })();
const kids = () => (sched && sched.students) || [];
function kidPicker(allowAll) {
  const ks = kids(); if (ks.length < 2) return '';
  if (!allowAll && !ks.some(s => s.id === kid)) kid = ks[0].id;
  const opts = (allowAll ? [['', '全員']] : []).concat(ks.map(s => [s.id, s.name.split(' ').pop()]));
  return '<div class="tabs2" role="tablist" aria-label="子ども">' + opts.map(([id, label]) => `<a href="javascript:void 0" role="tab" data-action="kid" data-id="${esc(id)}" class="${kid === id ? 'on' : ''}">${esc(label)}</a>`).join('') + '</div>';
}
const forKid = (rows, key = 'studentId') => !kid ? rows : rows.filter(x => x[key] === kid);
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));

// 読み込み（ホームは3つをいっしょに）
function need(...what) {
  const want = what.filter(w => !{ sched, learning, money, grades }[w]);
  for (const w of want) {
    if (w === 'sched') { sched = { loading: true }; call('family/schedule', {}, store.get()).then(r => { if (r.ok) sched = r; else if (r.error.code === 'needLogin') { store.set(''); me = null; } else { sched = { students: [], lessons: [], events: [], today: '' }; say(r.error.message, 'error'); } render(); }); }
    if (w === 'learning') { learning = { loading: true }; call('family/learning', {}, store.get()).then(r => { learning = r.ok ? r : { records: [], homework: [], students: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); }
    if (w === 'money') { money = { loading: true }; call('family/money', {}, store.get()).then(r => { money = r.ok ? r : { plans: [], fees: [], invoices: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); }
    if (w === 'grades') { grades = { loading: true }; call('family/grades', {}, store.get()).then(r => { grades = r.ok ? r : { students: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); }
  }
  return what.some(w => { const v = { sched, learning, money, grades }[w]; return !v || v.loading; });
}
const loading = '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';

// ホーム: やること・次の授業・新しい記録
function homePage() {
  if (need('sched', 'learning', 'money')) return loading;
  const multi = kids().length > 1, first = id => { const s = kids().find(k => k.id === id); return multi && s ? s.name.split(' ').pop() + ' ' : ''; };
  let h = `${prep}<div class="page-head"><h1>ホーム</h1></div>${noticeHtml()}`;
  const todo = [];
  const asks = money.plans.filter(l => l.status === 'proposed'), acks = money.plans.filter(l => l.status === 'approved' && l.approvedBy === 'staff' && !l.familyAck);
  if (asks.length) todo.push(['#money', '授業計画の承認', `${asks.length}件・内容を確かめて承認してください`]);
  if (acks.length) todo.push(['#money', '承諾の内容の確認', `${acks.length}件・先生が記録した承諾を確かめてください`]);
  const kari = sched.lessons.filter(l => l.status === 'proposed' && l.confirmBy);
  if (kari.length) { const by = kari.map(l => l.confirmBy).sort()[0]; todo.push(['#schedule', '仮予定の確認', `${kari.length}件・${md(by)}までに連絡がなければ決定します`]); }
  const due = money.invoices.filter(v => v.status === 'confirmed');
  if (due.length) todo.push(['#money', 'お支払い', due.map(v => `${Number(v.month.slice(5))}月分 ${Number(v.total).toLocaleString('ja-JP')}円`).join('・')]);
  const hw = learning.homework.filter(w => w.status === 'open');
  if (hw.length) todo.push(['#learning', '宿題', `${hw.length}件・できたら「できた」を押してください`]);
  h += '<h2>やること</h2>' + (todo.length ? '<div class="rows">' + todo.map(([href, t, n]) => `<a class="todo" href="${href}"><span class="b"><strong>${esc(t)}</strong><small class="muted">${esc(n)}</small></span><span class="go">›</span></a>`).join('') + '</div>' : '<p class="muted small">いま、やることはありません。</p>');
  const next = sched.lessons.filter(l => l.date >= sched.today && ['proposed', 'decided'].includes(l.status)).slice(0, 3);
  h += '<h2>次の授業</h2>' + (next.length ? '<div class="rows">' + next.map(l => `<a class="todo" href="#schedule"><span class="b"><strong>${md(l.date)} ${l.start}〜</strong><small class="muted">${esc(first(l.studentId))}${esc(l.subject)}${l.status === 'proposed' ? '・仮予定' : ''}${l.deliveryMode === 'online' ? '・オンライン' : ''}</small></span><span class="go">›</span></a>`).join('') + '</div>' : '<p class="muted small">決まっている授業はありません。</p>');
  const tests = sched.events.filter(e => e.kind === 'test' && e.date >= sched.today).slice(0, 2);
  if (tests.length) h += '<h2>テスト</h2><div class="rows">' + tests.map(e => `<div class="ev"><span class="t">${md(e.date)}</span><span class="b" style="color:var(--ink)">${esc(first(e.studentId))}${esc(e.title)}</span><span></span></div>`).join('') + '</div>';
  const recs = learning.records.slice(0, 3);
  if (recs.length) h += '<h2>新しい授業の記録</h2><div class="rows">' + recs.map(r => `<a class="todo" href="#learning"><span class="b"><strong>${md(r.date)} ${esc(first(r.studentId))}${esc(r.subject)}</strong><small class="muted">${esc(r.range || r.comment.slice(0, 40))}</small></span><span class="go">›</span></a>`).join('') + '</div>';
  return h;
}
// 予定: 子どもを選んで一覧と「変更・お休みの連絡」。テスト・行事を知らせるもここ
function schedulePage() {
  if (need('sched')) return loading;
  const names = Object.fromEntries(kids().map(s => [s.id, kids().length > 1 && !kid ? s.name : '']));
  let h = `<div class="page-head"><h1>予定</h1></div>${kidPicker(true)}${noticeHtml()}`;
  if (change) h += changeDialog(sched.lessons.find(l => l.id === change.id), change.pick, change.note, busy);
  h += familyLessonList({ ...sched, lessons: forKid(sched.lessons) }, { names });
  const allNames = Object.fromEntries(kids().map(s => [s.id, s.name]));
  h += `<h2>テスト・行事を知らせる</h2><p class="small muted">テスト・行事・授業ができない日を先生に知らせると、予定を作るときの参考にします。</p>${eventList(forKid(sched.events), { names: allNames, canDelete: e => e.createdByKind === 'family' })}
    <details><summary class="small">知らせる</summary>${eventForm(kid ? kids().filter(s => s.id === kid) : kids())}</details>`;
  return h;
}
// 学習: 子どもを選んで「記録と宿題」「成績」
function learningPage(sub) {
  if (need('sched')) return loading;
  const tab = sub === 'grades' ? 'grades' : 'records';
  let h = `<div class="page-head"><h1>学習</h1></div>${kidPicker(false)}<div class="seg" style="margin-top:6px"><a href="#learning" class="${tab === 'records' ? 'on' : ''}">記録と宿題</a><a href="#learning/grades" class="${tab === 'grades' ? 'on' : ''}">成績</a></div>${noticeHtml()}`;
  if (tab === 'records') {
    if (need('learning')) return h + loading;
    return h + learningView({ ...learning, records: forKid(learning.records), homework: forKid(learning.homework) }, { names: {} });
  }
  if (need('grades')) return h + loading;
  const st = grades.students.find(s => s.id === kid) || grades.students[0];
  return h + (st ? gradesView(st, { who: 'family', dis: dis() }) : '<p class="muted">まだ成績はありません。</p>');
}
function moneyPage() {
  if (need('money')) return loading;
  const multi = new Set(money.plans.map(l => l.studentId).concat(money.fees.map(f => f.studentId))).size > 1;
  return `<div class="page-head"><h1>お支払い</h1></div>${noticeHtml()}${moneyView(money, { multi, dis: dis() })}`;
}
function accountPage() {
  if (previewToken) return `<h1>アカウント</h1><p class="muted">プレビューでは使えません。</p>`;
  return `<h1>アカウント</h1><p>${esc(me.name)}（${esc(me.email)}）</p>${noticeHtml()}<h2>パスワードを変える</h2><form class="stack" data-form="password"><input type="email" value="${esc(me.email)}" autocomplete="username" hidden>
    <label>今のパスワード<input type="password" name="current" autocomplete="current-password" required></label><label>新しいパスワード（12文字以上）<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label><button class="primary"${dis()}>変える</button></form><h2>ログアウト</h2><p><button data-action="logout"${dis()}>この端末からログアウト</button></p>`;
}

function render() {
  const r = route(), page = pageOf(r.page.split('/')[0]), sub = r.page.split('/')[1];
  nav.innerHTML = me ? TABS.map(([k, l]) => `<a href="#${k}" class="${page === k ? 'on' : ''}"${page === k ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg><span>${l}</span></a>`).join('') : '';
  document.body.classList.toggle('has-tabs', !!me);
  const acct = document.getElementById('acct'); if (acct) acct.hidden = !me;
  let h;
  if (r.page === 'invite') h = invitePage(r.token);
  else if (r.page === 'reset') h = `<h1>新しいパスワード</h1>${noticeHtml()}${newPasswordForm('reset', 'パスワードを変える')}`;
  else if (!me) h = r.page === 'forgot' ? `<h1>パスワードの再設定</h1>${noticeHtml()}<form class="stack" data-form="forgot"><label>メールアドレス<input type="email" name="email" required></label><button class="primary"${dis()}>再設定のメールを送る</button></form><p><a href="#">ログインに戻る</a></p>` : loginPage();
  else h = page === 'schedule' ? schedulePage() : page === 'learning' ? learningPage(sub || (r.page === 'grades' ? 'grades' : '')) : page === 'money' ? moneyPage() : page === 'account' ? accountPage() : homePage();
  app.className = !me ? 'narrow' : '';
  app.innerHTML = previewBar() + h;
}
function signedIn(r) { store.set(r.auth); me = r.me; sched = null; learning = null; money = null; grades = null; say(''); location.hash = '#home'; }

app.addEventListener('submit', ev => {
  ev.preventDefault();
  const el = ev.target, kind = el.dataset.form, v = Object.fromEntries(new FormData(el).entries());
  if ((kind === 'invite' || kind === 'reset') && v.password !== v.confirm) { say('2つのパスワードが一致しません', 'error'); return render(); }
  if (kind === 'password' && v.next !== v.confirm) { say('2つのパスワードが一致しません', 'error'); return render(); }
  run(async () => {
    let r;
    if (kind === 'login') { r = await call('family/login', v); if (r.ok) return signedIn(r); }
    else if (kind === 'forgot') { r = await call('family/reset/request', v); if (r.ok) return say(r.message, 'ok'); }
    else if (kind === 'invite') { r = await call('family/invite/accept', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'reset') { r = await call('family/reset/confirm', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'password') { r = await call('family/password', { current: v.current, next: v.next }, store.get()); if (r.ok) { el.reset(); return say('パスワードを変えました', 'ok'); } }
    else if (kind === 'gr-upload') {
      const file = el.querySelector('input[type=file]').files[0]; if (!file) return;
      r = await uploadFile(file, v.note || '', meta => call('family/grades/upload', { ...meta, studentId: v.studentId }, store.get()));
      if (r.ok) { grades = null; return say('成績票を送りました。先生が確かめて点数を入れます', 'ok'); }
      if (r.error && !r.error.code) r.error.code = 'client';
    } else if (kind === 'plan-decide') {
      const n = Number(v.count);
      if (n === 0 && !confirm('この計画を見送りますか？')) return;
      r = await call('family/plans/decide', { id: el.dataset.id, version: Number(el.dataset.version), approvedCount: n }, store.get()); if (r.ok) { money = null; return say(n ? '承認しました。ありがとうございます' : '見送りにしました', 'ok'); }
    } else if (kind === 'plan-inquiry') { r = await call('family/plans/ack', { id: el.dataset.id, version: Number(el.dataset.version), ack: 'inquiry', note: v.note }, store.get()); if (r.ok) { money = null; return say('先生に問い合わせました', 'ok'); } }
    else if (kind === 'fee-relief') { r = await call('family/fees/relief', { id: el.dataset.id, version: Number(el.dataset.version), reason: v.reason }, store.get()); if (r.ok) { money = null; return say('申請を受け付けました', 'ok'); } }
    else if (kind === 'event') { r = await call('family/events/add', v, store.get()); if (r.ok) { sched = null; return say('共有しました', 'ok'); } }
    if (!r) return;
    if (r.error.code === 'needLogin' && me) { store.set(''); me = null; }
    say(r.error.message, 'error');
  });
});
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'kid') { kid = b.dataset.id; try { sessionStorage.setItem(KID_KEY, kid); } catch {} ev.preventDefault(); return render(); }
  if (a === 'change') { change = { id: b.dataset.id, pick: '', note: '' }; return render(); }
  if (a === 'pick') { const n = document.getElementById('change-note'); if (n) change.note = n.value; change.pick = b.dataset.c; return render(); }
  if (a === 'close-change') { change = null; return render(); }
  if (a === 'gr-open') { const win = window.open('', '_blank'); run(async () => { const r = await openFile(() => call('files/link', { id: b.dataset.id }, store.get()), win); if (!r.ok) say(r.error.message, 'error'); }); return; }
  // 書いた内容は、送信中の表示に描き直す前に読んでおく（描き直すと入力欄が作り直される）
  if (a === 'send-change') { const n = document.getElementById('change-note'); if (n) change.note = n.value.trim(); }
  run(async () => {
    let r;
    if (a === 'send-change') {
      r = await call('family/lessons/request', { lessonId: change.id, kind: change.pick, note: change.note }, store.get());
      if (r.ok) { change = null; sched = null; return say({ move: '日時の変更をお願いしました', rest: 'お休みにしました', late: '先生に連絡しました', cancel: 'キャンセルの連絡を受け付けました' }[r.request ? r.request.kind : 'move'], 'ok'); }
    } else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('family/lessons/withdraw', { requestId: b.dataset.id }, store.get()); if (r.ok) { sched = null; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'hw-done' || a === 'hw-undo') { r = await call('family/homework/report', { id: b.dataset.id, undo: a === 'hw-undo' }, store.get()); if (r.ok) { learning = null; return say(a === 'hw-done' ? 'できたと先生に知らせました' : '取り消しました', 'ok'); } }
    else if (a === 'plan-ack') { r = await call('family/plans/ack', { id: b.dataset.id, version: Number(b.dataset.version), ack: 'confirmed' }, store.get()); if (r.ok) { money = null; return say('確認しました', 'ok'); } }
    else if (a === 'inv-report') { if (!confirm('振り込んだことを先生に知らせますか？')) return; r = await call('family/invoices/report', { id: b.dataset.id, version: Number(b.dataset.version) }, store.get()); if (r.ok) { money = null; return say('振込のご連絡を受け付けました', 'ok'); } }
    else if (a === 'del-event') { r = await call('family/events/delete', { id: b.dataset.id }, store.get()); if (r.ok) { sched = null; return say('消しました', 'ok'); } }
    else if (a === 'logout') { await call('family/logout', {}, store.get()); store.set(''); me = null; location.hash = ''; return say('ログアウトしました', 'ok'); }
    if (r) { if (r.error.code === 'needLogin') { store.set(''); me = null; } say(r.error.message, 'error'); }
  });
});
window.addEventListener('hashchange', () => { say(''); change = null; render(); });
(async function boot() {
  const auth = store.get();
  if (auth) { const r = await call('family/me', {}, auth); if (r.ok) me = r.me; else if (r.error.code === 'needLogin') { store.set(''); if (previewToken) say('プレビューの期限が切れました。管理画面から開き直してください', 'error'); } }
  render();
})();
