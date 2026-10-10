// スタッフの画面: 成績（6段目）。#grades（一覧・届いた成績票・結果の入力待ち）と #grades=<生徒>（試験の記録・入力）。
// 講師は担当の生徒の担当科目だけ入力でき、ほかの科目は合計だけ見える。成績票は教室管理者だけ。
import { examCard, gradeCharts, summaryTable, examPager, gradeSel, fileList, uploadForm, uploadFile, openFile, jst } from '/assets/v2/grades-view.js?v=20261008-launch1';
import { sheet, rowButton, rowLink } from '/staff/ui.js?v=20261008-launch1';

let overview = null, student = null, studentFor = '', editing = '', prefill = null, pick = null; // pick: 下から出る画面 { kind: 'file'|'test'|'resolve', id }
export function leaveGrades() { pick = null; if (!prefill) editing = ''; }
export function resetGrades() { pick = null; overview = null; student = null; studentFor = ''; editing = ''; prefill = null; }
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function gradesOverviewPage(ctx) {
  const { esc } = ctx;
  if (!overview) { overview = { loading: true }; ctx.call('grades/overview').then(r => { overview = r.ok ? r : { students: [], pendingTests: [], files: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); }
  let h = ctx.notice();
  if (overview.loading) return h + '<p class="muted">読み込んでいます…</p>';
  const by = k => k === 'family' ? '保護者' : k === 'student' ? '生徒' : 'スタッフ';
  if (ctx.isManager) h += `<div class="sec-title">届いた成績票${overview.files.length ? ` <span class="count">${overview.files.length}</span>` : ''}</div>` + (overview.files.length ? '<div class="group">' + overview.files.map(f => rowButton(esc, 'gr-pick', { kind: 'file', id: f.id }, `${esc(f.studentName)} ${esc(f.name)}`, `${esc(jst(f.createdAt).slice(5))}・${by(f.uploadedByKind)}${f.note ? '・' + esc(f.note) : ''}`)).join('') + '</div>' : '<p class="small muted">取り込み待ちの成績票はありません。</p>');
  h += `<div class="sec-title">結果の入力待ちのテスト${overview.pendingTests.length ? ` <span class="count">${overview.pendingTests.length}</span>` : ''}</div>` + pendingList(ctx, overview.pendingTests, true);
  h += '<div class="sec-title">生徒</div><div class="group">' + overview.students.map(s => rowLink('#grades=' + encodeURIComponent(s.id), `${esc(s.name)} <span class="small muted" style="font-weight:400">${esc(s.grade || '')}</span>`, `${s.subjects ? '担当 ' + s.subjects.map(esc).join('・') + '・' : ''}${s.latest ? `記録 ${s.latest.count}件・最新 ${esc(md(s.latest.date))}` : 'まだ記録がありません'}`)).join('') + '</div>';
  if (pick && pick.kind === 'file') {
    const f = overview.files.find(x => x.id === pick.id);
    if (f) h += sheet(esc, f.studentName + ' の成績票', `<p style="margin-top:0"><strong>${esc(f.name)}</strong><br><span class="small muted">${esc(jst(f.createdAt).slice(5))}・${by(f.uploadedByKind)}から${f.note ? '・' + esc(f.note) : ''}</span></p>
      <div class="row"><button data-action="gr-open" data-id="${esc(f.id)}">成績票を開く</button><a class="btn" href="#grades=${encodeURIComponent(f.studentId)}">点数を入れる・取り込む</a></div>`, 'gr-unpick');
  }
  h += testSheet(ctx, overview.pendingTests);
  return h;
}
// 結果の入力待ちのテスト（一覧と、押すと下から出る画面）
function pendingList(ctx, tests, withName) {
  const { esc } = ctx;
  if (!tests.length) return '<p class="small muted">ありません。</p>';
  return '<div class="group">' + tests.map(t => rowButton(esc, 'gr-pick', { kind: 'test', id: t.eventId }, `${withName ? esc(t.studentName) + ' ' : ''}${esc(t.title || 'テスト')}`, `${esc(md(t.date))}${t.dateTo !== t.date ? '〜' + esc(md(t.dateTo)) : ''}`)).join('') + '</div>';
}
function testSheet(ctx, tests) {
  const { esc } = ctx, t = pick && pick.kind === 'test' && tests.find(x => x.eventId === pick.id);
  if (!t) return '';
  return sheet(esc, (t.studentName ? t.studentName + ' ' : '') + (t.title || 'テスト'), `<p class="small muted" style="margin-top:0">${esc(md(t.date))}${t.dateTo !== t.date ? '〜' + esc(md(t.dateTo)) : ''}。受けなかった・記録しないときは「結果なし」にします。</p>
    <div class="row"><button class="primary" data-action="gr-from-test" data-student="${esc(t.studentId)}" data-event="${esc(t.eventId)}" data-title="${esc(t.title)}" data-date="${esc(t.dateTo)}">結果を入れる</button><button data-action="gr-skip" data-event="${esc(t.eventId)}"${ctx.dis()}>結果なし</button></div>`, 'gr-unpick');
}

export const gradesBar = () => student && student.student ? { title: student.student.name, sub: `成績${student.student.grade ? '・' + student.student.grade : ''}`, right: '' } : { title: '成績', sub: '', right: '' };
export function gradesStudentPage(ctx, studentId) {
  const { esc } = ctx;
  if (studentFor !== studentId) {
    studentFor = studentId; student = null; editing = prefill ? 'new' : '';
    ctx.call('grades/student', { studentId }).then(r => { if (studentFor !== studentId) return; student = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); });
  }
  let h = '';
  if (!student) return h + '<p class="muted">読み込んでいます…</p>';
  if (student.error) return h + `<p class="notice error">${esc(student.error)}</p>`;
  const st = student;
  h += `${st.subjects ? `<p class="small muted" style="margin-top:12px">あなたの担当: ${st.subjects.map(esc).join('・')}（ほかの科目は合計だけ）</p>` : ''}${ctx.notice()}`;
  if (st.nextTest) h += `<p class="small">次のテスト: ${esc(st.nextTest.title || '')}（${esc(md(st.nextTest.date))}、あと${st.nextTest.days}日）</p>`;
  if (st.pendingTests.length) h += `<h2>結果の入力待ち</h2>${pendingList(ctx, st.pendingTests, false)}`;
  h += `<p><button class="primary" data-action="gr-new"${ctx.dis()}>＋ 試験の結果を入れる</button></p>`;
  h += summaryTable(st.exams) + gradeCharts(st.exams, studentId);
  // 試験は 1 つずつ（‹ ›）。その試験にひもづいた成績票（PDF・写真）はカードの中から開く
  h += examPager(st.exams, studentId, e => examCard(e, { sheets: st.manager ? st.files.filter(f => f.examId === e.id && f.status !== 'dismissed') : [], actions: `<div class="row"><button data-action="gr-edit" data-id="${esc(e.id)}"${ctx.dis()}>直す</button>${st.manager ? `<button class="danger" data-action="gr-delete" data-id="${esc(e.id)}" data-version="${e.version}"${ctx.dis()}>消す</button>` : ''}</div>` }));
  if (!st.exams.length) h += '<p class="muted">まだ記録がありません。成績票（PDF・写真）があれば、下の「この成績票の結果を入れる」から点数と偏差値を入れます。</p>';
  if (st.manager) {
    // 試験にひもづいていない成績票: ここから結果を入れる（入れると自動でひもづく）か、できている試験にひもづける
    const loose = st.files.filter(f => !f.examId && f.status !== 'dismissed'), dismissed = st.files.filter(f => f.status === 'dismissed');
    if (loose.length) h += `<div class="sec-title">試験にひもづいていない成績票 <span class="count">${loose.length}</span></div><div class="group">` + loose.map(f => rowButton(esc, 'gr-pick', { kind: 'resolve', id: f.id }, esc(f.name), `${esc(jst(f.createdAt).slice(5, 10))}${f.note ? '・' + esc(f.note) : ''}${f.status === 'new' ? '・<span class="tag warn">確かめ待ち</span>' : ''}`)).join('') + '</div>';
    const f = pick && pick.kind === 'resolve' && loose.find(x => x.id === pick.id);
    if (f) h += sheet(esc, f.name, `<div class="stack"><button data-action="gr-open" data-id="${esc(f.id)}">成績票を開く</button>
      <button class="primary" data-action="gr-from-file" data-id="${esc(f.id)}" data-name="${esc(f.name)}"${ctx.dis()}>この成績票の結果を入れる</button>
      ${st.exams.length ? `<label>できている試験にひもづける<select data-resolve-exam="${esc(f.id)}"><option value="">（選ぶ）</option>${st.exams.slice().reverse().map(e => `<option value="${esc(e.id)}">${esc(e.name)}（${esc(md(e.date))}）</option>`).join('')}</select></label>
      <div class="row"><button data-action="gr-resolve" data-id="${esc(f.id)}" data-status="imported"${ctx.dis()}>ひもづける</button><button data-action="gr-resolve" data-id="${esc(f.id)}" data-status="dismissed"${ctx.dis()}>取り込まない</button></div>` : `<div class="row"><button data-action="gr-resolve" data-id="${esc(f.id)}" data-status="dismissed"${ctx.dis()}>取り込まない</button></div>`}</div>`, 'gr-unpick');
    if (dismissed.length) h += `<details class="small muted" style="margin:8px 0"><summary>取り込まない成績票 ${dismissed.length}件</summary>${fileList(dismissed, 'gr-open')}</details>`;
    h += `<h3>成績票を残す</h3>${uploadForm(ctx.dis())}`;
  }
  h += testSheet(ctx, st.pendingTests);
  if (editing) { const e = editing === 'new' ? null : st.exams.find(x => x.id === editing); if (e || editing === 'new') h += sheet(esc, e ? e.name + ' を直す' : '試験の結果を入れる', examForm(ctx, e), 'gr-close', { wide: true }); }
  return h;
}
// 試験の入力欄（作る・直す）。科目の行・全体（教室管理者）・振り返り
function examForm(ctx, e) {
  const { esc } = ctx, st = student, manager = st.manager, p = e ? null : prefill;
  const v = (x, k) => x && x[k] !== null && x[k] !== undefined ? esc(String(x[k])) : '';
  let subjects;
  const kind0 = e ? e.kind : (p && p.kind) || 'regular', middle = /中/.test(st.student.grade || '');
  if (!manager) subjects = st.subjects.map(s => (e && e.scores.find(x => x.subject === s)) || { subject: s });
  else { subjects = e ? e.scores.slice() : (kind0 === 'mock' && middle ? ['国語', '数学', '社会', '理科', '英語', '3教科'] : st.lessonSubjects).map(s => ({ subject: s })); const want = e ? e.scores.length + 2 : Math.max(5, subjects.length + 1); while (subjects.length < want) subjects.push({ subject: '' }); }
  const t = e ? e.total : {};
  const r = e && e.review || {};
  const field = (name, label, val, attrs = '') => `<label>${label}<input name="${name}" value="${val}" ${attrs}></label>`;
  const numAttrs = 'inputmode="decimal" style="width:5.5em"';
  const COL = { score: '点数', max: '満点', average: '平均点', rank: '順位', rankOf: '人数', deviation: '偏差値' }, colClass = k => k === 'rank' || k === 'rankOf' ? ' class="c-rank"' : k === 'deviation' ? ' class="c-dev"' : '';
  return `<form class="stack" data-form="gr-save"${e ? ` data-id="${esc(e.id)}" data-version="${e.version}" data-review-version="${r.version || ''}"` : ''}>
    ${p && p.eventId ? `<input type="hidden" name="eventId" value="${esc(p.eventId)}">` : ''}${p && p.fileId ? `<input type="hidden" name="fileId" value="${esc(p.fileId)}">` : ''}
    <div class="row"><label>種類<select name="kind"><option value="regular"${kind0 === 'regular' ? ' selected' : ''}>定期テスト</option><option value="mock"${kind0 === 'mock' ? ' selected' : ''}>模試</option></select></label>
    <label style="flex:1">名前<input name="name" maxlength="40" required value="${esc(e ? e.name : p ? p.title : '')}" placeholder="例: 2学期中間テスト"></label>
    <label>実施日<input type="date" name="date" required max="${today()}" value="${esc(e ? e.date : p ? p.date : '')}"></label><label>学年<input name="grade" maxlength="20" style="width:5em" value="${esc(e ? e.grade : st.student.grade || '')}"></label></div>
    <div class="small muted">科目ごと。分かる項目だけでよい（点数と偏差値だけ、など）。空の行は飛ばします</div>
    <div style="overflow-x:auto"><table class="small gform"><tr><th>科目</th>${['score', 'max', 'average', 'rank', 'rankOf', 'deviation'].map(k => `<th${colClass(k)}>${COL[k]}</th>`).join('')}</tr>
    ${subjects.map((s, i) => `<tr><td><input name="s.${i}.subject" maxlength="20" value="${esc(s.subject)}" style="width:6em"${manager ? '' : ' readonly'}><input type="hidden" name="s.${i}.orig" value="${esc(s.score !== undefined || s.max !== undefined ? s.subject : '')}"></td>
      ${['score', 'max', 'average', 'rank', 'rankOf', 'deviation'].map(k => `<td${colClass(k)}><input name="s.${i}.${k}" value="${v(s, k)}" ${numAttrs}${k === 'max' && !e && s.subject ? ` placeholder="${s.subject === '3教科' ? 300 : 100}"` : ''}></td>`).join('')}</tr>`).join('')}</table></div>
    ${manager ? `<div class="small muted">全体（${kind0 === 'mock' && middle ? '5 教科。' : ''}空なら科目の合計を出します）</div><div class="row">${field('totalScore', '合計', v(e && t.fromSubjects ? null : t, 'score'), numAttrs)}${field('totalMax', '満点', v(e && t.fromSubjects ? null : t, 'max'), numAttrs)}${field('totalRank', '順位', v(t, 'rank'), numAttrs)}${field('totalRankOf', '人数', v(t, 'rankOf'), numAttrs)}<span class="c-dev">${field('totalDeviation', '偏差値', v(t, 'deviation'), numAttrs)}</span></div>` : ''}
    <div class="small muted">振り返り</div>${manager ? `<label>良かった点<textarea name="good" maxlength="1000" rows="2">${esc(r.good || '')}</textarea></label>` : ''}
    <label>課題<textarea name="issues" maxlength="1000" rows="2">${esc(r.issues || '')}</textarea></label><label>次の対策<textarea name="nextSteps" maxlength="1000" rows="2" placeholder="生徒にも見えます">${esc(r.nextSteps || '')}</textarea></label>
    <div class="row"><button class="primary"${ctx.dis()}>保存</button><button type="button" data-action="gr-close"${ctx.dis()}>やめる</button></div></form>`;
}

// ---------- 操作 ----------
export async function gradesSubmit(ctx, kind, el) {
  if (kind === 'gr-upload') {
    const file = el.querySelector('input[type=file]').files[0], note = new FormData(el).get('note') || ''; if (!file) return true;
    const r = await uploadFile(file, note, meta => ctx.call('grades/files/upload', { ...meta, studentId: studentFor }));
    if (r.ok) { student = null; studentFor = ''; ctx.say('成績票を残しました', 'ok'); } else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
    return true;
  }
  if (kind !== 'gr-save') return false;
  const v = Object.fromEntries(new FormData(el).entries()), id = el.dataset.id, fileId = v.fileId || '';
  const exam = { id, version: id ? Number(el.dataset.version) : undefined, studentId: studentFor, kind: v.kind, name: v.name, date: v.date, grade: v.grade, eventId: v.eventId };
  if (student.manager) {
    Object.assign(exam, { totalScore: v.totalScore, totalMax: v.totalMax, totalRank: v.totalRank, totalRankOf: v.totalRankOf, totalDeviation: v.totalDeviation });
  }
  let r = await ctx.call('grades/exams/save', exam);
  if (r.ok) {
    const examId = r.examId, scores = [];
    for (const k of Object.keys(v).filter(k => /^s\.\d+\.subject$/.test(k))) {
      const i = k.split('.')[1], subject = v[k].trim(), orig = v[`s.${i}.orig`] || '';
      const vals = ['score', 'max', 'average', 'rank', 'rankOf', 'deviation'].map(f => v[`s.${i}.${f}`]);
      if (!subject) { if (orig) scores.push({ subject: orig, remove: true }); continue; }
      if (vals.every(x => !x) && !orig) continue; // 何も入れていない行は飛ばす
      if (vals.every(x => !x)) { scores.push({ subject, remove: true }); continue; }
      if (orig && orig !== subject) scores.push({ subject: orig, remove: true });
      const [score, max, average, rank, rankOf, deviation] = vals;
      scores.push({ subject, score, max: max || (score && !id ? (subject === '3教科' ? 300 : 100) : max), average, rank, rankOf, deviation });
    }
    if (scores.length) r = await ctx.call('grades/scores/save', { examId, scores });
    if (r.ok && fileId) r = await ctx.call('grades/files/resolve', { id: fileId, status: 'imported', examId });
    if (r.ok && (v.good || v.issues || v.nextSteps || el.dataset.reviewVersion)) r = await ctx.call('grades/reviews/save', { examId, version: el.dataset.reviewVersion ? Number(el.dataset.reviewVersion) : undefined, good: v.good, issues: v.issues, nextSteps: v.nextSteps });
  }
  if (r.ok) { if (!id) gradeSel(studentFor).exam = ''; editing = ''; prefill = null; student = null; studentFor = ''; overview = null; ctx.say('保存しました', 'ok'); }
  else if (!ctx.handleAuth(r)) ctx.say(r.error.message + (id ? '' : '（試験はできている場合があります。画面を更新して確かめてください）'), 'error');
  return true;
}
export async function gradesClick(ctx, a, b) {
  let r, msg;
  if (a === 'gr-pick') { pick = { kind: b.dataset.kind, id: b.dataset.id }; ctx.say(''); return true; }
  if (a === 'gr-unpick') { pick = null; return true; }
  if (a === 'gr-new') { editing = 'new'; prefill = null; return true; }
  if (a === 'gr-edit') { editing = b.dataset.id; return true; }
  if (a === 'gr-close') { editing = ''; prefill = null; return true; }
  if (a === 'gr-from-test') { pick = null; prefill = { eventId: b.dataset.event, title: b.dataset.title, date: b.dataset.date }; editing = 'new'; studentFor = ''; location.hash = '#grades=' + encodeURIComponent(b.dataset.student); return true; }
  if (a === 'gr-from-file') { // 成績票の名前から、種類と試験の名前の当たりを付ける（例: 北辰_3年4回_山本実祈.pdf → 模試「北辰 3年4回」）
    const name = String(b.dataset.name || ''), who = (student && student.student && student.student.name || '').replace(/\s+/g, '');
    const title = name.replace(/\.[a-z0-9]+$/i, '').replace(who, '').replace(who.slice(0, 2), '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    pick = null; prefill = { fileId: b.dataset.id, title, kind: /北辰|模試|もぎ|駿台|全統|会場/.test(name) ? 'mock' : 'regular' }; editing = 'new'; return true;
  }
  if (a === 'gr-open') return false; // app.js で開く（新しいタブを先に開くため）
  if (a === 'gr-skip') {
    if (!confirm('このテストを「結果なし」にしますか？（受けなかった・記録しないとき）')) return true;
    r = await ctx.call('grades/tests/skip', { eventId: b.dataset.event }); msg = '結果なしにしました'; if (r.ok) { pick = null; overview = null; student = null; studentFor = ''; }
  } else if (a === 'gr-delete') {
    if (!confirm('この試験の記録を消しますか？ 点数と振り返りも消えます。')) return true;
    r = await ctx.call('grades/exams/delete', { id: b.dataset.id, version: Number(b.dataset.version) }); msg = '消しました'; if (r.ok) { student = null; studentFor = ''; }
  } else if (a === 'gr-resolve') {
    // 選んだ試験は app.js で描き直す前に読んである
    r = await ctx.call('grades/files/resolve', { id: b.dataset.id, status: b.dataset.status, examId: b.dataset.exam || '' });
    msg = b.dataset.status === 'imported' ? '取り込み済みにしました' : '取り込まないことにしました'; if (r.ok) { pick = null; student = null; studentFor = ''; overview = null; }
  } else return false;
  if (r.ok) ctx.say(msg, 'ok'); else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
// 成績票を開く（app.js のクリックで、新しいタブを先に開いてから呼ぶ）
export function openGradeFile(ctx, b, win) {
  return openFile(() => ctx.call('files/link', { id: b.dataset.id }), win);
}
