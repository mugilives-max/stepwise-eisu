// 保護者の画面（作り直し v2）。ログイン・招待・再設定、子どもの予定と「変更・お休みの連絡」、予定の共有、アカウント。
// 切り替えまでは準備中（今までの保護者ページ /hogosha/ を使う）。
import { call, session, esc } from '/assets/v2/api.js';
import { familyLessonList, changeDialog, eventList, eventForm } from '/assets/v2/schedule-view.js?v=20261002-stage4b';
import { learningView } from '/assets/v2/learning-view.js?v=20261002-stage4b';

const store = session('sw2_family');
const app = document.getElementById('app'), nav = document.getElementById('nav');
let me = null, busy = false, notice = null, sched = null, change = null, inviteInfo = null, learning = null;

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
function homePage() {
  if (!sched) { load(); return '<p class="muted">読み込んでいます…</p>'; }
  const names = Object.fromEntries(sched.students.map(s => [s.id, sched.students.length > 1 ? s.name : '']));
  let h = `${prep}<h1>予定</h1>${noticeHtml()}`;
  if (change) h += changeDialog(sched.lessons.find(l => l.id === change.id), change.pick, change.note, busy);
  h += familyLessonList(sched, { names });
  return h;
}
function eventsPage() {
  if (!sched) { load(); return '<p class="muted">読み込んでいます…</p>'; }
  const names = Object.fromEntries(sched.students.map(s => [s.id, s.name]));
  return `<h1>予定の共有</h1><p class="sub">テスト・行事・授業ができない日を先生に知らせます。予定を作るときの参考にします。</p>${noticeHtml()}${eventList(sched.events, { names, canDelete: e => e.createdByKind === 'family' })}<h2>予定を共有する</h2>${eventForm(sched.students)}`;
}
function learningPage() {
  if (!learning) { call('family/learning', {}, store.get()).then(r => { learning = r.ok ? r : { records: [], homework: [], students: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); return '<p class="muted">読み込んでいます…</p>'; }
  const names = Object.fromEntries(learning.students.map(s => [s.id, learning.students.length > 1 ? s.name : '']));
  return `<h1>学習</h1>${noticeHtml()}${learningView(learning, { names })}`;
}
function accountPage() {
  return `<h1>アカウント</h1><p>${esc(me.name)}（${esc(me.email)}）</p>${noticeHtml()}<h2>パスワードを変える</h2><form class="stack" data-form="password"><input type="email" value="${esc(me.email)}" autocomplete="username" hidden>
    <label>今のパスワード<input type="password" name="current" autocomplete="current-password" required></label><label>新しいパスワード（12文字以上）<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label><button class="primary"${dis()}>変える</button></form><h2>ログアウト</h2><p><button data-action="logout"${dis()}>この端末からログアウト</button></p>`;
}
async function load() { const r = await call('family/schedule', {}, store.get()); if (r.ok) sched = r; else if (r.error.code === 'needLogin') { store.set(''); me = null; } else { sched = { students: [], lessons: [], events: [], today: '' }; say(r.error.message, 'error'); } render(); }

function render() {
  const r = route();
  nav.innerHTML = me ? [['home', '予定'], ['learning', '学習'], ['events', '予定の共有'], ['account', 'アカウント']].map(([k, l]) => `<a href="#${k}" class="${r.page === k ? 'on' : ''}">${l}</a>`).join('') : '';
  let h;
  if (r.page === 'invite') h = invitePage(r.token);
  else if (r.page === 'reset') h = `<h1>新しいパスワード</h1>${noticeHtml()}${newPasswordForm('reset', 'パスワードを変える')}`;
  else if (!me) h = r.page === 'forgot' ? `<h1>パスワードの再設定</h1>${noticeHtml()}<form class="stack" data-form="forgot"><label>メールアドレス<input type="email" name="email" required></label><button class="primary"${dis()}>再設定のメールを送る</button></form><p><a href="#">ログインに戻る</a></p>` : loginPage();
  else h = r.page === 'events' ? eventsPage() : r.page === 'learning' ? learningPage() : r.page === 'account' ? accountPage() : homePage();
  app.className = !me ? 'narrow' : '';
  app.innerHTML = h;
}
function signedIn(r) { store.set(r.auth); me = r.me; sched = null; learning = null; say(''); location.hash = '#home'; }

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
    else if (kind === 'event') { r = await call('family/events/add', v, store.get()); if (r.ok) { sched = null; return say('共有しました', 'ok'); } }
    if (!r) return;
    if (r.error.code === 'needLogin' && me) { store.set(''); me = null; }
    say(r.error.message, 'error');
  });
});
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'change') { change = { id: b.dataset.id, pick: '', note: '' }; return render(); }
  if (a === 'pick') { const n = document.getElementById('change-note'); if (n) change.note = n.value; change.pick = b.dataset.c; return render(); }
  if (a === 'close-change') { change = null; return render(); }
  // 書いた内容は、送信中の表示に描き直す前に読んでおく（描き直すと入力欄が作り直される）
  if (a === 'send-change') { const n = document.getElementById('change-note'); if (n) change.note = n.value.trim(); }
  run(async () => {
    let r;
    if (a === 'send-change') {
      r = await call('family/lessons/request', { lessonId: change.id, kind: change.pick, note: change.note }, store.get());
      if (r.ok) { change = null; sched = null; return say({ move: '日時の変更をお願いしました', rest: 'お休みにしました', late: '先生に連絡しました', cancel: 'キャンセルの連絡を受け付けました' }[r.request ? r.request.kind : 'move'], 'ok'); }
    } else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('family/lessons/withdraw', { requestId: b.dataset.id }, store.get()); if (r.ok) { sched = null; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'hw-done' || a === 'hw-undo') { r = await call('family/homework/report', { id: b.dataset.id, undo: a === 'hw-undo' }, store.get()); if (r.ok) { learning = null; return say(a === 'hw-done' ? 'できたと先生に知らせました' : '取り消しました', 'ok'); } }
    else if (a === 'del-event') { r = await call('family/events/delete', { id: b.dataset.id }, store.get()); if (r.ok) { sched = null; return say('消しました', 'ok'); } }
    else if (a === 'logout') { await call('family/logout', {}, store.get()); store.set(''); me = null; location.hash = ''; return say('ログアウトしました', 'ok'); }
    if (r) { if (r.error.code === 'needLogin') { store.set(''); me = null; } say(r.error.message, 'error'); }
  });
});
window.addEventListener('hashchange', () => { say(''); change = null; render(); });
(async function boot() {
  const auth = store.get();
  if (auth) { const r = await call('family/me', {}, auth); if (r.ok) me = r.me; else if (r.error.code === 'needLogin') store.set(''); }
  render();
})();
