// スタッフの「生徒」（docs/UX_STRUCTURE.md 3）。#students（家族ごとの一覧）と #student=<id>/<タブ>（1人の生徒の画面）。
// タブ: 概要・予定・記録と宿題・成績・計画と請求・基本情報。講師は担当の生徒だけで、計画と請求・基本情報は出ない。
import { hwSubject } from '/assets/v2/learning-view.js?v=20261003-ux15';
import { mdw, endOf, statusTag } from '/assets/v2/schedule-view.js?v=20261003-ux15';
import { examCard, gradeCharts } from '/assets/v2/grades-view.js?v=20261003-ux15';

let list = null, query = '', hub = null, hubFor = '';
export function resetStudents() { list = null; hub = null; hubFor = ''; }
const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const TABS = [['summary', '概要'], ['schedule', '予定'], ['records', '記録と宿題'], ['grades', '成績'], ['money', '計画と請求', true], ['basic', '基本情報', true]];
const INV = { confirmed: ['お支払い待ち', 'warn'], reported: ['振込の連絡あり', 'warn'], paid: ['入金済み', 'ok'] };
const PLAN = { draft: ['下書き', 'gray'], proposed: ['承認待ち', 'warn'], approved: ['承認', 'ok'], declined: ['見送り', 'gray'] };

// ---------- 一覧 ----------
export function studentsPage(ctx) {
  const { esc } = ctx;
  if (!list) { list = { loading: true }; ctx.call('students/list').then(r => { list = r.ok ? r : { families: [], error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = `<div class="page-head"><h1>生徒</h1></div>${ctx.notice()}`;
  if (list.loading) return h + '<p class="muted">読み込んでいます…</p>';
  h += `<input type="search" data-input="stu-query" value="${esc(query)}" placeholder="名前・ふりがなで探す" style="margin:4px 0 8px">`;
  const q = query.trim();
  const match = s => !q || s.name.includes(q) || s.kana.includes(q);
  for (const f of list.families) {
    const ss = f.students.filter(match); if (!ss.length) continue;
    if (f.name) h += `<h2>${esc(f.name)}${list.manager ? ` <a class="small" href="#family=${encodeURIComponent(f.id)}" style="font-weight:400">家族の連絡先・招待</a>` : ''}</h2>`;
    h += '<div class="rows">' + ss.map(s => `<a class="todo${s.status === 'left' ? ' left' : ''}" href="#student=${encodeURIComponent(s.id)}"><span class="b"><strong>${esc(s.name)}</strong>
      <small class="muted">${[esc(s.grade || ''), s.status === 'paused' ? '休会' : s.status === 'left' ? '退会' : '', s.testOnly ? 'テスト' : '', s.next ? '次 ' + md(s.next.slice(0, 10)) + ' ' + esc(s.next.slice(11)) : ''].filter(Boolean).join('・')}</small></span>
      <span class="tags">${s.requests ? `<span class="tag warn">連絡 ${s.requests}</span>` : ''}${s.pendingRecords ? `<span class="tag warn">記録待ち ${s.pendingRecords}</span>` : ''}</span><span class="go">›</span></a>`).join('') + '</div>';
  }
  if (list.manager) h += '<p class="small" style="margin-top:14px"><a href="#families">家族を登録する・家族の一覧</a></p>';
  return h;
}
export function studentsInput(ctx, name, el) {
  if (name !== 'stu-query') return false;
  query = el.value; const pos = el.selectionStart; ctx.render();
  const again = document.querySelector('[data-input="stu-query"]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  return true;
}

// ---------- 1人の生徒 ----------
export function studentPage(ctx, id, tab) {
  const { esc } = ctx;
  if (hubFor !== id) { hubFor = id; hub = null; ctx.call('students/hub', { studentId: id }).then(r => { if (hubFor !== id) return; hub = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = '';
  if (!hub) return h + '<p class="muted">読み込んでいます…</p>';
  if (hub.error) return h + `<p class="notice error">${esc(hub.error)}</p>`;
  const s = hub.student, tabs = TABS.filter(t => !t[2] || hub.manager);
  if (!tabs.some(t => t[0] === tab)) tab = 'summary';
  h += `<div class="page-head"><h1>${esc(s.name)}</h1><span class="muted">${esc(s.grade || '')}${s.status === 'paused' ? '・休会' : s.status === 'left' ? '・退会' : ''}</span></div>${ctx.notice()}`;
  h += '<div class="tabs2" role="tablist">' + tabs.map(([k, label]) => `<a role="tab" href="#student=${encodeURIComponent(s.id)}/${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-selected="true"' : ''}>${label}</a>`).join('') + '</div>';
  return h + ({ summary, schedule, records, grades, money, basic }[tab])(ctx, hub);
}

const lessonRow = (esc, l, href = '') => `<div class="lesson-row"><span class="t">${md(l.date)}<small>${l.start}・${l.minutes}分</small></span>
  <${href ? `a href="${href}"` : 'span'} class="b"><span>${esc(l.subject)}${l.kind && l.kind !== '通常' ? '<small>（' + esc(l.kind) + '）</small>' : ''}${l.deliveryMode === 'online' ? ' <small class="muted">オンライン</small>' : ''}</span>
  <span class="tags">${statusTag(l)}<small class="muted">${esc(l.staffName || '担当未定')}</small></span></${href ? 'a' : 'span'}><span class="act"></span></div>`;
const noteText = n => [n.nextFocus ? '次回: ' + n.nextFocus : '', n.understanding ? '理解度 ' + n.understanding : ''].filter(Boolean).join('・');

function summary(ctx, x) {
  const { esc } = ctx, sid = encodeURIComponent(x.student.id);
  let h = '';
  const todo = [];
  if (x.requests.length) todo.push(`<a class="todo" href="#schedule"><span class="b"><strong>連絡 ${x.requests.length}件</strong><small class="muted">${x.requests.map(r => md(r.date) + ' ' + esc(r.subject)).join('・')}</small></span><span class="go">›</span></a>`);
  if (x.pendingRecords.length) todo.push(`<a class="todo" href="#record=${encodeURIComponent(x.pendingRecords[x.pendingRecords.length - 1].id)}"><span class="b"><strong>記録待ち ${x.pendingRecords.length}件</strong><small class="muted">${x.pendingRecords.map(l => md(l.date) + ' ' + esc(l.subject)).join('・')}</small></span><span class="go">›</span></a>`);
  if (x.grades.pendingTests.length) todo.push(`<a class="todo" href="#grades=${sid}"><span class="b"><strong>結果待ちのテスト</strong><small class="muted">${x.grades.pendingTests.map(t => esc(t.title)).join('・')}</small></span><span class="go">›</span></a>`);
  if (todo.length) h += `<h2>対応すること</h2><div class="rows">${todo.join('')}</div>`;
  h += '<h2>次の授業</h2>' + (x.upcoming.length ? '<div class="rows">' + x.upcoming.slice(0, 2).map(l => lessonRow(esc, l)).join('') + '</div>' : '<p class="muted small">決まっている授業はありません。</p>');
  const last = x.records.find(r => r.status === 'published') || x.records[0];
  h += '<h2>前回の記録</h2>' + (last ? `<div class="rows"><a class="todo" href="#record=${encodeURIComponent(last.lessonId)}"><span class="b"><strong>${md(last.date)} ${esc(last.subject)}：${esc(last.range || '（範囲なし）')}</strong><small class="muted">${esc(noteText(last.staffNotes) || last.comment.slice(0, 60))}</small></span><span class="go">›</span></a></div>` : '<p class="muted small">まだ記録はありません。</p>');
  if (x.handover.length) h += '<h2>引き継ぎメモ</h2><div class="rows">' + x.handover.slice(0, 3).map(n => `<div class="ev"><span class="t">${esc(n.createdAt.slice(5, 10).replace('-', '/'))}</span><span class="b" style="white-space:pre-wrap;color:var(--ink)">${esc(n.body)}<small class="muted"> ${esc(n.authorName)}</small></span><span></span></div>`).join('') + '</div>';
  h += '<h2>宿題</h2>' + homeworkList(esc, x.homework.slice(0, 5));
  const nt = x.grades.nextTest;
  h += '<h2>テスト</h2>' + (nt ? `<p>${esc(nt.title || 'テスト')} ${md(nt.date)}・あと <strong>${nt.days}日</strong></p>` : '<p class="muted small">共有されている次のテストはありません。</p>');
  if (x.plans) h += '<h2>今月・来月の計画</h2>' + planList(esc, x.plans);
  return h;
}
function homeworkList(esc, hw) {
  if (!hw.length) return '<p class="muted small">未完了の宿題はありません。</p>';
  return '<div class="rows">' + hw.map(w => `<div class="ev"><span class="t">${esc(hwSubject(w) || '宿題')}</span><span class="b" style="color:var(--ink)">${esc([w.material, w.title].filter(Boolean).join(' '))}
    <small class="muted">${w.due ? md(w.due) + 'まで' : w.dueMode === 'date' ? md(w.dueDate) + 'まで' : w.dueMode === 'nextLesson' ? '次の' + esc(w.dueSubject || '授業') + 'まで' : ''}</small></span><span>${w.status === 'reported' ? '<span class="tag warn">できたと報告</span>' : ''}</span></div>`).join('') + '</div>';
}
function planList(esc, plans) {
  if (!plans.length) return '<p class="muted small">計画はありません。<a href="#plans">計画を作る</a></p>';
  return '<div class="rows">' + plans.map(p => `<div class="ev"><span class="t">${md(p.startDate)}〜</span><span class="b" style="color:var(--ink)">${esc(p.subject)}${p.kind !== '通常' ? '（' + esc(p.kind) + '）' : ''}${p.parentId ? ' <small class="muted">追加</small>' : ''}
    <small class="muted">${p.used} / ${p.cap}回・1回 ${p.minutes}分 ${yen(p.fee)}</small></span><span><span class="tag ${PLAN[p.status][1]}">${PLAN[p.status][0]}</span></span></div>`).join('') + '</div>';
}
function schedule(ctx, x) {
  const { esc } = ctx;
  return `<h2>これからの授業 <span class="count">${x.upcoming.length}</span></h2>` + (x.upcoming.length ? '<div class="rows">' + x.upcoming.map(l => lessonRow(esc, l)).join('') + '</div>' : '<p class="muted small">決まっている授業はありません。</p>')
    + (x.events.length ? '<h2>テスト・行事・授業ができない日</h2><div class="rows">' + x.events.map(e => `<div class="ev ${e.kind}"><span class="t">${md(e.date)}${e.dateTo !== e.date ? '〜' : ''}</span><span class="b">${esc(e.title || (e.kind === 'unavailable' ? '授業ができない日' : ''))}</span><span></span></div>`).join('') + '</div>' : '')
    + '<h2>これまでの授業</h2>' + (x.past.length ? '<div class="rows">' + x.past.map(l => lessonRow(esc, l, ['decided', 'done'].includes(l.status) ? '#record=' + encodeURIComponent(l.id) : '')).join('') + '</div>' : '<p class="muted small">まだありません。</p>')
    + '<p class="small" style="margin-top:12px"><a href="#schedule">月の予定表を開く（仮予定を作る・直す）</a></p>';
}
function records(ctx, x) {
  const { esc } = ctx;
  let h = '';
  if (x.pendingRecords.length) h += `<h2>記録待ち <span class="count">${x.pendingRecords.length}</span></h2><div class="rows">` + x.pendingRecords.map(l => lessonRow(esc, l, '#record=' + encodeURIComponent(l.id))).join('') + '</div>';
  h += '<h2>宿題</h2>' + homeworkList(esc, x.homework);
  h += '<h2>記録</h2>' + (x.records.length ? '<div class="rows">' + x.records.map(r => `<a class="todo" href="#record=${encodeURIComponent(r.lessonId)}"><span class="b"><strong>${md(r.date)} ${esc(r.subject)}：${esc(r.range || '（範囲なし）')}</strong>
    <small class="muted">${r.status === 'draft' ? '下書き・' : ''}${esc(noteText(r.staffNotes) || r.comment.slice(0, 60))}</small></span><span class="go">›</span></a>`).join('') + '</div>' : '<p class="muted small">まだ記録はありません。</p>');
  return h;
}
function grades(ctx, x) {
  const sid = encodeURIComponent(x.student.id), g = x.grades;
  let h = `<p style="margin-top:12px"><a class="small-btn primary" href="#grades=${sid}">結果を入れる・直す</a></p>`;
  if (g.nextTest) h += `<p class="small">次のテスト: ${ctx.esc(g.nextTest.title || '')} ${md(g.nextTest.date)}（あと${g.nextTest.days}日）</p>`;
  if (!g.exams.length) return h + '<p class="muted small">まだ成績の記録はありません。</p>';
  return h + gradeCharts(g.exams) + g.exams.slice().reverse().map(e => examCard(e)).join('');
}
function money(ctx, x) {
  const { esc } = ctx;
  return '<h2>今月・来月の計画</h2>' + planList(esc, x.plans) + '<p class="small"><a href="#plans">計画の画面を開く</a></p>'
    + '<h2>家族の請求（最近6か月）</h2>' + (x.invoices.length ? '<div class="rows">' + x.invoices.map(v => `<div class="ev"><span class="t">${Number(v.month.slice(5))}月分</span><span class="b" style="color:var(--ink)">${yen(v.total)}</span><span><span class="tag ${(INV[v.status] || ['', 'gray'])[1]}">${(INV[v.status] || [v.status])[0]}</span></span></div>`).join('') + '</div>' : '<p class="muted small">まだ請求はありません。</p>')
    + '<p class="small"><a href="#billing">請求の画面を開く</a></p>';
}
function basic(ctx, x) {
  const { esc } = ctx, b = x.basic, s = x.student;
  const row = (k, v) => v ? `<div class="ev"><span class="t" style="font-weight:400">${k}</span><span class="b" style="color:var(--ink)">${esc(v)}</span><span></span></div>` : '';
  return `<h2>生徒</h2><div class="rows">${row('ふりがな', s.kana)}${row('学年', s.grade)}${row('学校', b.school)}${row('受講科目', b.subjects)}${row('入塾日', b.enrolledOn)}${row('授業の形式', s.deliveryMode === 'online' ? 'オンライン' : s.deliveryMode === 'in_person' ? '対面' : '')}${row('基本単価', b.baseRate30 ? yen(b.baseRate30) + '／30分' : '')}${row('メモ', b.note)}</div>
    <h2>家族</h2><div class="rows">${row('家族', b.familyName)}${row('保護者', b.guardianName)}${row('メール', b.email)}${row('電話', b.phone)}${row('保護者ページ', b.familyStatus === 'active' ? '登録済み' : b.familyStatus === 'stopped' ? '停止' : 'まだ')}</div>
    <p style="margin-top:12px"><a class="small-btn" href="#family=${encodeURIComponent(b.familyId)}">直す・招待・プレビュー（家族の画面）</a></p>`;
}
