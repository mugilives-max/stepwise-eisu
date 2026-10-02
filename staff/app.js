// スタッフの画面（作り直し v2、1段目）。ログイン・最初の設定・招待・再設定・アカウント・スタッフの管理。
// 2段目: 家族と生徒・移行の準備。3段目: 予定。4段目: 記録。5段目: 計画・請求（staff/billing.js）。6段目: 成績（staff/grades.js）。7段目: 報酬（staff/payroll.js）。切り替えまでは今の管理画面（/kanri/）を使う。
import { call, session, esc } from '/assets/v2/api.js';
import { familiesPage, familyDetailPage, familiesSubmit, familiesClick, familiesInput, resetFamilies, leaveFamilies } from '/staff/families.js?v=20261003-ux12';
import { migratePage, migrateClick, migrateSubmit, resetMigrate } from '/staff/migrate.js?v=20261003-ux12';
import { schedulePage, scheduleSubmit, scheduleClick, resetSchedule } from '/staff/schedule.js?v=20261003-ux12';
import { recordsPage, recordPage, recordsSubmit, recordsClick, resetRecords, leaveRecords, captureRecordInputs } from '/staff/records.js?v=20261003-ux12';
import { plansPage, kindsPage, billingPage, billingSubmit, billingClick, resetBilling, leaveBilling } from '/staff/billing.js?v=20261003-ux12';
import { studentsPage, studentPage, studentsInput, resetStudents } from '/staff/students.js?v=20261003-ux12';
import { todayPage, todayClick, resetToday } from '/staff/home.js?v=20261003-ux12';
import { monthlyPage, settingsPage, resetMonthly } from '/staff/hubs.js?v=20261003-ux12';
import { payrollPage, ratesPage, payrollSubmit, payrollClick, payrollPrint, resetPayroll, leavePayroll } from '/staff/payroll.js?v=20261003-ux12';
import { sheet, rowButton, sliderInput } from '/staff/ui.js?v=20261003-ux12';
import { gradesOverviewPage, gradesStudentPage, gradesSubmit, gradesClick, resetGrades, leaveGrades, openGradeFile } from '/staff/grades.js?v=20261003-ux12';

const store = session('sw2_staff');
const ROLE_LABEL = { teacher: '講師', manager: '教室管理者', sysadmin: 'システム管理者' };
const STATUS_LABEL = { invited: '招待中', active: '利用中', stopped: '停止' };
const app = document.getElementById('app'), nav = document.getElementById('nav');
let lastPage = '';
let me = null, busy = false, notice = null, staffList = null, shownLink = null, bootstrap = null, staffOpen = '';

const legacyToken = () => { try { return localStorage.getItem('sw_admt') || ''; } catch { return ''; } };
function route() {
  const h = location.hash;
  if (h.startsWith('#invite=')) return { page: 'invite', token: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#reset=')) return { page: 'reset', token: decodeURIComponent(h.slice(7)) };
  if (h.startsWith('#family=')) return { page: 'family', id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#record=')) return { page: 'record', id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#grades=')) return { page: 'gradesOf', id: decodeURIComponent(h.slice(8)) };
  if (h.startsWith('#student=')) { const [id, tab] = h.slice(9).split('/'); return { page: 'student', id: decodeURIComponent(id), tab: tab || 'summary' }; }
  return { page: h.slice(1) || 'home' };
}
const say = (message, kind = '') => { notice = message ? { message, kind } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.kind}" role="${notice.kind === 'error' ? 'alert' : 'status'}">${esc(notice.message)}</p>` : '';
const dis = () => busy ? ' disabled' : '';
const roleTags = roles => roles.map(r => `<span class="tag">${esc(ROLE_LABEL[r] || r)}</span>`).join('');

async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }

// メニュー（docs/UX_STRUCTURE.md 3）: 教室管理者は 今日・予定・生徒・月の仕事・設定、講師は 今日・予定・生徒・報酬。スマホでは画面の下に出る
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  students: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/>',
  monthly: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  payroll: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
};
function navItems() {
  if (!me) return [];
  const m = me.roles.includes('manager'), t = me.roles.includes('teacher');
  if (m) return [['home', '今日'], ['schedule', '予定'], ['students', '生徒'], ['monthly', '月の仕事'], ['settings', '設定']];
  if (t) return [['home', '今日'], ['schedule', '予定'], ['students', '生徒'], ['payroll', '報酬'], ['settings', '設定']];
  return [['home', '今日'], ['settings', '設定']]; // システム管理者だけのとき
}
// いまの画面が、どの入口の下にあるか
function tabOf(page) {
  const m = me && me.roles.includes('manager');
  if (['student', 'family', 'families', 'gradesOf', 'grades'].includes(page)) return 'students';
  if (['records', 'record'].includes(page)) return 'home';
  if (['plans', 'billing'].includes(page)) return 'monthly';
  if (page === 'payroll') return m ? 'monthly' : 'payroll';
  if (['staff', 'migrate', 'account', 'rates', 'kinds'].includes(page)) return 'settings';
  return page;
}
// 戻る（入口の下の画面の左上）。来た道をたどる。直接開いたときは、その画面の入口へ
let trail = [], lastHash = location.hash || '#home';
function parentOf(r) {
  if (r.page === 'gradesOf') return '#student=' + encodeURIComponent(r.id) + '/grades';
  const t = tabOf(r.page);
  return t === r.page ? '' : '#' + t;
}
function backHtml(r) {
  if (!me || ['invite', 'reset', 'forgot'].includes(r.page)) return '';
  const top = parentOf(r); if (!top) return '';
  return `<a class="back" href="${esc(trail.at(-1) || top)}">‹ 戻る</a>`;
}
function renderNav() {
  if (!me) { nav.innerHTML = ''; document.body.classList.remove('has-tabs'); return; }
  const on = tabOf(route().page);
  nav.innerHTML = navItems().map(([k, label, icon]) => `<a href="#${k}" class="${on === k ? 'on' : ''}"${on === k ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[icon || k] || ''}</svg><span>${label}</span></a>`).join('');
  document.body.classList.add('has-tabs');
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
function accountPage() {
  return `<div class="page-head"><h1>アカウント</h1></div><p>${esc(me.name)}（${esc(me.email)}）</p><p>${roleTags(me.roles)}</p>${noticeHtml()}
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
  let h = `<div class="page-head"><h1>スタッフ</h1></div><p class="sub">講師は担当の授業と生徒だけ、教室管理者は運営のすべて、システム管理者は設定とアカウントを扱えます。</p>${noticeHtml()}`;
  if (shownLink) h += `<div class="notice ok"><p>${esc(shownLink.name)} さんに招待のメールを送りました。届かないときは、このリンクを LINE などで渡してください（7日有効・1回だけ使えます）。</p><p class="copy">${esc(shownLink.url)}</p><button data-action="copy-link"${dis()}>リンクをコピー</button></div>`;
  h += '<div class="rows">' + staffList.map(s => rowButton(esc, 'st-open', { id: s.id }, `${esc(s.name)} <span class="tag ${s.status === 'active' ? '' : s.status === 'invited' ? 'warn' : 'gray'}">${STATUS_LABEL[s.status] || s.status}</span>`,
    esc(s.roles.map(r => ROLE_LABEL[r] || r).join('・') + '・' + s.email))).join('') + '</div>';
  h += `<p style="margin-top:12px"><button class="primary" data-action="st-open" data-id="new"${dis()}>スタッフを招待する</button></p>`;
  if (staffOpen === 'new') {
    h += sheet(esc, 'スタッフを招待する', `<form class="stack" data-form="invite-staff"><div class="row"><label style="flex:1">姓<input name="familyName" maxlength="30" required></label><label style="flex:1">名<input name="givenName" maxlength="30"></label></div>
      <label>メールアドレス<input type="email" name="email" required></label><div><div class="small muted">役割</div>${roleChecks('roles', ['teacher'])}</div>
      <button class="primary"${dis()}>招待のメールを送る</button></form>`, 'st-close');
  } else if (staffOpen) {
    const s = staffList.find(x => x.id === staffOpen);
    if (s) h += sheet(esc, s.name, `<p class="small muted" style="margin-top:0">${esc(s.email)}・${STATUS_LABEL[s.status] || s.status}</p>
      <form class="stack" data-form="roles" data-id="${esc(s.id)}" data-version="${s.version}"><div class="row"><label style="flex:1">姓<input name="familyName" maxlength="30" value="${esc(s.familyName || s.name)}"></label><label style="flex:1">名<input name="givenName" maxlength="30" value="${esc(s.givenName || '')}"></label></div><p class="small muted" style="margin:0">名前は担当の表示と報酬の明細に出ます。</p>
      <div><div class="small muted">役割</div>${roleChecks('roles', s.roles)}</div><button class="primary"${dis()}>名前と役割を保存</button></form>
      <div class="row" style="margin-top:14px">${s.status === 'invited' ? `<button data-action="reinvite" data-id="${esc(s.id)}" data-name="${esc(s.name)}"${dis()}>招待をやり直す</button>` : ''}
      ${s.status === 'stopped' ? `<button data-action="status" data-status="active" data-id="${esc(s.id)}" data-version="${s.version}"${dis()}>再開する</button>` : s.id === me.id ? '' : `<button class="danger" data-action="status" data-status="stopped" data-id="${esc(s.id)}" data-version="${s.version}"${dis()}>停止する</button>`}</div>`, 'st-close');
  }
  return h;
}
async function loadStaff() {
  const r = await call('admin/staff/list', {}, store.get());
  if (!r.ok) { if (r.error.code === 'needLogin') return signedOut(); say(r.error.message, 'error'); staffList = []; } else staffList = r.staff;
  render();
}
function signedOut() { store.set(''); me = null; resetFamilies(); resetMigrate(); resetSchedule(); resetRecords(); resetBilling(); resetGrades(); resetPayroll(); resetToday(); resetStudents(); say('ログインし直してください', 'error'); render(); }
// 各ページ（families.js・migrate.js）に渡す共通の道具
const ctx = {
  call: (route, body = {}) => call(route, body, store.get()), esc, render: () => render(), dis: () => dis(), notice: () => noticeHtml(),
  say: (m, k) => say(m, k), handleAuth: r => { if (r && r.error && r.error.code === 'needLogin') { signedOut(); return true; } return false; },
  afterMigrate: () => { resetFamilies(); resetSchedule(); resetRecords(); resetBilling(); resetGrades(); resetToday(); resetStudents(); },
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
  else if (r.page === 'students' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = studentsPage(ctx);
  else if (r.page === 'student' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = studentPage(ctx, r.id, r.tab);
  else if (r.page === 'grades' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = gradesOverviewPage(ctx);
  else if (r.page === 'payroll' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = payrollPage(ctx, me);
  else if (r.page === 'gradesOf' && (me.roles.includes('manager') || me.roles.includes('teacher'))) h = gradesStudentPage(ctx, r.id);
  else if (r.page === 'families' && me.roles.includes('manager')) h = familiesPage(ctx);
  else if (r.page === 'family' && me.roles.includes('manager')) h = familyDetailPage(ctx, r.id);
  else if (r.page === 'plans' && me.roles.includes('manager')) h = plansPage(ctx);
  else if (r.page === 'billing' && me.roles.includes('manager')) h = billingPage(ctx);
  else if (r.page === 'kinds' && me.roles.includes('manager')) h = kindsPage(ctx);
  else if (r.page === 'rates' && me.roles.includes('manager')) h = ratesPage(ctx);
  else if (r.page === 'migrate' && me.roles.includes('sysadmin')) h = migratePage(ctx);
  else if (r.page === 'monthly' && me.roles.includes('manager')) h = monthlyPage(ctx);
  else if (r.page === 'settings') h = settingsPage(ctx, me);
  else h = r.page === 'account' ? accountPage() : r.page === 'staff' ? staffPage() : (me.roles.includes('manager') || me.roles.includes('teacher')) ? todayPage(ctx, me) : settingsPage(ctx, me);
  app.className = !me || ['invite', 'reset', 'forgot'].includes(r.page) ? 'narrow' : r.page === 'schedule' ? 'wide' : '';
  const was = app.querySelector('.bsheet'), wasLabel = was && was.getAttribute('aria-label'), wasTop = was ? was.scrollTop : 0;
  app.innerHTML = backHtml(r) + h;
  const now = app.querySelector('.bsheet');
  if (now && wasLabel === now.getAttribute('aria-label')) { now.classList.add('still'); now.scrollTop = wasTop; }
  if (now && notice && notice.kind === 'error') now.querySelector('.bsheet-body').insertAdjacentHTML('afterbegin', noticeHtml()); // 下から出る画面の中でも見えるように
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
    if (await familiesSubmit(ctx, kind, el) || await scheduleSubmit(ctx, kind, el) || await recordsSubmit(ctx, kind, el, { submitter }) || await billingSubmit(ctx, kind, el) || await gradesSubmit(ctx, kind, el) || await payrollSubmit(ctx, kind, el) || await migrateSubmit(ctx, kind, el)) return;
    let r;
    if (kind === 'login') { r = await call('staff/login', v); if (r.ok) return signedIn(r); }
    else if (kind === 'forgot') { r = await call('staff/reset/request', v); if (r.ok) return say(r.message, 'ok'); }
    else if (kind === 'invite') { r = await call('staff/invite/accept', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'reset') { r = await call('staff/reset/confirm', { token: route().token, password: v.password }); if (r.ok) return signedIn(r); }
    else if (kind === 'password') { r = await call('staff/password', { current: v.current, next: v.next }, store.get()); if (r.ok) { el.reset(); return say('パスワードを変えました', 'ok'); } }
    else if (kind === 'invite-staff') {
      r = await call('admin/staff/invite', { familyName: v.familyName, givenName: v.givenName, email: v.email, roles: checked(el, 'roles') }, store.get());
      if (r.ok) { shownLink = { name: r.staff.name, url: r.inviteUrl }; staffList = null; staffOpen = ''; return say(''); }
    } else if (kind === 'roles') {
      r = await call('admin/staff/update', { id: el.dataset.id, version: Number(el.dataset.version), familyName: v.familyName, givenName: v.givenName, roles: checked(el, 'roles') }, store.get());
      if (r.ok) { staffList = null; staffOpen = ''; if (me && r.staff.id === me.id) me = { ...me, name: r.staff.name }; resetSchedule(); return say(r.staff.name + ' さんの名前と役割を保存しました', 'ok'); }
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
  // 成績票は、待たずに新しいタブを開いてから読む（あとから開くと止められる）
  if (a === 'gr-open') { const win = window.open('', '_blank'); run(async () => { const r = await openGradeFile(ctx, b, win); if (!r.ok) say(r.error.message, 'error'); }); return; }
  // 保護者ページ・生徒ページのプレビュー: 新しいタブを先に開いてから、プレビューの鍵をもらって移す
  if (a === 'pv-open') { const win = window.open('', '_blank'); run(async () => { const r = await call('admin/preview/start', { kind: b.dataset.kind, id: b.dataset.id }, store.get()); if (r.ok) { if (win && !win.closed) win.location.href = r.url; else location.href = r.url; } else { if (win) win.close(); say(r.error.message, 'error'); } }); return; }
  if (a === 'pr-print' || a === 'pr-print-mine') { if (!payrollPrint(ctx, a, b, me)) { say('印刷の窓を開けませんでした。ポップアップを許可してください', 'error'); render(); } return; }
  if (a === 'st-open') { staffOpen = b.dataset.id; shownLink = null; say(''); render(); return; }
  if (a === 'st-close') { staffOpen = ''; render(); return; }
  if (a === 'gr-resolve') { const sel = document.querySelector(`[data-resolve-exam="${b.dataset.id}"]`); b.dataset.exam = sel ? sel.value : ''; }
  captureRecordInputs();
  run(async () => {
    if (await todayClick(ctx, a, b) || await familiesClick(ctx, a, b) || await migrateClick(ctx, a) || await scheduleClick(ctx, a, b) || await recordsClick(ctx, a, b) || await billingClick(ctx, a, b) || await gradesClick(ctx, a, b) || await payrollClick(ctx, a, b)) return;
    let r;
    if (a === 'bootstrap') {
      r = await call('staff/bootstrap', { legacyToken: legacyToken() });
      if (r.ok) { bootstrap = null; location.hash = '#invite=' + r.inviteUrl.split('#invite=')[1]; return; }
    } else if (a === 'logout') { await call('staff/logout', {}, store.get()); store.set(''); me = null; location.hash = ''; return say('ログアウトしました', 'ok'); }
    else if (a === 'reinvite') { r = await call('admin/staff/reinvite', { id: b.dataset.id }, store.get()); if (r.ok) { shownLink = { name: b.dataset.name, url: r.inviteUrl }; staffOpen = ''; return say(''); } }
    else if (a === 'status') {
      if (b.dataset.status === 'stopped' && !confirm('このスタッフを停止しますか？ ログイン中の端末もすぐに使えなくなります。')) return;
      r = await call('admin/staff/update', { id: b.dataset.id, version: Number(b.dataset.version), status: b.dataset.status }, store.get());
      if (r.ok) { staffList = null; staffOpen = ''; return say(r.staff.name + ' さんを' + STATUS_LABEL[r.staff.status] + 'にしました', 'ok'); }
    }
    if (r && r.error && r.error.code === 'needLogin' && me) return signedOut();
    if (r) say(r.error.message, 'error');
  });
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { const x = app.querySelector('.bsheet-head button.icon'); if (x) x.click(); } });
app.addEventListener('change', ev => { if (ev.target.dataset && ev.target.dataset.slider) sliderInput(ev.target); }); // 押しただけのときは change だけ来ることがある
app.addEventListener('input', ev => { if (ev.target.dataset && ev.target.dataset.slider) return sliderInput(ev.target); const n = ev.target.dataset && ev.target.dataset.input; if (n && !studentsInput(ctx, n, ev.target)) familiesInput(ctx, n, ev.target); });
window.addEventListener('hashchange', () => {
  // 「今日」「生徒」に戻ってきたら読み直す（記録を書いたあとなど）。同じ生徒の画面のタブを切り替えるときは読み直さない
  const pg = route().page, hash = location.hash || '#home';
  if (pg !== lastPage) {
    const i = trail.lastIndexOf(hash);
    if (i >= 0) trail = trail.slice(0, i); // 戻ってきた
    else if (!parentOf(route())) trail = []; // 入口を開いた
    else trail.push(lastHash);
  }
  lastHash = hash; staffOpen = '';
  if (pg === 'home') resetToday();
  if (pg === 'monthly') resetMonthly();
  if ((pg === 'student' && lastPage !== 'student') || pg === 'students') resetStudents();
  lastPage = pg;
  if (!['invite', 'reset'].includes(route().page)) inviteInfo = null; leaveFamilies(); leaveRecords(); leaveGrades(); leaveBilling(); leavePayroll(); say(''); render(); });

(async function boot() {
  const auth = store.get();
  if (auth) { const r = await call('staff/me', {}, auth); if (r.ok) me = r.me; else if (r.error.code === 'needLogin') store.set(''); }
  if (!me) { const s = await call('staff/bootstrap/status'); bootstrap = s.ok ? s : null; }
  render();
})();
