// 生徒の画面（作り直し v2）。専用リンク（?k=）で開く。入口は ホーム・予定・学習（docs/UX_STRUCTURE.md 5）。
// ホーム（次の授業・宿題・次のテスト）、予定と「変更・お休みの連絡」・テスト・行事を知らせる、記録と宿題・成績（成績票を送る）。
// 鍵は端末に保存して URL から消す。保護者が「保護者だけ」にした操作はできない。切り替えまでは準備中。
import { call, esc } from '/assets/v2/api.js';
import { familyLessonList, changeDialog, eventList, eventForm } from '/assets/v2/schedule-view.js?v=20261003-ux18';
import { learningView, checkTag, hwText, hwSubject } from '/assets/v2/learning-view.js?v=20261003-ux18';
import { gradesView, uploadFile, openFile } from '/assets/v2/grades-view.js?v=20261003-ux18';

const app = document.getElementById('app'), nav = document.getElementById('nav');
const KEY = 'sw2_student_k';
const params = new URLSearchParams(location.search);
// スタッフのプレビュー（?k=pv2.…）は、このタブだけで使う（端末に覚えている生徒の鍵には触れない）。書き込みはサーバーが断る
const PV_KEY = 'sw2_student_preview';
if (params.get('k')) { const v = params.get('k'); try { v.startsWith('pv2.') ? sessionStorage.setItem(PV_KEY, v) : localStorage.setItem(KEY, v); } catch {} history.replaceState(null, '', location.pathname + location.hash); }
const k = (() => { try { return sessionStorage.getItem(PV_KEY) || localStorage.getItem(KEY) || ''; } catch { return ''; } })();
const preview = k.startsWith('pv2.');
let sched = null, busy = false, notice = null, change = null, learning = null, grades = null;
const say = (m, kd = '') => { notice = m ? { m, kd } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.kd}" role="${notice.kd === 'error' ? 'alert' : 'status'}">${esc(notice.m)}</p>` : '';
async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }
const prep = '<p class="notice small">準備中の新しい生徒ページです。今は今までの専用リンク（マイページ）をお使いください。</p>';

async function load() { const r = await call('student/schedule', { k }); if (r.ok) sched = r; else { sched = { error: r.error.message }; } render(); }
// 入口（docs/UX_STRUCTURE.md 5）: ホーム・予定・学習。スマホでは画面の下。前の URL（#events・#grades）も開ける
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  learning: '<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>',
};
const TABS = [['home', 'ホーム'], ['schedule', '予定'], ['learning', '学習']];
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const loadingHtml = '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
function needLearning() { if (!learning) { learning = { loading: true }; call('student/learning', { k }).then(r => { learning = r.ok ? r : { records: [], homework: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); } return learning.loading; }
function needGrades() { if (!grades) { grades = { loading: true }; call('student/grades', { k }).then(r => { grades = r.ok ? r : { exams: [], files: [] }; if (!r.ok) say(r.error.message, 'error'); render(); }); } return grades.loading; }

function render() {
  const raw = location.hash.slice(1) || 'home', [p0, sub0] = raw.split('/');
  const page = p0 === 'events' ? 'schedule' : p0 === 'grades' ? 'learning' : p0, sub = p0 === 'grades' ? 'grades' : sub0;
  if (!k) { app.innerHTML = '<h1>マイページ</h1><p class="notice error">先生から届いた専用リンクを開いてください。</p>'; return; }
  if (!sched) { load(); app.innerHTML = loadingHtml; return; }
  if (sched.error) { app.innerHTML = `<h1>マイページ</h1><p class="notice error">${esc(sched.error)}</p>`; return; }
  nav.innerHTML = TABS.map(([key, l]) => `<a href="#${key}" class="${page === key ? 'on' : ''}"${page === key ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[key]}</svg><span>${l}</span></a>`).join('');
  document.body.classList.add('has-tabs');
  let h = preview ? `<p class="notice" style="background:#fff3c4;color:#5a4300"><strong>プレビュー中</strong>：${esc(sched.me.name)}さんの生徒ページ（表示だけです。押しても変更はされません。1時間で切れます）</p>` : '';
  if (page === 'schedule') {
    h += `<div class="page-head"><h1>予定</h1></div>${noticeHtml()}`;
    if (change) h += changeDialog(sched.lessons.find(l => l.id === change.id), change.pick, change.note, busy);
    h += familyLessonList(sched, { canRequest: sched.permissions.reschedule });
    if (!sched.permissions.reschedule) h += '<p class="small muted">予定の変更・お休みの連絡は、保護者の方からお願いします。</p>';
    h += `<h2>テスト・行事を知らせる</h2>${eventList(sched.events, { canDelete: e => sched.permissions.events && e.createdByKind === 'student' })}`;
    h += sched.permissions.events ? `<details><summary class="small">知らせる</summary>${eventForm([sched.me])}</details>` : '<p class="small muted">テスト・行事を知らせるのは、保護者の方からお願いします。</p>';
  } else if (page === 'learning') {
    const tab = sub === 'grades' ? 'grades' : 'records';
    h += `<div class="page-head"><h1>学習</h1></div><div class="seg"><a href="#learning" class="${tab === 'records' ? 'on' : ''}">記録と宿題</a><a href="#learning/grades" class="${tab === 'grades' ? 'on' : ''}">成績</a></div>${noticeHtml()}`;
    if (tab === 'records') h += needLearning() ? loadingHtml : learningView(learning);
    else h += needGrades() ? loadingHtml : gradesView(grades, { who: 'student', dis: busy ? ' disabled' : '' });
  } else {
    // ホーム: 次の授業・今日やる宿題・次のテスト
    h += `${preview ? '' : prep}<div class="page-head"><h1>${esc(sched.me.name)}さん</h1></div>${noticeHtml()}`;
    const next = sched.lessons.filter(l => l.date >= sched.today && ['proposed', 'decided'].includes(l.status)).slice(0, 3);
    h += '<h2>次の授業</h2>' + (next.length ? '<div class="rows">' + next.map(l => `<a class="todo" href="#schedule"><span class="b"><strong>${md(l.date)} ${l.start}〜 ${esc(l.subject)}</strong><small class="muted">${l.status === 'proposed' ? '仮予定' : '決定'}${l.deliveryMode === 'online' ? '・オンライン' : ''}</small></span><span class="go">›</span></a>`).join('') + '</div>' : '<p class="muted small">決まっている授業はありません。</p>');
    h += '<h2>宿題</h2>';
    if (needLearning()) h += loadingHtml;
    else {
      const hw = learning.homework.filter(w => w.status !== 'confirmed');
      h += hw.length ? '<div class="rows">' + hw.map(w => `<div class="ev"><span class="t">${w.dueMode === 'date' && w.due ? md(w.due) : w.due ? md(w.due) : ''}</span><span class="b" style="color:var(--ink)"><strong>${esc(hwText(w))}</strong>${hwSubject(w) ? '<small class="muted">' + esc(hwSubject(w)) + '</small>' : ''}${checkTag(w) ? '<small>' + checkTag(w) + '</small>' : ''}${w.reviewNote && w.status === 'open' ? `<small class="muted">先生から: ${esc(w.reviewNote)}</small>` : ''}</span>
        <span>${w.status === 'open' ? `<button class="small-btn primary" data-action="hw-done" data-id="${esc(w.id)}">できた</button>` : `<button class="small-btn" data-action="hw-undo" data-id="${esc(w.id)}">取り消す</button>`}</span></div>`).join('') + '</div>' : '<p class="muted small">今やる宿題はありません。</p>';
    }
    const test = sched.events.filter(e => e.kind === 'test' && e.date >= sched.today)[0];
    if (test) { const days = Math.round((Date.parse(test.date) - Date.parse(sched.today)) / 86400e3); h += `<h2>次のテスト</h2><p class="notice">${esc(test.title || 'テスト')}まで あと <strong>${days}日</strong>（${md(test.date)}）</p>`; }
  }
  app.innerHTML = h;
}
app.addEventListener('submit', ev => {
  ev.preventDefault();
  const v = Object.fromEntries(new FormData(ev.target).entries());
  if (ev.target.dataset.form === 'gr-upload') {
    const file = ev.target.querySelector('input[type=file]').files[0]; if (!file) return;
    return run(async () => { const r = await uploadFile(file, v.note || '', meta => call('student/grades/upload', { ...meta, k })); if (r.ok) { grades = null; say('成績票を送りました。先生が確かめて点数を入れます', 'ok'); } else say(r.error.message, 'error'); });
  }
  run(async () => { const r = await call('student/events/add', { ...v, k }); if (r.ok) { sched = null; say('共有しました', 'ok'); } else say(r.error.message, 'error'); });
});
app.addEventListener('click', ev => {
  const b = ev.target.closest('[data-action]'); if (!b) return;
  const a = b.dataset.action;
  if (a === 'change') { change = { id: b.dataset.id, pick: '', note: '' }; return render(); }
  if (a === 'pick') { const n = document.getElementById('change-note'); if (n) change.note = n.value; change.pick = b.dataset.c; return render(); }
  if (a === 'close-change') { change = null; return render(); }
  if (a === 'gr-open') { const win = window.open('', '_blank'); run(async () => { const r = await openFile(() => call('files/link', { k, id: b.dataset.id }), win); if (!r.ok) say(r.error.message, 'error'); }); return; }
  // 書いた内容は、送信中の表示に描き直す前に読んでおく（描き直すと入力欄が作り直される）
  if (a === 'send-change') { const n = document.getElementById('change-note'); if (n) change.note = n.value.trim(); }
  run(async () => {
    let r;
    if (a === 'send-change') { r = await call('student/lessons/request', { k, lessonId: change.id, kind: change.pick, note: change.note }); if (r.ok) { change = null; sched = null; return say('先生に連絡しました', 'ok'); } }
    else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('student/lessons/withdraw', { k, requestId: b.dataset.id }); if (r.ok) { sched = null; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'hw-done' || a === 'hw-undo') { r = await call('student/homework/report', { k, id: b.dataset.id, undo: a === 'hw-undo' }); if (r.ok) { learning = null; return say(a === 'hw-done' ? 'できたと先生に知らせました' : '取り消しました', 'ok'); } }
    else if (a === 'del-event') { r = await call('student/events/delete', { k, id: b.dataset.id }); if (r.ok) { sched = null; return say('消しました', 'ok'); } }
    if (r) say(r.error.message, 'error');
  });
});
window.addEventListener('hashchange', () => { say(''); change = null; render(); });
render();
