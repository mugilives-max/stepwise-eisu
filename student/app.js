// 生徒の画面（作り直し v2）。専用リンク（?k=）で開く。入口は ホーム・予定・学習（docs/UX_STRUCTURE.md 5）。
// ホーム（次の授業・今日やる宿題・次のテスト）、予定（授業を押すと下から出る画面で連絡）、学習（記録と宿題・成績）。
// 一覧は白い枠に 1 件 1 行、宿題は左の丸を押して「できた」（assets/v2/portal-ui.js）。
// 鍵は端末に保存して URL から消す。保護者が「保護者だけ」にした操作はできない。切り替える前は「準備中」の案内を出す（health の cutover.live で決める）。
import { call, esc, liveState } from '/assets/v2/api.js';
import { gradesView, uploadFile, openFile } from '/assets/v2/grades-view.js?v=20261008-launch1';
import { lessonRows, nextLessonHero, lessonSheet, homeworkRows, recordCards, eventRows, eventSheet, wireSheets, keepSheet, picon, md, daysText } from '/assets/v2/portal-ui.js?v=20261008-launch1';

const app = document.getElementById('app'), nav = document.getElementById('nav');
const KEY = 'sw2_student_k';
const params = new URLSearchParams(location.search);
// スタッフのプレビュー（?k=pv2.…）は、このタブだけで使う（端末に覚えている生徒の鍵には触れない）。書き込みはサーバーが断る
const PV_KEY = 'sw2_student_preview';
if (params.get('k')) { const v = params.get('k'); try { v.startsWith('pv2.') ? sessionStorage.setItem(PV_KEY, v) : localStorage.setItem(KEY, v); } catch {} history.replaceState(null, '', location.pathname + location.hash); }
const k = (() => { try { return sessionStorage.getItem(PV_KEY) || localStorage.getItem(KEY) || ''; } catch { return ''; } })();
const preview = k.startsWith('pv2.');
let sched = null, busy = false, notice = null, learning = null, grades = null;
let sheetState = null; // { kind: 'lesson', id, pick, note } | { kind: 'event' }
const say = (m, kd = '') => { notice = m ? { m, kd } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.kd}" role="${notice.kd === 'error' ? 'alert' : 'status'}">${esc(notice.m)}</p>` : '';
async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }
// 切り替える前だけ出す案内（health の cutover.live で決める）
const prepText = '<p class="notice small">準備中の新しい生徒ページです。今は今までの専用リンク（マイページ）をお使いください。</p>';
const prep = () => { const s = liveState(render); return s.known && !s.live ? prepText : ''; };

async function load() { const r = await call('student/schedule', { k }); if (r.ok) sched = r; else { sched = { error: r.error.message }; } render(); }
// 入口（docs/UX_STRUCTURE.md 5）: ホーム・予定・学習。スマホでは画面の下。前の URL（#events・#grades）も開ける
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  learning: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>',
};
const TABS = [['home', 'ホーム'], ['schedule', '予定'], ['learning', '学習']];
const TITLE = { home: '', schedule: '予定', learning: '学習' };
const loadingHtml = '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
const secTitle = (t, extra = '') => `<div class="sec-title">${t}${extra}</div>`;
function needLearning() { if (!learning) { learning = { loading: true }; call('student/learning', { k }).then(r => { learning = r.ok ? r : { records: [], homework: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); } return learning.loading; }
function needGrades() { if (!grades) { grades = { loading: true }; call('student/grades', { k }).then(r => { grades = r.ok ? r : { exams: [], files: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); } return grades.loading; }
const upcoming = () => sched.lessons.filter(l => l.date >= sched.today && ['proposed', 'decided'].includes(l.status));

function sheetHtml() {
  const s = sheetState; if (!s || !sched || sched.error) return '';
  if (s.kind === 'lesson') { const l = sched.lessons.find(x => x.id === s.id); return l ? lessonSheet(l, s, { canRequest: sched.permissions.reschedule, busy, sendLabel: '先生に連絡する' }) : ''; }
  if (s.kind === 'event') return eventSheet([sched.me]);
  return '';
}
function renderBar(page) {
  const bar = document.querySelector('.top .in'); if (!bar) return;
  bar.querySelectorAll('.bar-title').forEach(x => x.remove());
  const title = sched && !sched.error ? (page === 'home' ? sched.me.name + 'さん' : TITLE[page] || '') : '';
  if (title) bar.firstElementChild.insertAdjacentHTML('afterend', `<div class="bar-title"><strong>${esc(title)}</strong></div>`);
  document.body.classList.toggle('has-bar', !!title);
}
function render() {
  const raw = location.hash.slice(1) || 'home', [p0, sub0] = raw.split('/');
  const page = p0 === 'events' ? 'schedule' : p0 === 'grades' ? 'learning' : p0, sub = p0 === 'grades' ? 'grades' : sub0;
  if (!k) { app.innerHTML = '<h1>マイページ</h1><p class="notice error">先生から届いた専用リンクを開いてください。</p>'; return; }
  if (!sched) { load(); app.innerHTML = loadingHtml; return; }
  if (sched.error) { app.innerHTML = `<h1>マイページ</h1><p class="notice error">${esc(sched.error)}</p>`; return; }
  nav.innerHTML = TABS.map(([key, l]) => `<a href="#${key}" class="${page === key ? 'on' : ''}"${page === key ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[key]}</svg><span>${l}</span></a>`).join('');
  document.body.classList.add('has-tabs');
  renderBar(page);
  let h = preview ? `<p class="notice" style="background:#fff3c4;color:#5a4300"><strong>プレビュー中</strong>：${esc(sched.me.name)}さんの生徒ページ（表示だけです。押しても変更はされません。1時間で切れます）</p>` : '';
  if (page === 'schedule') {
    h += noticeHtml();
    const kari = sched.lessons.filter(l => l.status === 'proposed' && l.confirmBy);
    if (kari.length) h += `<p class="notice small">仮予定が${kari.length}件あります。${sched.permissions.reschedule ? '都合の悪い授業だけ押して連絡してください。' : '都合が悪いときは保護者の方から連絡してもらってください。'}締め切りまでに連絡がなければ、この日時で決まります。</p>`;
    h += lessonRows(sched.lessons.filter(l => l.date >= sched.today || l.status === 'proposed'), { today: sched.today });
    h += secTitle('テスト・行事', sched.permissions.events ? `<button type="button" class="add" data-action="add-event" aria-label="テスト・行事を知らせる">${picon('plus')}</button>` : '');
    h += eventRows(sched.events.filter(e => e.dateTo >= sched.today), { canDelete: e => sched.permissions.events && e.createdByKind === 'student', today: sched.today });
    if (!sched.permissions.events) h += '<p class="small muted">テスト・行事を知らせるのは、保護者の方からお願いします。</p>';
  } else if (page === 'learning') {
    const tab = sub === 'grades' ? 'grades' : 'records';
    h += `<div class="seg" style="margin-top:10px"><a href="#learning" class="${tab === 'records' ? 'on' : ''}">記録と宿題</a><a href="#learning/grades" class="${tab === 'grades' ? 'on' : ''}">成績</a></div>${noticeHtml()}`;
    if (tab === 'records') {
      if (needLearning()) h += loadingHtml;
      else { const hw = learning.homework.filter(w => w.status !== 'confirmed'); h += secTitle(`宿題${hw.length ? ` <span class="count">${hw.length}</span>` : ''}`) + homeworkRows(hw) + secTitle('授業の記録') + recordCards(learning.records, learning.homework); }
    } else h += needGrades() ? loadingHtml : gradesView(grades, { who: 'student', dis: busy ? ' disabled' : '' });
  } else {
    // ホーム: 次の授業（大きく）・宿題（左の丸を押して「できた」）・次のテスト
    h += `${preview ? '' : prep()}${noticeHtml()}`;
    const next = upcoming();
    h += nextLessonHero(next[0], { today: sched.today });
    h += secTitle('宿題');
    if (needLearning()) h += loadingHtml;
    else h += homeworkRows(learning.homework.filter(w => w.status !== 'confirmed'));
    const test = sched.events.filter(e => e.kind === 'test' && e.dateTo >= sched.today)[0];
    if (test) h += secTitle('次のテスト') + `<div class="group"><div class="evrow"><span class="t">${md(test.date)}</span><span class="b"><span class="nm">${esc(test.title || 'テスト')}</span><small>${esc(daysText(test.date, sched.today) || '今日')}</small></span><span></span></div></div>`;
    const more = next.slice(1, 4);
    if (more.length) h += secTitle('そのあとの授業', '<a class="more" href="#schedule">すべて見る ›</a>') + lessonRows(more, { today: sched.today });
  }
  keepSheet(app, () => { app.innerHTML = h + sheetHtml(); });
  const box = app.querySelector('.bsheet');
  if (box && notice && notice.kd === 'error') box.querySelector('.bsheet-body').insertAdjacentHTML('afterbegin', noticeHtml());
}
const closeSheet = () => { sheetState = null; };
function captureSheetInputs() { const s = sheetState; if (s && s.kind === 'lesson') { const el = document.getElementById('change-note'); if (el) s.note = el.value; } }
app.addEventListener('submit', ev => {
  ev.preventDefault();
  const v = Object.fromEntries(new FormData(ev.target).entries());
  if (ev.target.dataset.form === 'gr-upload') {
    const file = ev.target.querySelector('input[type=file]').files[0]; if (!file) return;
    return run(async () => { const r = await uploadFile(file, v.note || '', meta => call('student/grades/upload', { ...meta, k })); if (r.ok) { grades = null; say('成績票を送りました。先生が確かめて点数を入れます', 'ok'); } else say(r.error.message, 'error'); });
  }
  run(async () => { const r = await call('student/events/add', { ...v, k }); if (r.ok) { sched = null; closeSheet(); say('先生に知らせました', 'ok'); } else say(r.error.message, 'error'); });
});
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'lesson') { sheetState = { kind: 'lesson', id: b.dataset.id, pick: '', note: '' }; return render(); }
  if (a === 'pick') { captureSheetInputs(); sheetState.pick = b.dataset.c; return render(); }
  if (a === 'close-sheet') { closeSheet(); return render(); }
  if (a === 'add-event') { sheetState = { kind: 'event' }; return render(); }
  if (a === 'gr-open') { const win = window.open('', '_blank'); run(async () => { const r = await openFile(() => call('files/link', { k, id: b.dataset.id }), win); if (!r.ok) say(r.error.message, 'error'); }); return; }
  captureSheetInputs();
  run(async () => {
    let r;
    if (a === 'send-change') { const s = sheetState; if (!s || s.kind !== 'lesson' || !s.pick) return; r = await call('student/lessons/request', { k, lessonId: s.id, kind: s.pick, note: (s.note || '').trim() }); if (r.ok) { closeSheet(); sched = null; return say('先生に連絡しました' + (r.fee ? `（キャンセル料 ${Number(r.fee.amount).toLocaleString('ja-JP')}円）` : ''), 'ok'); } }
    else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('student/lessons/withdraw', { k, requestId: b.dataset.id }); if (r.ok) { closeSheet(); sched = null; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'hw-done' || a === 'hw-undo') { r = await call('student/homework/report', { k, id: b.dataset.id, undo: a === 'hw-undo' }); if (r.ok) { learning = null; return say(a === 'hw-done' ? 'できたと先生に知らせました' : '取り消しました', 'ok'); } }
    else if (a === 'del-event') { r = await call('student/events/delete', { k, id: b.dataset.id }); if (r.ok) { sched = null; return say('消しました', 'ok'); } }
    if (r) say(r.error.message, 'error');
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
render();
