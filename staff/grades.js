// スタッフの画面: 成績（6段目）。#grades（一覧・届いた成績票・結果の入力待ち）と #grades=<生徒>（試験の記録・入力）。
// 講師は担当の生徒の担当科目だけ入力でき、ほかの科目は合計だけ見える。成績票は教室管理者だけ。
import { examCard, gradeCharts, fileList, uploadForm, uploadFile, openFile, jst } from '/assets/v2/grades-view.js?v=20261003-ux24';
import { sheet, rowButton, rowLink } from '/staff/ui.js?v=20261003-ux24';

let overview = null, student = null, studentFor = '', editing = '', prefill = null, pick = null; // pick: 下から出る画面 { kind: 'file'|'test'|'resolve', id }
export function leaveGrades() { pick = null; if (!prefill) editing = ''; }
export function resetGrades() { pick = null; overview = null; student = null; studentFor = ''; editing = ''; prefill = null; }
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function gradesOverviewPage(ctx) {
  const { esc } = ctx;
  if (!overview) { overview = { loading: true }; ctx.call('grades/overview').then(r => { overview = r.ok ? r : { students: [], pendingTests: [], files: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); }
  let h = `<div class="page-head"><h1>成績</h1></div><p class="sub" style="margin-top:0">定期テストと模試の記録。生徒・保護者から届いた成績票を確かめて、点数を入れます。</p>${ctx.notice()}`;
  if (overview.loading) return h + '<p class="muted">読み込んでいます…</p>';
  const by = k => k === 'family' ? '保護者' : k === 'student' ? '生徒' : 'スタッフ';
  if (ctx.isManager) h += `<h2>届いた成績票${overview.files.length ? ` <span class="count">${overview.files.length}</span>` : ''}</h2>` + (overview.files.length ? '<div class="rows">' + overview.files.map(f => rowButton(esc, 'gr-pick', { kind: 'file', id: f.id }, `${esc(f.studentName)} ${esc(f.name)}`, `${esc(jst(f.createdAt).slice(5))}・${by(f.uploadedByKind)}${f.note ? '・' + esc(f.note) : ''}`)).join('') + '</div>' : '<p class="small muted">取り込み待ちの成績票はありません。</p>');
  h += `<h2>結果の入力待ちのテスト${overview.pendingTests.length ? ` <span class="count">${overview.pendingTests.length}</span>` : ''}</h2>` + pendingList(ctx, overview.pendingTests, true) + '<p class="small muted">生徒・保護者が知らせたテストのうち、終わったのに結果がまだないもの。</p>';
  h += '<h2>生徒</h2><div class="rows">' + overview.students.map(s => rowLink('#grades=' + encodeURIComponent(s.id), `${esc(s.name)} <span class="small muted" style="font-weight:400">${esc(s.grade || '')}</span>`, `${s.subjects ? '担当 ' + s.subjects.map(esc).join('・') + '・' : ''}${s.latest ? `記録 ${s.latest.count}件・最新 ${esc(md(s.latest.date))}` : 'まだ記録がありません'}`)).join('') + '</div>';
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
  return '<div class="rows">' + tests.map(t => rowButton(esc, 'gr-pick', { kind: 'test', id: t.eventId }, `${withName ? esc(t.studentName) + ' ' : ''}${esc(t.title || 'テスト')}`, `${esc(md(t.date))}${t.dateTo !== t.date ? '〜' + esc(md(t.dateTo)) : ''}`)).join('') + '</div>';
}
function testSheet(ctx, tests) {
  const { esc } = ctx, t = pick && pick.kind === 'test' && tests.find(x => x.eventId === pick.id);
  if (!t) return '';
  return sheet(esc, (t.studentName ? t.studentName + ' ' : '') + (t.title || 'テスト'), `<p class="small muted" style="margin-top:0">${esc(md(t.date))}${t.dateTo !== t.date ? '〜' + esc(md(t.dateTo)) : ''}。受けなかった・記録しないときは「結果なし」にします。</p>
    <div class="row"><button class="primary" data-action="gr-from-test" data-student="${esc(t.studentId)}" data-event="${esc(t.eventId)}" data-title="${esc(t.title)}" data-date="${esc(t.dateTo)}">結果を入れる</button><button data-action="gr-skip" data-event="${esc(t.eventId)}"${ctx.dis()}>結果なし</button></div>`, 'gr-unpick');
}

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
  h += `<div class="page-head"><h1>${esc(st.student.name)} の成績</h1></div><p class="sub" style="margin-top:0">${esc(st.student.grade || '')}${st.subjects ? '・あなたの担当: ' + st.subjects.map(esc).join('・') + '（ほかの科目は合計だけ）' : ''}</p>${ctx.notice()}`;
  if (st.nextTest) h += `<p class="small">次のテスト: ${esc(st.nextTest.title || '')}（${esc(md(st.nextTest.date))}、あと${st.nextTest.days}日）</p>`;
  if (st.pendingTests.length) h += `<h2>結果の入力待ち</h2>${pendingList(ctx, st.pendingTests, false)}`;
  h += `<p><button class="primary" data-action="gr-new"${ctx.dis()}>＋ 試験の結果を入れる</button></p>`;
  h += gradeCharts(st.exams);
  h += st.exams.slice().reverse().map(e => examCard(e, { actions: `<div class="row"><button data-action="gr-edit" data-id="${esc(e.id)}"${ctx.dis()}>直す</button>${st.manager ? `<button class="danger" data-action="gr-delete" data-id="${esc(e.id)}" data-version="${e.version}"${ctx.dis()}>消す</button>` : ''}</div>` })).join('');
  if (!st.exams.length) h += '<p class="muted">まだ記録がありません。</p>';
  if (st.manager) {
    h += `<h2>成績票</h2>${fileList(st.files, 'gr-open')}`;
    const fresh = st.files.filter(f => f.status === 'new');
    if (fresh.length) h += `<h3>取り込み待ち <span class="small muted" style="font-weight:400">点数を入れたら「取り込んだ」にします</span></h3><div class="rows">` + fresh.map(f => rowButton(esc, 'gr-pick', { kind: 'resolve', id: f.id }, esc(f.name), `${esc(jst(f.createdAt).slice(5))}${f.note ? '・' + esc(f.note) : ''}`)).join('') + '</div>';
    const f = pick && pick.kind === 'resolve' && fresh.find(x => x.id === pick.id);
    if (f) h += sheet(esc, f.name, `<div class="stack"><button data-action="gr-open" data-id="${esc(f.id)}">成績票を開く</button>
      <label>どの試験の成績票か<select data-resolve-exam="${esc(f.id)}"><option value="">（試験を選ばない）</option>${st.exams.slice().reverse().map(e => `<option value="${esc(e.id)}">${esc(e.name)}（${esc(md(e.date))}）</option>`).join('')}</select></label>
      <div class="row"><button class="primary" data-action="gr-resolve" data-id="${esc(f.id)}" data-status="imported"${ctx.dis()}>取り込んだ</button><button data-action="gr-resolve" data-id="${esc(f.id)}" data-status="dismissed"${ctx.dis()}>取り込まない</button></div></div>`, 'gr-unpick');
    h += `<h3>スタッフから成績票を残す</h3>${uploadForm(ctx.dis())}`;
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
  if (!manager) subjects = st.subjects.map(s => (e && e.scores.find(x => x.subject === s)) || { subject: s });
  else { subjects = e ? e.scores.slice() : st.lessonSubjects.map(s => ({ subject: s })); while (subjects.length < (e ? e.scores.length + 2 : Math.max(5, subjects.length))) subjects.push({ subject: '' }); }
  const t = e ? e.total : {};
  const r = e && e.review || {};
  const field = (name, label, val, attrs = '') => `<label>${label}<input name="${name}" value="${val}" ${attrs}></label>`;
  const numAttrs = 'inputmode="decimal" style="width:5.5em"';
  return `<form class="stack" data-form="gr-save"${e ? ` data-id="${esc(e.id)}" data-version="${e.version}" data-review-version="${r.version || ''}"` : ''}>
    ${p && p.eventId ? `<input type="hidden" name="eventId" value="${esc(p.eventId)}">` : ''}
    <div class="row"><label>種類<select name="kind"><option value="regular"${!e || e.kind === 'regular' ? ' selected' : ''}>定期テスト</option><option value="mock"${e && e.kind === 'mock' ? ' selected' : ''}>模試</option></select></label>
    <label style="flex:1">名前<input name="name" maxlength="40" required value="${esc(e ? e.name : p ? p.title : '')}" placeholder="例: 2学期中間テスト"></label>
    <label>実施日<input type="date" name="date" required max="${today()}" value="${esc(e ? e.date : p ? p.date : '')}"></label><label>学年<input name="grade" maxlength="20" style="width:5em" value="${esc(e ? e.grade : st.student.grade || '')}"></label></div>
    <div class="small muted">科目ごと（分かる項目だけ。定期テストは平均点・順位、模試は偏差値など）</div>
    <div style="overflow-x:auto"><table class="small"><tr><th>科目</th><th>点数</th><th>満点</th><th>平均点</th><th>順位</th><th>人数</th><th>偏差値</th></tr>
    ${subjects.map((s, i) => `<tr><td><input name="s.${i}.subject" maxlength="20" value="${esc(s.subject)}" style="width:6em"${manager ? '' : ' readonly'}><input type="hidden" name="s.${i}.orig" value="${esc(s.score !== undefined || s.max !== undefined ? s.subject : '')}"></td>
      ${['score', 'max', 'average', 'rank', 'rankOf', 'deviation'].map(k => `<td><input name="s.${i}.${k}" value="${v(s, k)}" ${numAttrs}${k === 'max' && !e && s.subject ? ' placeholder="100"' : ''}></td>`).join('')}</tr>`).join('')}</table></div>
    ${manager ? `<div class="small muted">全体（空なら科目の合計を出します）</div><div class="row">${field('totalScore', '合計', v(e && t.fromSubjects ? null : t, 'score'), numAttrs)}${field('totalMax', '満点', v(e && t.fromSubjects ? null : t, 'max'), numAttrs)}${field('totalRank', '順位', v(t, 'rank'), numAttrs)}${field('totalRankOf', '人数', v(t, 'rankOf'), numAttrs)}${field('totalDeviation', '偏差値', v(t, 'deviation'), numAttrs)}</div>` : ''}
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
  const v = Object.fromEntries(new FormData(el).entries()), id = el.dataset.id;
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
      scores.push({ subject, score, max: max || (score && !id ? 100 : max), average, rank, rankOf, deviation });
    }
    if (scores.length) r = await ctx.call('grades/scores/save', { examId, scores });
    if (r.ok && (v.good || v.issues || v.nextSteps || el.dataset.reviewVersion)) r = await ctx.call('grades/reviews/save', { examId, version: el.dataset.reviewVersion ? Number(el.dataset.reviewVersion) : undefined, good: v.good, issues: v.issues, nextSteps: v.nextSteps });
  }
  if (r.ok) { editing = ''; prefill = null; student = null; studentFor = ''; overview = null; ctx.say('保存しました', 'ok'); }
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
