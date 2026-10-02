// スタッフの画面（作り直し v2、1段目）。ログイン・最初の設定・招待・再設定・アカウント・スタッフの管理。
// 2段目: 家族と生徒（教室管理者）・移行の準備（システム管理者）。授業などは 3 段目以降。それまでは今の管理画面（/kanri/）を使う。
import { call, session, esc } from '/assets/v2/api.js';
import { familiesPage, familyDetailPage, familiesSubmit, familiesClick, familiesInput, resetFamilies, leaveFamilies } from '/staff/families.js?v=20261002-stage4';
import { migratePage, migrateClick, resetMigrate } from '/staff/migrate.js?v=20261002-stage4';
import { schedulePage, scheduleSubmit, scheduleClick, resetSchedule } from '/staff/schedule.js?v=20261002-stage4';
import { recordsPage, recordPage, recordsSubmit, recordsClick, resetRecords, captureRecordInputs } from '/staff/records.js?v=20261002-stage4';

const store = session('sw2_staff');
const ROLE_LABEL = { teacher: '講師', manager: '教室管理者', sysadmin: 'システム管理者' };
const STATUS_LABEL = { invited: '招待中', active: '利用中', stopped: '停止' };
const app = document.getElementById('app'), nav = document.getElementById('nav');
let me = null, busy = false, notice = null, staffList = null, shownLink = null, bootstrap = null;

const legacyToken = () => { try { return localStorage.getItem('sw_admt') || ''; } catch { return ''; } };
function route() {
  const h = location.hash;
  if (h.startsWith('#invite=')) return { page: 'invite', token: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#reset=')) return { page: 'reset', token: decodeURIComponent(h.slice(7)) };
  if (h.startsWith('#family=')) return { page: 'family', id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#record=')) return { page: 'record', id: decodeURIComponent(h.slice(8)) };
  return { page: h.slice(1) || 'home' };
}
const say = (message, kind = '') => { notice = message ? { message, kind } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${esc(notice.message)}</p>` : '';
const dis = () => busy ? ' disabled' : '';
const roleTags = roles => roles.map(r => `<span class="tag">${esc(ROLE_LABEL[r] || r)}</span>`).join('');

async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }

function renderNav() {
  const r = route().page;
  if (!me) { nav.innerHTML = ''; return; }
  const items = [['home', 'ホーム'], ...(me.roles.includes('manager') || me.roles.includes('teacher') ? [['schedule', '予定'], ['records', '記録']] : []), ...(me.roles.includes('manager') ? [['families', '家族と生徒']] : []), ...(me.roles.includes('sysadmin') ? [['staff', 'スタッフ'], ['migrate', '移行']] : []), ['account', 'アカウント']];
  const on = r === 'family' ? 'families' : r === 'record' ? 'records' : r;
  nav.innerHTML = items.map(([k, label]) => `<a href="#${k}" class="${on === k ? 'on' : ''}">${label}</a>`).join('');
}

// ---------- ログインしていないときの画面 ----------
function loginPage() {
  let h = `<h1>ログイン</h1><p class="sub">スタッフ（講師・教室管理者・システム管理者）の入口です。</p>${noticeHtml()}`;
  h += `<form class="stack" data-form="login"><label>メールアドレス<input type="email" name="email" autocomplete="username" required></label>
    <label>パスワード<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary"${dis()}>${busy ? 'ログインしています…' : 'ログイン'}</button></form>
    <p><a href="#forgot">パスワードを忘れたとき</a></p>`;
  if (bootstrap && bootstrap.available) {
    h += `<h2>最初の設定</h2>`;
    h += legacyToken()
      ? `<p>まだ代表のアカウントがありません。この端末は今の管理画面にログインしているので、ここから代表のアカウントを作れます。パスワードは次の画面でご自身で決めます。</p><p><button data-action="bootstrap"${dis()}>代表のアカウントを作る</button></p>`
      : `<p class="small muted">まだ代表のアカウントがありません。今の管理画面（<a href="/kanri/">/kanri/</a>）にログインしてから、もう一度このページを開いてください。</p>`;
  }
  return h;
}
function forgotPage() {
  return `<h1>パスワードの再設定</h1><p class="sub">登録しているメールアドレスに、再設定のリンクを送ります（30分有効）。</p>${noticeHtml()}
    <form class="stack" data-form="forgot"><label>メールアドレス<input type="email" name="email" autocomplete="username" required></label>
    <button class="primary"${dis()}>再設定のメールを送る</button></form><p><a href="#">ログインに戻る</a></p>`;
}
function newPasswordForm(kind, label) {
  return `<form class="stack" data-form="${kind}"><label>新しいパスワード（12文字以上）<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <button class="primary"${dis()}>${label}</button></form>`;
}
let inviteInfo = null;
function invitePage(token) {
  if (!inviteInfo || inviteInfo.token !== token) {
    inviteInfo = { token, loading: true };
    call('staff/invite/info', { token }).then(r => { inviteInfo = { token, ...(r.ok ? r : { error: r.error.message }) }; render(); });
  }
  if (inviteInfo.loading) return '<p class="muted">確かめています…</p>';
  if (inviteInfo.error) return `<h1>アカウントの設定</h1><p class="notice error" role="alert">${esc(inviteInfo.error)}</p><p><a href="#">ログインへ</a></p>`;
  return `<h1>アカウントの設定</h1><p>${esc(inviteInfo.name)} さん（${esc(inviteInfo.email)}）のパスワードを決めてください。</p>${noticeHtml()}
    <input type="email" value="${esc(inviteInfo.email)}" autocomplete="username" hidden>${newPasswordForm('invite', 'パスワードを決めてはじめる')}`;
}
function resetPage() { return `<h1>新しいパスワード</h1>${noticeHtml()}${newPasswordForm('reset', 'パスワードを変える')}`; }

// ---------- ログインしたあとの画面 ----------
function homePage() {
  return `<h1>${esc(me.name)} さん</h1><p>${roleTags(me.roles)}</p>${noticeHtml()}
    <p class="notice">新しい管理画面は作っている途中です。今使えるのは、アカウント・スタッフ・家族と生徒・予定・移行の準備です。ここで登録・変更した内容は、切り替えまで今の仕組みには反映されません。授業・請求などの毎日の作業は、今までどおり <a href="/kanri/">今の管理画面</a> を使ってください。</p>`;
}
function accountPage() {
  return `<h1>アカウント</h1><p>${esc(me.name)}（${esc(me.email)}）</p><p>${roleTags(me.roles)}</p>${noticeHtml()}
    <h2>パスワードを変える</h2><form class="stack" data-form="password"><input type="email" value="${esc(me.email)}" autocomplete="username" hidden>
    <label>今のパスワード<input type="password" name="current" autocomplete="current-password" required></label>
    <label>新しいパスワード（12文字以上）<input type="password" name="next" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <button class="primary"${dis()}>変える</button><p class="small muted">変えると、ほかの端末はログインし直しになります。</p></form>
    <h2>ログアウト</h2><p><button data-action="logout"${dis()}>この端末からログアウト</button></p>`;
}
const roleChecks = (name, chosen) => `<div class="checks">${Object.keys(ROLE_LABEL).map(r => `<label><input type="checkbox" name="${name}" value="${r}"${chosen.includes(r) ? ' checked' : ''}> ${ROLE_LABEL[r]}</label>`).join('')}</div>`;
function staffPage() {
  if (!me.roles.includes('sysadmin')) return '<h1>スタッフ</h1><p class="notice error">システム管理者だけが使えます。</p>';
  if (!staffList) { loadStaff(); return '<h1>スタッフ</h1><p class="muted">読み込んでいます…</p>'; }
  let h = `<h1>スタッフ</h1><p class="sub">スタッフのアカウントと役割。講師は担当の授業と生徒だけ、教室管理者は運営のすべて、システム管理者は設定とアカウントを扱えます。</p>${noticeHtml()}`;
  if (shownLink) h += `<div class="notice ok"><p>${esc(shownLink.name)} さんに招待のメールを送りました。届かないときは、このリンクを LINE などで渡してください（7日有効・1回だけ使えます）。</p><p class="copy">${esc(shownLink.url)}</p><button data-action="copy-link"${dis()}>リンクをコピー</button></div>`;
  h += '<div class="list">' + staffList.map(s => `<div><div><strong>${esc(s.name)}</strong> <span class="tag ${s.status === 'active' ? '' : s.status === 'invited' ? 'warn' : 'gray'}">${STATUS_LABEL[s.status] || s.status}</span><div class="small muted">${esc(s.email)}</div>
      <form data-form="roles" data-id="${esc(s.id)}" data-version="${s.version}"><label>名前（担当・報酬の明細に出る）<input name="name" maxlength="60" value="${esc(s.name)}"></label>${roleChecks('roles', s.roles)}<div class="row" style="margin-top:6px"><button class="small"${dis()}>名前と役割を保存</button></div></form></div>
      <div class="row">${s.status === 'invited' ? `<button data-action="reinvite" data-id="${esc(s.id)}" data-name="${esc(s.name)}"${dis()}>招待をやり直す</button>` : ''}
      ${s.status === 'stopped' ? `<button data-action="status" data-status="active" data-id="${esc(s.id)}" data-version="${s.version}"${dis()}>再開する</button>` : s.id === me.id ? '' : `<button class="danger" data-action="status" data-status="stopped" data-id="${esc(s.id)}" data-version="${s.version}"${dis()}>停止する</button>`}</div></div>`).join('') + '</div>';
  h += `<h2>スタッフを招待する</h2><form class="stack" data-form="invite-staff"><label>名前<input name="name" maxlength="60" required></label>
    <label>メールアドレス<input type="email" name="email" required></label><div><div class="small muted">役割</div>${roleChecks('roles', ['teacher'])}</div>
    <button class="primary"${dis()}>招待のメールを送る</button></form>`;
  return h;
}
async function loadStaff() {
  const r = await call('admin/staff/list', {}, store.get());
  if (!r.ok) { if (r.error.code === 'needLogin') return signedOut(); say(r.error.message, 'error'); staffList = []; } else staffList = r.staff;
  render();
}
function signedOut() { store.set(''); me = null; resetFamilies(); resetMigrate(); resetSchedule(); resetRecords(); say('ログインし直してください', 'error'); render(); }
// 各ページ（families.js・migrate.js）に渡す共通の道具
const ctx = {
  call: (route, body = {}) => call(route, body, store.get()), esc, render: () => render(), dis: () => dis(), notice: () => noticeHtml(),
  say: (m, k) => say(m, k), handleAuth: r => { if (r && r.error && r.error.code === 'needLogin') { signedOut(); return true; } return false; },
  afterMigrate: () => { resetFamilies(); resetSchedule(); resetRecords(); },
  get isManager() { return !!me && me.roles.includes('manager'); },
};

function render() {
  renderNav();
  const r = route();
  let h;
  if (r.page === 'invite') h = invitePage(r.token);
  else if (r.page === 'reset') h = resetPage();
  else if (!me) h = r.page === 'forgot' ? forgotPage() : loginPage();
  else if (r.page === 'schedule' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = schedulePage(ctx, me);
  else if (r.page === 'records' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = recordsPage(ctx);
  else if (r.page === 'record' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = recordPage(ctx, r.id);
  else if (r.page === 'families' && me.roles.includes('manager')) h = familiesPage(ctx);
  else if (r.page === 'family' && me.roles.includes('manager')) h = familyDetailPage(ctx, r.id);
  else if (r.page === 'migrate' && me.roles.includes('sysadmin')) h = migratePage(ctx);
  else h = r.page === 'account' ? accountPage() : r.page === 'staff' ? staffPage() : homePage();
  app.className = !me || ['invite', 'reset', 'forgot'].includes(r.page) ? 'narrow' : '';
  app.innerHTML = h;
}

// ---------- 操作 ----------
const form = el => Object.fromEntries(new FormData(el).entries());
const checked = (el, name) => Array.from(el.querySelectorAll(`input[name="${name}"]:checked`)).map(i => i.value);
function signedIn(r) { store.set(r.auth); me = r.me; inviteInfo = null; staffList = null; say(''); location.hash = '#home'; }

app.addEventListener('submit', ev => {
  ev.preventDefault();
  const el = ev.target, kind = el.dataset.form, v = form(el);
  if (['invite', 'reset'].includes(kind) || kind === 'password') {
    const next = kind === 'password' ? v.next : v.password;
    if (next !== v.confirm) { say('2つのパスワードが一致しません', 'error'); return render(); }
  }
  const submitter = ev.submitter;
  captureRecordInputs(); // 記録の画面の書きかけを、描き直す前に覚えておく
  run(async () => {
    if (await familiesSubmit(ctx, kind, el) || await scheduleSubmit(ctx, kind, el) || await recordsSubmit(ctx, kind, el, { submitter })) return;
    let r;
    if (kind === 'login') { r = await call('staff/login', v); if (r.ok) return signedIn(r); }
    else if (kind === 'forgot') { r = await call('staff/reset/request', v); if (r.ok) return say(r.message, 'ok'); }
    else if (kind === 'invite') { r = await call('staff/invite/accept', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'reset') { r = await call('staff/reset/confirm', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'password') { r = await call('staff/password', { current: v.current, next: v.next }, store.get()); if (r.ok) { el.reset(); return say('パスワードを変えました', 'ok'); } }
    else if (kind === 'invite-staff') {
      r = await call('admin/staff/invite', { name: v.name, email: v.email, roles: checked(el, 'roles') }, store.get());
      if (r.ok) { shownLink = { name: r.staff.name, url: r.inviteUrl }; staffList = null; return say(''); }
    } else if (kind === 'roles') {
      r = await call('admin/staff/update', { id: el.dataset.id, version: Number(el.dataset.version), name: v.name, roles: checked(el, 'roles') }, store.get());
      if (r.ok) { staffList = null; if (me && r.staff.id === me.id) me = { ...me, name: r.staff.name }; resetSchedule(); return say(r.staff.name + ' さんの名前と役割を保存しました', 'ok'); }
    }
    if (!r) return;
    if (r.error && r.error.code === 'needLogin' && me) return signedOut();
    say(r.error.message, 'error');
  });
});
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'copy-link' && shownLink) { navigator.clipboard.writeText(shownLink.url).then(() => { say('リンクをコピーしました', 'ok'); render(); }); return; }
  if (a === 'copy') { navigator.clipboard.writeText(b.dataset.text || '').then(() => { say('コピーしました', 'ok'); render(); }); return; }
  captureRecordInputs();
  run(async () => {
    if (await familiesClick(ctx, a, b) || await migrateClick(ctx, a) || await scheduleClick(ctx, a, b) || await recordsClick(ctx, a, b)) return;
    let r;
    if (a === 'bootstrap') {
      r = await call('staff/bootstrap', { legacyToken: legacyToken() });
      if (r.ok) { bootstrap = null; location.hash = '#invite=' + r.inviteUrl.split('#invite=')[1]; return; }
    } else if (a === 'logout') { await call('staff/logout', {}, store.get()); store.set(''); me = null; location.hash = ''; return say('ログアウトしました', 'ok'); }
    else if (a === 'reinvite') { r = await call('admin/staff/reinvite', { id: b.dataset.id }, store.get()); if (r.ok) { shownLink = { name: b.dataset.name, url: r.inviteUrl }; return say(''); } }
    else if (a === 'status') {
      if (b.dataset.status === 'stopped' && !confirm('このスタッフを停止しますか？ ログイン中の端末もすぐに使えなくなります。')) return;
      r = await call('admin/staff/update', { id: b.dataset.id, version: Number(b.dataset.version), status: b.dataset.status }, store.get());
      if (r.ok) { staffList = null; return say(r.staff.name + ' さんを' + STATUS_LABEL[r.staff.status] + 'にしました', 'ok'); }
    }
    if (r && r.error && r.error.code === 'needLogin' && me) return signedOut();
    if (r) say(r.error.message, 'error');
  });
});
app.addEventListener('input', ev => { const n = ev.target.dataset && ev.target.dataset.input; if (n) familiesInput(ctx, n, ev.target); });
window.addEventListener('hashchange', () => { if (!['invite', 'reset'].includes(route().page)) inviteInfo = null; leaveFamilies(); say(''); render(); });

(async function boot() {
  const auth = store.get();
  if (auth) { const r = await call('staff/me', {}, auth); if (r.ok) me = r.me; else if (r.error.code === 'needLogin') store.set(''); }
  if (!me) { const s = await call('staff/bootstrap/status'); bootstrap = s.ok ? s : null; }
  render();
})();
