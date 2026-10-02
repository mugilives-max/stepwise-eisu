// スタッフの画面: 授業記録（4段目）。記録待ち・宿題の確認待ち・記録を書く画面・引き継ぎメモ。
// 講師は自分の担当の授業と担当の生徒だけ。教室管理者はすべて。
import { mdw, endOf } from '/assets/v2/schedule-view.js?v=20261002-ux2';

let pending = null, reported = null, rec = null, recFor = '', hwRows = null, parts = [];
const NOTE_KEYS = ['plannedUnit', 'understanding', 'pace', 'homeworkReview', 'homeworkAccuracy', 'nextFocus', 'memo'];
// 選ぶ項目（表記がずれないように）。サーバーの NOTE_CHOICES（cf/v2/records.mjs）と同じ値
const CHOICES = {
  understanding: [['5', '5 よく分かっている'], ['4', '4 だいたい分かっている'], ['3', '3 半分くらい'], ['2', '2 あやふや'], ['1', '1 まだ分かっていない']],
  pace: [['onTrack', '予定どおり'], ['ahead', '予定より進んだ'], ['behind', '予定より遅れた']],
  homeworkReview: [['done', 'やってきた'], ['partial', '一部だけ'], ['notDone', 'やってこなかった'], ['none', '宿題なし']],
};
export const choiceLabel = (k, v) => { const c = (CHOICES[k] || []).find(x => x[0] === v); return c ? c[1] : v; };
export function resetRecords() { pending = null; reported = null; rec = null; recFor = ''; hwRows = null; parts = []; }
// 扱った範囲の1件を文に: 「不定詞 Keywork p.10〜12」
function pagesText(p) { const s = String(p || '').trim().replace(/^p\.?\s*/i, '').replace(/\s*[-~～ー−]\s*/g, '〜'); return s ? 'p.' + s : ''; }
const partText = p => [p.unit, p.material, pagesText(p.pages)].filter(Boolean).join(' ');

// 「記録」: 記録待ちと、宿題の確認待ち
export function recordsPage(ctx) {
  const { esc } = ctx;
  if (!pending) { ctx.call('records/pending').then(r => { pending = r.ok ? r : { lessons: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); return '<h1>記録</h1><p class="muted">読み込んでいます…</p>'; }
  if (!reported) { ctx.call('homework/reported').then(r => { reported = r.ok ? r.homework : []; ctx.render(); }); }
  let h = `<h1>記録</h1>${ctx.notice()}`;
  if (pending.unreadHandover) h += `<p class="notice">まだ読んでいない引き継ぎメモが ${pending.unreadHandover}件あります。記録を書く画面に出ます。</p>`;
  h += `<h2>記録待ち（${pending.lessons.length}件・直近60日）</h2>`;
  h += pending.lessons.length ? '<div class="list">' + pending.lessons.map(l => `<div><div>${mdw(l.date)} ${l.start} <strong>${esc(l.studentName)}</strong> ${esc(l.subject)} ${l.draft ? '<span class="tag warn">下書き</span>' : ''}</div><div><a href="#record=${encodeURIComponent(l.id)}">記録を書く</a></div></div>`).join('') + '</div>' : '<p class="muted">記録待ちの授業はありません。</p>';
  h += `<h2>宿題の確認待ち（${reported ? reported.length : '…'}件）</h2>`;
  if (reported) h += reported.length ? '<div class="list">' + reported.map(w => `<div><div><strong>${esc(w.studentName)}</strong> ${esc(w.title)}${w.material ? '（' + esc(w.material) + '）' : ''}<div class="small muted">できたと報告 ${esc(String(w.reportedAt).slice(5, 16).replace('T', ' '))}</div></div>
      <div class="row"><button class="primary" data-action="hw-confirm" data-id="${esc(w.id)}" data-version="${w.version}"${ctx.dis()}>確認した</button><button data-action="hw-redo" data-id="${esc(w.id)}" data-version="${w.version}"${ctx.dis()}>やり直し</button></div></div>`).join('') + '</div>' : '<p class="muted">確認待ちの宿題はありません。</p>';
  return h;
}

// 記録を書く画面
export function recordPage(ctx, lessonId) {
  const { esc } = ctx;
  if (recFor !== lessonId) { recFor = lessonId; rec = null; hwRows = null; ctx.call('records/lesson', { lessonId }).then(r => { if (recFor !== lessonId) return; if (r.ok) { rec = r; hwRows = r.homework.map(x => ({ ...x })); parts = r.record && r.record.rangeParts ? r.record.rangeParts.map(x => ({ ...x })) : []; } else { rec = { error: r.error.message }; ctx.handleAuth(r); } ctx.render(); }); }
  if (!rec) return '<h1>授業記録</h1><p class="muted">読み込んでいます…</p>';
  if (rec.error) return `<p class="small"><a href="#records">← 記録</a></p><h1>授業記録</h1><p class="notice error">${esc(rec.error)}</p>`;
  const l = rec.lesson, saved = rec.record || { range: '', comment: '', parentMessage: '', staffNotes: {}, status: 'none' };
  const r = rec.draftInputs ? { ...saved, ...rec.draftInputs } : saved, n = r.staffNotes || {};
  const future = l.date > rec.today, locked = r.status === 'void';
  let h = `<p class="small"><a href="#records">← 記録</a> ・ <a href="#schedule">予定</a></p><h1>${esc(rec.student.name)} ${esc(l.subject)}</h1><p class="sub">${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}・${esc(rec.student.grade || '')}・記録 ${r.status === 'published' ? '<span class="tag ok">公開済み</span>' : r.status === 'draft' ? '<span class="tag warn">下書き</span>' : r.status === 'void' ? '<span class="tag gray">無効</span>' : '<span class="tag gray">まだ</span>'}</p>${ctx.notice()}`;
  // 引き継ぎメモ（読んでいないものを先に）
  const unread = rec.handover.filter(x => !x.read);
  if (rec.handover.length) h += `<h2>引き継ぎメモ${unread.length ? `（未読 ${unread.length}）` : ''}</h2><div class="list">` + rec.handover.map(x => `<div><div><span class="small muted">${esc(x.authorName)}・${esc(x.createdAt.slice(5, 10).replace('-', '/'))}</span><div style="white-space:pre-wrap">${esc(x.body)}</div></div>
    <div class="row">${x.read ? '' : `<button data-action="ho-read" data-id="${esc(x.id)}"${ctx.dis()}>読んだ</button>`}${x.mine ? `<button data-action="ho-close" data-id="${esc(x.id)}"${ctx.dis()}>しまう</button>` : ''}</div></div>`).join('') + '</div>';
  // 参考: 前回・未完了の宿題・次回・テスト
  h += '<h2>参考</h2><div class="small">';
  if (rec.previous.length) { const p = rec.previous[0]; h += `<p><strong>前回</strong> ${mdw(p.date)} ${esc(p.subject)}：${esc(p.range || '')} ${p.staffNotes.understanding ? '／理解度 ' + esc(choiceLabel('understanding', p.staffNotes.understanding)) : ''}${p.staffNotes.nextFocus ? '／次回やること: ' + esc(p.staffNotes.nextFocus) : ''}</p>`; }
  if (rec.openHomework.length) h += `<p><strong>未完了の宿題</strong> ${rec.openHomework.map(x => esc(x.title) + (x.status === 'reported' ? '（できたと報告）' : '')).join('、')}</p>`;
  h += `<p><strong>次の${esc(l.subject)}</strong> ${rec.nextSameSubject ? mdw(rec.nextSameSubject.date) : 'まだ決まっていません'}</p>`;
  if (rec.tests.length) h += `<p><strong>テスト</strong> ${rec.tests.map(t => mdw(t.date) + ' ' + esc(t.title)).join('、')}</p>`;
  h += '</div>';
  if (future) return h + '<p class="notice">授業の日になったら記録を書けます。</p>' + handoverForm(ctx);
  if (locked) return h + `<p class="notice">この記録は無効にしました（${esc(r.voidReason || '')}）。</p>`;
  h += `<form class="stack" data-form="rec-save" data-version="${rec.record && rec.record.id ? rec.record.version : ''}"><h2>生徒・保護者に見せる</h2>
    ${rangeHelper(ctx)}
    <label>扱った範囲（生徒・保護者に見えます）<input name="range" maxlength="500" value="${esc(r.range)}" placeholder="例: 不定詞 Keywork p.10〜12"></label>
    <label>コメント（公開するときは必須）<textarea name="comment" maxlength="2000" rows="4">${esc(r.comment)}</textarea></label>
    <label>保護者への連絡（任意）<textarea name="parentMessage" maxlength="1000" rows="2">${esc(r.parentMessage)}</textarea></label>
    <h2>宿題・持ち物</h2>${homeworkRows(ctx)}<p><button type="button" data-action="hw-add"${hwRows && hwRows.length >= 10 ? ' disabled' : ''}>＋ 宿題を足す</button></p>
    <h2>講師用（生徒・保護者には見せない）</h2>${staffNoteFields(ctx, n)}
    <div class="row"><button type="submit" name="publish" value="0"${ctx.dis()}>下書き保存</button><button class="primary" type="submit" name="publish" value="1"${ctx.dis()}>保存して公開</button></div>
    <p class="small muted">「保存して公開」で、生徒・保護者のページに記録と宿題が出ます。決定の授業は実施済みになります。公開したあとで直したときは、もう一度「保存して公開」を押すまで前の版が見えます。</p></form>`;
  return h + handoverForm(ctx) + (ctx.isManager && rec.record && rec.record.id ? `<h2>記録を無効にする</h2><form class="row" data-form="rec-void"><input name="reason" maxlength="300" placeholder="理由（例: 別の生徒の記録だった）" style="flex:1"><button class="danger"${ctx.dis()}>無効にする</button></form>` : '');
}
// 扱った範囲の入力補助: 内容・教材・ページを入れて「足す」と、範囲の欄に「不定詞 Keywork p.10〜12」の形で足す
function rangeHelper(ctx) {
  const { esc } = ctx, d = rec.draftHelper || {};
  let h = `<div class="sheet stack"><div class="small muted">扱った範囲の入力補助（教材とページで書くとき）</div><div class="row">
    <input data-rh="unit" maxlength="60" value="${esc(d.unit || '')}" placeholder="内容（例: 不定詞）" style="flex:2">
    <input data-rh="material" maxlength="60" value="${esc(d.material || '')}" placeholder="教材（例: Keywork）" list="rec-materials" style="flex:2">
    <input data-rh="pages" maxlength="30" value="${esc(d.pages || '')}" placeholder="ページ（例: 10-12）" style="flex:1;min-width:90px">
    <button type="button" data-action="range-add"${parts.length >= 10 ? ' disabled' : ''}>範囲に足す</button></div>
    <datalist id="rec-materials">${(rec.materials || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>`;
  if (parts.length) h += '<div class="row">' + parts.map((p, i) => `<span class="tag">${esc(partText(p))} <button type="button" class="link" data-action="range-remove" data-i="${i}" aria-label="外す">×</button></span>`).join('') + '</div>';
  return h + '</div>';
}
// 講師用の欄。理解度・進度・宿題は選ぶ。進度は予定単元を書いたときだけ出す（:has で切り替え）
function staffNoteFields(ctx, n) {
  const { esc } = ctx;
  const select = (k, label, cls = '') => {
    const v = n[k] || '', legacy = v && !CHOICES[k].some(c => c[0] === v);
    return `<label${cls ? ` class="${cls}"` : ''}>${label}<select name="note.${k}"><option value="">（選ばない）</option>${legacy ? `<option value="${esc(v)}" selected>前の記録: ${esc(v)}</option>` : ''}${CHOICES[k].map(([cv, cl]) => `<option value="${cv}"${cv === v ? ' selected' : ''}>${cl}</option>`).join('')}</select></label>`;
  };
  const input = (k, label, ph = '') => `<label>${label}<input name="note.${k}" maxlength="1000" value="${esc(n[k] || '')}"${ph ? ` placeholder="${esc(ph)}"` : ''}></label>`;
  return select('understanding', '理解度（5段階）')
    + `<div class="planned stack"><label>予定単元（授業計画があるとき）<input name="note.plannedUnit" maxlength="1000" value="${esc(n.plannedUnit || '')}" placeholder="例: 不定詞の名詞的用法"></label>${select('pace', '予定に対する進度', 'pace')}</div>`
    + select('homeworkReview', '前回出した宿題をやってきたか')
    + input('homeworkAccuracy', '宿題の正答率（%・任意）', '例: 80')
    + `<label>次回やること・気をつけること<textarea name="note.nextFocus" maxlength="1000" rows="2" placeholder="例: 不定詞の副詞的用法から。to のあとを原形にするミスに注意">${esc(n.nextFocus || '')}</textarea></label>`
    + `<label>メモ<textarea name="note.memo" maxlength="1000" rows="2">${esc(n.memo || '')}</textarea></label>`;
}
function homeworkRows(ctx) {
  const { esc } = ctx;
  if (!hwRows || !hwRows.length) return '<p class="small muted">宿題はまだありません。</p>';
  return hwRows.map((x, i) => `<div class="sheet stack" data-hw="${i}"><div class="row"><select data-hwf="kind"><option value="homework"${x.kind !== 'item' ? ' selected' : ''}>宿題</option><option value="item"${x.kind === 'item' ? ' selected' : ''}>持ち物</option></select>
    <input data-hwf="title" maxlength="200" value="${esc(x.title || '')}" placeholder="内容（例: ワーク p.10-12）" style="flex:2"><input data-hwf="material" maxlength="100" value="${esc(x.material || '')}" placeholder="教材（任意）" style="flex:1"></div>
    <div class="row"><select data-hwf="dueMode"><option value="nextLesson"${x.dueMode === 'nextLesson' ? ' selected' : ''}>次の授業まで</option><option value="date"${x.dueMode === 'date' ? ' selected' : ''}>日付まで</option><option value="none"${x.dueMode === 'none' ? ' selected' : ''}>期限なし</option></select>
    <input data-hwf="dueSubject" maxlength="30" value="${esc(x.dueSubject || (rec ? rec.lesson.subject : ''))}" placeholder="科目" style="max-width:120px"><input type="date" data-hwf="dueDate" value="${esc(x.dueDate || '')}" style="max-width:170px">
    ${x.status && x.status !== 'open' ? `<span class="tag ${x.status === 'confirmed' ? 'ok' : 'warn'}">${x.status === 'confirmed' ? '確認済み' : 'できたと報告'}</span>` : ''}<button type="button" data-action="hw-remove" data-i="${i}">外す</button></div></div>`).join('');
}
function handoverForm(ctx) {
  const { esc } = ctx;
  return `<h2>引き継ぎメモを書く</h2><form class="stack" data-form="ho-add"><label>次の担当・代講への伝言<textarea name="body" maxlength="1000" rows="3" placeholder="例: 分数の約分でつまずきやすい。前回は通分まで確認済み"></textarea></label>
    <label>だれに<select name="toStaffId"><option value="">この生徒を担当する全員</option>${rec.staff.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><button${ctx.dis()}>残す</button></form>`;
}
// 宿題の入力欄の今の値を読む（描き直す前に）
function readHomework() {
  if (!hwRows) return;
  document.querySelectorAll('[data-hw]').forEach(row => { const i = Number(row.dataset.hw); if (hwRows[i]) row.querySelectorAll('[data-hwf]').forEach(f => { hwRows[i][f.dataset.hwf] = f.value; }); });
}
// 記録の画面で書きかけの内容を覚えておく。ボタンを押すと画面を描き直すので、その前に app.js から呼ぶ
export function captureRecordInputs() {
  if (!rec || !rec.lesson) return;
  readHomework();
  const f = document.querySelector('form[data-form="rec-save"]'); if (!f) return;
  const v = Object.fromEntries(new FormData(f).entries()), notes = {};
  for (const k of NOTE_KEYS) notes[k] = v['note.' + k] || '';
  rec.draftInputs = { range: v.range || '', comment: v.comment || '', parentMessage: v.parentMessage || '', staffNotes: notes };
  const helper = {}; f.querySelectorAll('[data-rh]').forEach(x => { helper[x.dataset.rh] = x.value; }); rec.draftHelper = helper;
}

// 引き継ぎメモだけを読み直す（書きかけの記録はそのまま）
async function refreshHandover(ctx) { const r = await ctx.call('records/lesson', { lessonId: rec.lesson.id }); if (r.ok) rec.handover = r.handover; }

export async function recordsSubmit(ctx, kind, el, ev) {
  if (kind === 'rec-save') {
    const v = Object.fromEntries(new FormData(el).entries()), publish = ev && ev.submitter && ev.submitter.value === '1';
    const staffNotes = {}; for (const k of NOTE_KEYS) staffNotes[k] = v['note.' + k] || '';
    if (!staffNotes.plannedUnit.trim()) staffNotes.pace = ''; // 予定がないときは進度を書かない
    const r = await ctx.call('records/save', { lessonId: rec.lesson.id, version: el.dataset.version ? Number(el.dataset.version) : undefined, range: v.range, rangeParts: parts, comment: v.comment, parentMessage: v.parentMessage, staffNotes, homework: hwRows.map(x => ({ id: x.id || '', kind: x.kind, title: x.title, material: x.material, dueMode: x.dueMode || 'nextLesson', dueDate: x.dueDate, dueSubject: x.dueSubject })), publish });
    if (r.ok) { recFor = ''; pending = null; ctx.say(publish ? '保存して公開しました' : '下書きを保存しました', 'ok'); }
    else if (r.error && r.error.code === 'conflict') ctx.say(r.error.message + '（書いた内容は画面に残っています。コピーしてから更新してください）', 'error');
    else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
    return true;
  }
  if (kind === 'ho-add') {
    const v = Object.fromEntries(new FormData(el).entries());
    const r = await ctx.call('handover/add', { studentId: rec.student.id, toStaffId: v.toStaffId, body: v.body });
    if (r.ok) { await refreshHandover(ctx); ctx.say('引き継ぎメモを残しました', 'ok'); } else ctx.say(r.error.message, 'error');
    return true;
  }
  if (kind === 'rec-void') {
    const v = Object.fromEntries(new FormData(el).entries());
    if (!confirm('この記録を無効にしますか？ 生徒・保護者のページから消え、未完了の宿題も取り下げます。')) return true;
    const r = await ctx.call('records/void', { id: rec.record.id, version: rec.record.version, reason: v.reason });
    if (r.ok) { recFor = ''; pending = null; ctx.say('記録を無効にしました', 'ok'); } else ctx.say(r.error.message, 'error');
    return true;
  }
  return false;
}
export async function recordsClick(ctx, a, b) {
  if (a === 'hw-add') { hwRows.push({ kind: 'homework', title: '', material: '', dueMode: 'nextLesson', dueSubject: rec.lesson.subject, dueDate: '' }); return true; }
  if (a === 'hw-remove') { hwRows.splice(Number(b.dataset.i), 1); return true; }
  if (a === 'range-add') {
    const d = rec.draftHelper || {}, p = { unit: (d.unit || '').trim(), material: (d.material || '').trim(), pages: (d.pages || '').trim() };
    if (!p.unit && !p.material && !p.pages) { ctx.say('内容・教材・ページのどれかを入れてください', 'error'); return true; }
    parts.push(p);
    const cur = rec.draftInputs ? rec.draftInputs.range : '';
    rec.draftInputs = { ...(rec.draftInputs || {}), range: (cur.trim() ? cur.trim() + '、' : '') + partText(p) };
    rec.draftHelper = { material: p.material }; // 同じ教材が続くことが多いので教材は残す
    return true;
  }
  if (a === 'range-remove') {
    const p = parts.splice(Number(b.dataset.i), 1)[0];
    if (p && rec.draftInputs) { const t = partText(p); rec.draftInputs = { ...rec.draftInputs, range: rec.draftInputs.range.split('、').filter(x => x.trim() !== t).join('、') }; }
    return true;
  }
  if (a === 'ho-read' || a === 'ho-close') { const r = await ctx.call(a === 'ho-read' ? 'handover/read' : 'handover/close', { id: b.dataset.id }); if (r.ok) { await refreshHandover(ctx); pending = null; } else ctx.say(r.error.message, 'error'); return true; }
  if (a === 'hw-confirm' || a === 'hw-redo') {
    let note = '';
    if (a === 'hw-redo') { note = prompt('やり直してほしいところを書いてください（生徒・保護者に見えます）') || ''; if (!note.trim()) return true; }
    const r = await ctx.call('homework/review', { id: b.dataset.id, version: Number(b.dataset.version), action: a === 'hw-confirm' ? 'confirm' : 'redo', note });
    if (r.ok) { reported = null; ctx.say(a === 'hw-confirm' ? '確認しました' : 'やり直しを伝えました', 'ok'); } else ctx.say(r.error.message, 'error');
    return true;
  }
  return false;
}
