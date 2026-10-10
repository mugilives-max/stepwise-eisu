// 保護者の画面（作り直し v2）。入口は ホーム・予定・学習・お支払い（docs/UX_STRUCTURE.md 4）。子どもが2人以上なら上で切り替える。
// 一覧は白い枠に 1 件 1 行、操作（連絡・承認・振込の連絡・申請）は押すと下から出る画面で（assets/v2/portal-ui.js）。
// ログイン・招待・再設定、アカウント（右上）。切り替える前は「準備中」の案内を出す（health の cutover.live で決める）。
import { call, session, esc, liveState } from '/assets/v2/api.js';
import { gradesView, gradesClickShared, uploadFile, openFile } from '/assets/v2/grades-view.js?v=20261008-launch1';
import { monthCalendar, gridStart, gridEnd } from '/assets/v2/calendar.js?v=20261008-launch1';
import { EVENT_KIND } from '/assets/v2/schedule-view.js?v=20261008-launch1';
import { termsCard, termsLine, lessonRows, dayRows, nextLessonHero, lessonSheet, homeworkRows, recordCards, planGroups, planApprovalCard, planAckCard, planHistory, inquirySheet, invoiceRows, invoiceSheet, feeRows, feeSheet, eventRows, eventSheet, wireSheets, keepSheet, ibox, picon, yen, md, monthLabel, daysText, given } from '/assets/v2/portal-ui.js?v=20261008-launch1';

// スタッフのプレビュー（#preview=pv2.…）: 本物のログイン（sw2_family）には触れず、このタブだけで使う。書き込みはサーバーが断る
const PV_KEY = 'sw2_family_preview';
if (location.hash.startsWith('#preview=')) { try { sessionStorage.setItem(PV_KEY, decodeURIComponent(location.hash.slice(9))); } catch {} history.replaceState(null, '', location.pathname + '#home'); }
const previewToken = (() => { try { return sessionStorage.getItem(PV_KEY) || ''; } catch { return ''; } })();
const store = previewToken ? { get: () => previewToken, set: () => {} } : session('sw2_family');
// プレビューでは画面に帯を出さない（本物と同じ見え方を確かめるため。本人 2026-10-09）。見分けはタブの題名だけ。押しても変わらないことはサーバーが保証する
const previewBar = () => { if (previewToken && me && !document.title.startsWith('（プレビュー）')) document.title = `（プレビュー）${document.title}`; return ''; };
const app = document.getElementById('app'), nav = document.getElementById('nav');
let me = null, busy = false, notice = null, sched = null, learning = null, money = null, grades = null, inviteInfo = null;
let cal = null, calData = {}; // 月の予定表と、月ごとに読んだ予定（{ 'YYYY-MM': 応答 }）
let sheetState = null; // 下から出る画面: { kind: 'lesson', id, pick, note } | { kind: 'event' } | { kind: 'invoice', id } | { kind: 'fee', id, note } | { kind: 'inquiry', month, note }
const planCounts = {}; // 承認の画面で変えた回数 { [lineId]: n }
let termsChecked = false; // 規約の「同意します」の印（描き直しても消えないように）

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
// 切り替える前だけ出す案内（health の cutover.live で決める）
const prepText = '<p class="notice small">準備中の新しい保護者ページです。今は今までの <a href="/hogosha/">保護者ページ</a> をお使いください。</p>';
const prep = () => { const s = liveState(render); return s.known && !s.live ? prepText : ''; };

function newPasswordForm(kind, label) {
  return `<form class="stack" data-form="${kind}"><label>新しいパスワード（12文字以上）<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="primary"${dis()}>${label}</button></form>`;
}
function loginPage() {
  return `${prep()}<h1>保護者ページ</h1>${noticeHtml()}<form class="stack" data-form="login"><label>メールアドレス<input type="email" name="email" autocomplete="username" required></label>
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
const TITLE = { home: 'ホーム', schedule: '予定', learning: '学習', money: 'お支払い', account: 'アカウント' };
// 前の URL（#events・#grades）も開けるように
const pageOf = p => p === 'events' ? 'schedule' : p === 'grades' ? 'learning' : p;

// 子どもの切り替え（2人以上のとき）。予定は「全員」も選べる。選んだ子どもはこのタブで覚える
const KID_KEY = 'sw2_family_kid';
let kid = (() => { try { return sessionStorage.getItem(KID_KEY) || ''; } catch { return ''; } })();
const kids = () => (sched && sched.students) || [];
const names = () => Object.fromEntries(kids().map(s => [s.id, s.name]));
function kidPicker(allowAll) {
  const ks = kids(); if (ks.length < 2) return '';
  if (!allowAll && !ks.some(s => s.id === kid)) kid = ks[0].id;
  const opts = (allowAll ? [['', '全員']] : []).concat(ks.map(s => [s.id, given(s.name)]));
  return '<div class="tabs2" role="tablist" aria-label="子ども">' + opts.map(([id, label]) => `<a href="javascript:void 0" role="tab" data-action="kid" data-id="${esc(id)}" class="${kid === id ? 'on' : ''}">${esc(label)}</a>`).join('') + '</div>';
}
const forKid = (rows, key = 'studentId') => !kid ? rows : rows.filter(x => x[key] === kid);
const multiKids = () => kids().length > 1;

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
const upcoming = () => sched.lessons.filter(l => l.date >= sched.today && ['proposed', 'decided'].includes(l.status));
const secTitle = (t, extra = '') => `<div class="sec-title">${t}${extra}</div>`;

// ホーム: 次の授業（大きく）・やること・近い授業・テスト・新しい記録
function homePage() {
  if (need('sched', 'learning', 'money')) return loading;
  let h = `${prep()}${noticeHtml()}`;
  const next = upcoming();
  h += nextLessonHero(next[0], { names: names(), today: sched.today });
  // やること（押すとその画面へ）
  const todo = [], { asks, acks } = planGroups(money.plans);
  if (money.terms && money.terms.needs) todo.push(['#money', 'file', '#c98a00', '受講規約への同意', (money.terms.current.title || '受講規約') + '・全文を読んで同意してください', 1]);
  if (asks.length) todo.push(['#money', 'plan', '#5b6672', '授業計画の承認', asks.map(([m]) => monthLabel(m)).join('・') + 'の計画を確かめて承認してください', asks.length]);
  if (acks.length) todo.push(['#money', 'check', '#138a8a', '授業計画の確認', acks.map(([m]) => monthLabel(m)).join('・') + '・先生が記録した承諾の内容を確かめてください', acks.length]);
  const kari = sched.lessons.filter(l => l.status === 'proposed' && l.confirmBy);
  if (kari.length) { const by = kari.map(l => l.confirmBy).sort()[0]; todo.push(['#schedule', 'calendar', '#e0a100', '仮予定の確認', `${md(by)}までに連絡がなければ、この日時で決まります`, kari.length]); }
  const due = money.invoices.filter(v => v.status === 'confirmed');
  if (due.length) todo.push(['#money', 'yen', '#c0392b', 'お支払い', due.map(v => `${monthLabel(v.month)}分 ${yen(v.total)}`).join('・'), due.length]);
  const hw = learning.homework.filter(w => w.status === 'open');
  if (hw.length) todo.push(['#learning', 'homework', '#7b4fd6', '宿題', 'できたら左の丸を押してください', hw.length]);
  h += secTitle('やること');
  h += todo.length ? '<div class="group">' + todo.map(([href, ic, color, label, note, n]) => `<a class="todo-row" href="${href}">${ibox(ic, color, label)}<span class="v"><span class="lbl">${esc(label)}</span><small>${esc(note)}</small></span><span class="cnt">${n}</span><span class="go">›</span></a>`).join('') + '</div>' : '<p class="muted small">いま、やることはありません。</p>';
  // そのあとの授業（最大 4 件）
  const more = next.slice(1, 5);
  if (more.length) h += secTitle('そのあとの授業', '<a class="more" href="#schedule">すべて見る ›</a>') + lessonRows(more, { names: names(), today: sched.today });
  const tests = sched.events.filter(e => e.kind === 'test' && e.dateTo >= sched.today).slice(0, 2);
  if (tests.length) h += secTitle('テスト') + eventRows(tests, { names: multiKids() ? names() : {}, today: sched.today });
  if (learning.records.length) h += secTitle('新しい授業の記録', '<a class="more" href="#learning">すべて見る ›</a>') + recordCards(learning.records, learning.homework, { names: multiKids() ? names() : {}, limit: 1 });
  return h;
}
// 予定: 月の表（スタッフと同じ動き）。子どもを選べる。日を押すとその日の一覧、授業を押すと下から出る画面で「変更・お休みの連絡」。テスト・行事を知らせるは上の帯の右
const RANK = { proposed: 1, decided: 2, done: 3 };
function needCal(month) {
  if (!calData[month]) { calData[month] = { loading: true }; call('family/schedule', { from: gridStart(month), to: gridEnd(month) }, store.get()).then(r => { calData[month] = r.ok ? r : { lessons: [], events: [], students: [], today: '' }; if (!r.ok) failed(r); render(); }); }
  return calData[month].loading;
}
// 月の表に出す短い名前: 名（同じ名の子がいれば姓名）
const shortName = id => { const s = kids().find(k => k.id === id); if (!s) return ''; const g = given(s.name); return kids().filter(k => given(k.name) === g).length > 1 ? s.name : g; };
function schedulePage() {
  if (need('sched')) return loading;
  if (!cal) cal = monthCalendar({ today: sched.today, onChange: () => render() });
  let h = `${kidPicker(true)}${cal.bar(esc, `<button class="ibtn" data-action="add-event" aria-label="テスト・行事を知らせる" title="テスト・行事を知らせる">${picon('plus')}</button>`)}${noticeHtml()}`;
  if (needCal(cal.month)) return h + loading;
  const d = calData[cal.month], multi = multiKids() && !kid, nm = names();
  const lessons = forKid(d.lessons).filter(l => l.status !== 'held'), events = forKid(d.events);
  const kari = lessons.filter(l => l.status === 'proposed' && l.confirmBy);
  if (kari.length) h += `<p class="notice small" style="margin:0 0 6px">仮予定（オレンジ）${kari.length}件：都合の悪い授業だけ押して連絡してください。連絡がなければ締め切りで決まります。</p>`;
  const cell = date => {
    const ls = lessons.filter(l => l.date === date && l.status in RANK);
    const bars = events.filter(e => e.date <= date && date <= e.dateTo).map(e => `<span class="bar ${e.kind === 'unavailable' ? 'off' : e.kind}">${esc(e.title || EVENT_KIND[e.kind])}</span>`);
    let chips;
    if (multi) { const by = {}; ls.forEach(l => { const g = by[l.studentId] = by[l.studentId] || { n: 0, rank: 9 }; g.n++; g.rank = Math.min(g.rank, RANK[l.status]); }); chips = Object.entries(by).map(([sid, g]) => `<span class="nm r${g.rank}">${esc(shortName(sid))}${g.n > 1 ? `<small>×${g.n}</small>` : ''}</span>`); }
    else chips = ls.sort((a, b) => a.start.localeCompare(b.start)).map(l => `<span class="nm r${RANK[l.status]}">${esc(l.subject)}</span>`);
    return { lines: bars.concat(chips), count: ls.length };
  };
  const day = (date, first) => cal.dayHead(date, first, `<span class="muted small">授業 ${lessons.filter(l => l.date === date && l.status in RANK).length}件</span>`) + dayRows(date, lessons, events, { names: multi ? nm : {}, canDelete: e => e.createdByKind === 'family' });
  h += cal.html(esc, { cell, day });
  return h;
}
// 学習: 子どもを選んで「記録と宿題」「成績」
function learningPage(sub) {
  if (need('sched')) return loading;
  const tab = sub === 'grades' ? 'grades' : 'records';
  let h = `${kidPicker(false)}<div class="seg" style="margin-top:8px"><a href="#learning" class="${tab === 'records' ? 'on' : ''}">記録と宿題</a><a href="#learning/grades" class="${tab === 'grades' ? 'on' : ''}">成績</a></div>${noticeHtml()}`;
  if (tab === 'records') {
    if (need('learning')) return h + loading;
    const hw = forKid(learning.homework).filter(w => w.status !== 'confirmed');
    h += secTitle(`宿題${hw.length ? ` <span class="count">${hw.length}</span>` : ''}`) + homeworkRows(hw);
    h += secTitle('授業の記録') + recordCards(forKid(learning.records), learning.homework);
    return h;
  }
  if (need('grades')) return h + loading;
  const st = grades.students.find(s => s.id === kid) || grades.students[0];
  return h + (st ? gradesView(st, { who: 'family', dis: dis() }) : '<p class="muted">まだ成績はありません。</p>');
}
// お支払い: 授業計画（月ごとに 1 枚）・授業料・キャンセル料
function moneyPage() {
  if (need('money')) return loading;
  const multi = new Set(money.plans.map(l => l.studentId).concat(money.fees.map(f => f.studentId))).size > 1;
  let h = noticeHtml();
  const { asks, acks, others } = planGroups(money.plans), needTerms = !!(money.terms && money.terms.needs);
  if (asks.length || acks.length || needTerms) {
    h += secTitle('確かめていただきたいこと');
    if (needTerms) h += termsCard(money.terms, { busy, checked: termsChecked });
    h += asks.map(([m, ls]) => planApprovalCard(m, ls, { multi, counts: planCounts, dis: dis() || (needTerms ? ' disabled' : '') })).join('');
    h += acks.map(([m, ls]) => planAckCard(m, ls, { multi, dis: dis() })).join('');
  }
  h += secTitle('授業料') + invoiceRows(money.invoices);
  if (money.fees.length) h += secTitle('キャンセル料・取消料') + feeRows(money.fees, { multi });
  if (others.length) h += secTitle('授業計画') + planHistory(others, { multi });
  if (money.terms && !needTerms) h += termsLine(money.terms);
  return h;
}
function accountPage() {
  if (previewToken) return `<p class="muted">プレビューでは使えません。</p>`;
  return `<p>${esc(me.name)}（${esc(me.email)}）</p>${money && money.terms ? termsLine(money.terms) : ''}${noticeHtml()}<h2>パスワードを変える</h2><form class="stack" data-form="password"><input type="email" value="${esc(me.email)}" autocomplete="username" hidden>
    <label>今のパスワード<input type="password" name="current" autocomplete="current-password" required></label><label>新しいパスワード（12文字以上）<input type="password" name="next" autocomplete="new-password" minlength="12" required></label>
    <label>もう一度<input type="password" name="confirm" autocomplete="new-password" minlength="12" required></label><button class="primary"${dis()}>変える</button></form><h2>ログアウト</h2><p><button data-action="logout"${dis()}>この端末からログアウト</button></p>`;
}
const findLesson = id => { for (const src of [sched].concat(Object.values(calData))) { const l = src && src.lessons && src.lessons.find(x => x.id === id); if (l) return l; } return null; };
// 下から出る画面
function sheetHtml() {
  const s = sheetState; if (!s || !me) return '';
  if (s.kind === 'lesson') { const l = findLesson(s.id); return l ? lessonSheet(l, s, { names: multiKids() ? names() : {}, busy }) : ''; }
  if (s.kind === 'event') return eventSheet(kid ? kids().filter(x => x.id === kid) : kids());
  if (s.kind === 'invoice') { const v = money && money.invoices && money.invoices.find(x => x.id === s.id); return v ? invoiceSheet(v, { multi: multiKids(), busy }) : ''; }
  if (s.kind === 'fee') { const f = money && money.fees && money.fees.find(x => x.id === s.id); return f ? feeSheet(f, { busy, note: s.note }) : ''; }
  if (s.kind === 'inquiry') return inquirySheet(s.month, s.note, busy);
  return '';
}
// 上の帯に画面の名前（スマホでは「ステップワイズ」の代わりに）
function renderBar(page) {
  const bar = document.querySelector('.top .in'); if (!bar) return;
  bar.querySelectorAll('.bar-title').forEach(x => x.remove());
  const title = me ? TITLE[page] : '';
  if (title) bar.firstElementChild.insertAdjacentHTML('afterend', `<div class="bar-title"><strong>${esc(title)}</strong></div>`);
  document.body.classList.toggle('has-bar', !!title);
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
  renderBar(me ? page : '');
  keepSheet(app, () => { app.innerHTML = previewBar() + h + sheetHtml(); });
  if (me && page === 'schedule' && cal) cal.afterRender(render);
  const box = app.querySelector('.bsheet');
  if (box && notice && notice.k === 'error') box.querySelector('.bsheet-body').insertAdjacentHTML('afterbegin', noticeHtml()); // 下から出る画面の中でも見えるように
}
function signedIn(r) { store.set(r.auth); me = r.me; sched = null; calData = {}; cal = null; learning = null; money = null; grades = null; say(''); location.hash = '#home'; }
const closeSheet = () => { sheetState = null; };
// 下から出る画面の入力は、描き直す前に読んでおく（描き直すと入力欄が作り直される）
function captureSheetInputs() {
  const s = sheetState; if (!s) return;
  const el = document.getElementById(s.kind === 'lesson' ? 'change-note' : s.kind === 'fee' ? 'relief-note' : s.kind === 'inquiry' ? 'inquiry-note' : '');
  if (el) s.note = el.value;
}
// 失敗したとき: ログインが切れていればログイン画面へ。それ以外は文を出す
function failed(r) { if (r.error.code === 'needLogin' && me) { store.set(''); me = null; } say(r.error.message, 'error'); }

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
    } else if (kind === 'plan-approve') {
      // 月の計画をまとめて承認する（行ごとの回数は画面で選んだ値）。途中で失敗したら、そこまでの承認は済んでいる
      const [, lines] = planGroups(money.plans).asks.find(([m]) => m === el.dataset.month) || [];
      if (!lines) return;
      const zero = lines.filter(l => (planCounts[l.id] === undefined ? l.count : planCounts[l.id]) === 0);
      if (zero.length && !confirm(`${zero.map(l => l.subject).join('・')}を見送りにします。よろしいですか？`)) return;
      let okCount = 0;
      for (const l of lines) {
        const n = planCounts[l.id] === undefined ? l.count : planCounts[l.id];
        r = await call('family/plans/decide', { id: l.id, version: l.version, approvedCount: n }, store.get());
        if (!r.ok) break; okCount++; delete planCounts[l.id];
      }
      money = null;
      if (r.ok) return say(`${monthLabel(el.dataset.month)}の計画を承認しました。ありがとうございます`, 'ok');
      if (okCount) say(`${okCount}件は承認できましたが、途中で止まりました: ${r.error.message}`, 'error');
    } else if (kind === 'event') { r = await call('family/events/add', v, store.get()); if (r.ok) { sched = null; calData = {}; closeSheet(); return say('先生に知らせました', 'ok'); } }
    if (!r) return;
    failed(r);
  });
});
app.addEventListener('change', ev => { if (ev.target.id === 'terms-agree') { termsChecked = ev.target.checked; return; } const id = ev.target.dataset && ev.target.dataset.planCount; if (id) { planCounts[id] = Number(ev.target.value); render(); } });
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (cal && cal.click(a, b)) return render();
  if (gradesClickShared(a, b)) return render();
  if (a === 'kid') { kid = b.dataset.id; try { sessionStorage.setItem(KID_KEY, kid); } catch {} ev.preventDefault(); return render(); }
  if (a === 'lesson') { sheetState = { kind: 'lesson', id: b.dataset.id, pick: '', note: '' }; return render(); }
  if (a === 'pick') { captureSheetInputs(); sheetState.pick = b.dataset.c; return render(); }
  if (a === 'close-sheet') { closeSheet(); return render(); }
  if (a === 'add-event') { sheetState = { kind: 'event' }; return render(); }
  if (a === 'invoice') { sheetState = { kind: 'invoice', id: b.dataset.id }; return render(); }
  if (a === 'fee') { sheetState = { kind: 'fee', id: b.dataset.id, note: '' }; return render(); }
  if (a === 'plan-inquiry') { sheetState = { kind: 'inquiry', month: b.dataset.month, note: '' }; return render(); }
  if (a === 'gr-open') { const win = window.open('', '_blank'); run(async () => { const r = await openFile(() => call('files/link', { id: b.dataset.id }, store.get()), win); if (!r.ok) say(r.error.message, 'error'); }); return; }
  captureSheetInputs();
  run(async () => {
    let r;
    if (a === 'send-change') {
      const s = sheetState; if (!s || s.kind !== 'lesson' || !s.pick) return;
      r = await call('family/lessons/request', { lessonId: s.id, kind: s.pick, note: (s.note || '').trim() }, store.get());
      if (r.ok) { closeSheet(); sched = null; calData = {}; return say({ move: '日時の変更をお願いしました。先生から連絡があります', rest: 'お休みにしました', late: '先生に連絡しました', cancel: 'キャンセルの連絡を受け付けました' + (r.fee ? `（キャンセル料 ${yen(r.fee.amount)}）` : '') }[r.request ? r.request.kind : 'move'], 'ok'); }
    } else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('family/lessons/withdraw', { requestId: b.dataset.id }, store.get()); if (r.ok) { closeSheet(); sched = null; calData = {}; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'hw-done' || a === 'hw-undo') { r = await call('family/homework/report', { id: b.dataset.id, undo: a === 'hw-undo' }, store.get()); if (r.ok) { learning = null; return say(a === 'hw-done' ? 'できたと先生に知らせました' : '取り消しました', 'ok'); } }
    else if (a === 'plan-ack-month') {
      const [, lines] = planGroups(money.plans).acks.find(([m]) => m === b.dataset.month) || [];
      for (const l of (lines || [])) { r = await call('family/plans/ack', { id: l.id, version: l.version, ack: 'confirmed' }, store.get()); if (!r.ok) break; }
      money = null; if (r && r.ok) return say('確認しました。ありがとうございます', 'ok');
    } else if (a === 'send-inquiry') {
      const s = sheetState; const note = (s.note || '').trim(); if (!note) return say('内容を書いてください', 'error');
      const [, lines] = planGroups(money.plans).acks.find(([m]) => m === s.month) || [];
      for (const l of (lines || [])) { r = await call('family/plans/ack', { id: l.id, version: l.version, ack: 'inquiry', note }, store.get()); if (!r.ok) break; }
      money = null; if (r && r.ok) { closeSheet(); return say('先生に伝えました。返事をお待ちください', 'ok'); }
    } else if (a === 'terms-accept') { if (!termsChecked) return say('全文を読んで「同意します」に印を付けてください', 'error'); r = await call('family/terms/accept', { version: b.dataset.version, agree: true }, store.get()); if (r.ok) { money = null; termsChecked = false; return say('受講規約に同意いただきました。ありがとうございます', 'ok'); } }
    else if (a === 'inv-report') { if (!confirm('振り込んだことを先生に知らせますか？')) return; r = await call('family/invoices/report', { id: b.dataset.id, version: Number(b.dataset.version) }, store.get()); if (r.ok) { closeSheet(); money = null; return say('振込のご連絡を受け付けました。ありがとうございます', 'ok'); } }
    else if (a === 'send-relief') { const s = sheetState; const reason = (s.note || '').trim(); if (!reason) return say('事情を書いてください', 'error'); r = await call('family/fees/relief', { id: b.dataset.id, version: Number(b.dataset.version), reason }, store.get()); if (r.ok) { closeSheet(); money = null; return say('申請を受け付けました。先生が確かめて返事をします', 'ok'); } }
    else if (a === 'del-event') { r = await call('family/events/delete', { id: b.dataset.id }, store.get()); if (r.ok) { sched = null; calData = {}; return say('消しました', 'ok'); } }
    else if (a === 'logout') { await call('family/logout', {}, store.get()); store.set(''); me = null; location.hash = ''; return say('ログアウトしました', 'ok'); }
    if (r) failed(r);
  });
});
wireSheets(app);
// 画面の移り変わり: ふわっと入れ替える（対応しているブラウザだけ。「視差効果を減らす」では付けない）
window.addEventListener('hashchange', () => {
  say(''); closeSheet();
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return render();
  document.documentElement.dataset.nav = 'tab';
  document.startViewTransition(() => render()).finished.finally(() => { delete document.documentElement.dataset.nav; });
});
(async function boot() {
  const auth = store.get();
  if (auth) { const r = await call('family/me', {}, auth); if (r.ok) me = r.me; else if (r.error.code === 'needLogin') { store.set(''); if (previewToken) say('プレビューの期限が切れました。管理画面から開き直してください', 'error'); } }
  render();
})();
