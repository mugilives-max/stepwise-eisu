// 生徒の画面（作り直し v2）。専用リンク（?k=）で開く。予定と「変更・お休みの連絡」、予定の共有。
// 鍵は端末に保存して URL から消す。保護者が「保護者だけ」にした操作はできない。切り替えまでは準備中。
import { call, esc } from '/assets/v2/api.js';
import { familyLessonList, changeDialog, eventList, eventForm } from '/assets/v2/schedule-view.js?v=20261002-stage3';

const app = document.getElementById('app'), nav = document.getElementById('nav');
const KEY = 'sw2_student_k';
const params = new URLSearchParams(location.search);
if (params.get('k')) { try { localStorage.setItem(KEY, params.get('k')); } catch {} history.replaceState(null, '', location.pathname + location.hash); }
const k = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();
let sched = null, busy = false, notice = null, change = null;
const say = (m, kd = '') => { notice = m ? { m, kd } : null; };
const noticeHtml = () => notice ? `<p class="notice ${notice.kd}" role="${notice.kd === 'error' ? 'alert' : 'status'}">${esc(notice.m)}</p>` : '';
async function run(task) { if (busy) return; busy = true; render(); try { await task(); } finally { busy = false; render(); } }
const prep = '<p class="notice small">準備中の新しい生徒ページです。今は今までの専用リンク（マイページ）をお使いください。</p>';

async function load() { const r = await call('student/schedule', { k }); if (r.ok) sched = r; else { sched = { error: r.error.message }; } render(); }
function render() {
  const page = location.hash.slice(1) || 'home';
  if (!k) { app.innerHTML = '<h1>マイページ</h1><p class="notice error">先生から届いた専用リンクを開いてください。</p>'; return; }
  if (!sched) { load(); app.innerHTML = '<p class="muted">読み込んでいます…</p>'; return; }
  if (sched.error) { app.innerHTML = `<h1>マイページ</h1><p class="notice error">${esc(sched.error)}</p>`; return; }
  nav.innerHTML = [['home', '予定'], ['events', '予定の共有']].map(([key, l]) => `<a href="#${key}" class="${page === key ? 'on' : ''}">${l}</a>`).join('');
  let h = `${prep}<h1>${esc(sched.me.name)}さん</h1>${noticeHtml()}`;
  if (page === 'events') {
    h += `<h2>予定の共有</h2><p class="sub">テスト・行事・授業ができない日を先生に知らせます。</p>${eventList(sched.events, { canDelete: e => sched.permissions.events && e.createdByKind === 'student' })}`;
    h += sched.permissions.events ? `<h2>予定を共有する</h2>${eventForm([sched.me])}` : '<p class="small muted">予定の共有は、保護者の方からお願いします。</p>';
  } else {
    if (change) h += changeDialog(sched.lessons.find(l => l.id === change.id), change.pick, change.note, busy);
    h += familyLessonList(sched, { canRequest: sched.permissions.reschedule });
    if (!sched.permissions.reschedule) h += '<p class="small muted">予定の変更・お休みの連絡は、保護者の方からお願いします。</p>';
  }
  app.innerHTML = h;
}
app.addEventListener('submit', ev => {
  ev.preventDefault();
  const v = Object.fromEntries(new FormData(ev.target).entries());
  run(async () => { const r = await call('student/events/add', { ...v, k }); if (r.ok) { sched = null; say('共有しました', 'ok'); } else say(r.error.message, 'error'); });
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
    if (a === 'send-change') { r = await call('student/lessons/request', { k, lessonId: change.id, kind: change.pick, note: change.note }); if (r.ok) { change = null; sched = null; return say('先生に連絡しました', 'ok'); } }
    else if (a === 'withdraw') { if (!confirm('この連絡を取り下げますか？')) return; r = await call('student/lessons/withdraw', { k, requestId: b.dataset.id }); if (r.ok) { sched = null; return say('連絡を取り下げました', 'ok'); } }
    else if (a === 'del-event') { r = await call('student/events/delete', { k, id: b.dataset.id }); if (r.ok) { sched = null; return say('消しました', 'ok'); } }
    if (r) say(r.error.message, 'error');
  });
});
window.addEventListener('hashchange', () => { say(''); change = null; render(); });
render();
