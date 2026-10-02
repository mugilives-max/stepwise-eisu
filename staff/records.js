// スタッフの画面: 授業記録（4段目）。記録待ち・宿題の確認待ち・記録を書く画面・引き継ぎメモ。
// 講師は自分の担当の授業と担当の生徒だけ。教室管理者はすべて。
import { mdw, endOf } from '/assets/v2/schedule-view.js?v=20261003-ux19';
import { sheet, rowButton, rowLink, slider } from '/staff/ui.js?v=20261003-ux19';
import { hwText } from '/assets/v2/learning-view.js?v=20261003-ux19';

let pending = null, reported = null, rec = null, recFor = '', hwRows = null, rgRows = null, hwOpen = '', panel = '';
let kept = {}; // 2人同時の授業で切り替えたとき、書きかけをとっておく（授業ごと）。先に読んでおいた相手の記録も入る。記録の画面を離れたら捨てる
let swapFrom = '', swapTo = '', swapDir = '', slidePending = false;
let bar = null; // 画面の上の帯（記録の画面だけ）: 名前と日時・三本線。app.js が描く
export const recordBar = () => bar; // 切り替えの動き（押した人と前の人） // 切り替えの丸い背景を、前に出ていた人から滑らせるため // panel: 記録の画面で開いているもの（range・hw・next）
const NOTE_KEYS = ['plannedUnit', 'understanding', 'pace', 'homeworkReview', 'homeworkAccuracy', 'nextFocus', 'memo'];
// 選ぶ項目（表記がずれないように）。サーバーの NOTE_CHOICES（cf/v2/records.mjs）と同じ値
const CHOICES = {
  understanding: [['5', '5 よく分かっている'], ['4', '4 だいたい分かっている'], ['3', '3 半分くらい'], ['2', '2 あやふや'], ['1', '1 まだ分かっていない']],
  pace: [['onTrack', '予定どおり'], ['ahead', '予定より進んだ'], ['behind', '予定より遅れた']],
  homeworkReview: [['done', 'やってきた'], ['partial', '一部だけ'], ['notDone', 'やってこなかった'], ['none', '宿題なし']],
};
// 宿題ごとのチェック（前回までの宿題）。値はサーバーの CHECK_RESULTS（cf/v2/records.mjs）と同じ
// 宿題の正答率は10%刻みで選ぶ（数字を打たない）
const ACCURACY = Array.from({ length: 11 }, (_, i) => [String(i * 10), i * 10 + '%']);
export const choiceLabel = (k, v) => { const c = (CHOICES[k] || []).find(x => x[0] === v); return c ? c[1] : v; };
export function leaveRecords(page) { hwOpen = ''; panel = ''; if (page !== 'record') { kept = {}; swapFrom = swapTo = ''; } }
export function resetRecords() { kept = {}; hwOpen = ''; pending = null; reported = null; rec = null; recFor = ''; hwRows = null; rgRows = null; }
// 扱った範囲の1件を文に: 「不定詞 Keywork p.10〜12」
function pagesText(p) { const s = String(p || '').trim().replace(/^p\.?\s*/i, '').replace(/\s*[-~～ー−]\s*/g, '〜'); return s ? 'p.' + s : ''; }

// 「記録」: 記録待ちと、宿題の確認待ち。宿題は押すと下から「確認した・やり直し」
export function recordsPage(ctx) {
  const { esc } = ctx;
  const head = `<div class="page-head"><h1>記録</h1></div>`;
  if (!pending) { ctx.call('records/pending').then(r => { pending = r.ok ? r : { lessons: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); return head + '<p class="muted">読み込んでいます…</p>'; }
  if (!reported) { ctx.call('homework/reported').then(r => { reported = r.ok ? r.homework : []; ctx.render(); }); }
  let h = head + ctx.notice();
  if (pending.unreadHandover) h += `<p class="notice">まだ読んでいない引き継ぎメモが ${pending.unreadHandover}件あります。記録を書く画面に出ます。</p>`;
  h += `<h2>記録待ち${pending.lessons.length ? ` <span class="count">${pending.lessons.length}</span>` : ''}</h2>`;
  h += pending.lessons.length ? '<div class="rows">' + pending.lessons.map(l => rowLink('#record=' + encodeURIComponent(l.id), `${mdw(l.date)} ${l.start} ${esc(l.studentName)}`, esc(l.subject), l.draft ? '<span class="tag warn">下書き</span>' : '')).join('') + '</div><p class="small muted">直近60日の、実施済み・始まった授業のうち記録がないもの。</p>' : '<p class="muted small">記録待ちの授業はありません。</p>';
  h += `<h2>宿題の確認待ち${reported && reported.length ? ` <span class="count">${reported.length}</span>` : ''}</h2>`;
  if (!reported) h += '<p class="muted small">読み込んでいます…</p>';
  else h += reported.length ? '<div class="rows">' + reported.map(w => rowButton(esc, 'hw-open', { id: w.id }, `${esc(w.studentName)} ${esc(hwText(w))}`, `${esc(w.dueSubject || '')}・できたと報告 ${esc(String(w.reportedAt).slice(5, 16).replace('T', ' ').replace('-', '/'))}`)).join('') + '</div>' : '<p class="muted small">確認待ちの宿題はありません。</p>';
  const w = hwOpen && reported && reported.find(x => x.id === hwOpen);
  if (w) h += sheet(esc, w.studentName + ' の宿題', `<p style="margin-top:0"><strong>${esc(hwText(w))}</strong>${w.dueSubject ? `<br><span class="small muted">${esc(w.dueSubject)}</span>` : ''}</p>
    <form class="stack" data-form="hw-review" data-id="${esc(w.id)}" data-version="${w.version}"><label>やり直してほしいところ（やり直しのときだけ。生徒・保護者に見えます）<textarea name="note" maxlength="300" rows="2" placeholder="例: 問3と問5をもう一度"></textarea></label>
    <div class="row"><button class="primary" name="act" value="confirm"${ctx.dis()}>確認した</button><button name="act" value="redo"${ctx.dis()}>やり直しを伝える</button></div></form>`, 'hw-close');
  return h;
}

// 記録を書く画面（スマホで1画面に収める）。左上の三本線（ハンバーガーメニュー）で左から出る画面に、いつも見なくてよいもの
// （前回のこと・テスト・引き継ぎメモ、前回の宿題の ○△× と正答率、今日出す宿題）をまとめる。元の画面は 範囲・理解度・コメント・宿題の要点・次回へ。
// 開く画面もフォームの中に常に置き、閉じているときは隠す
export function recordPage(ctx, lessonId) {
  const { esc } = ctx;
  if (recFor !== lessonId) {
    const prev = recFor && rec && rec.lesson ? { rec, hwRows, rgRows, touched: true } : null;
    if (prev) kept[recFor] = prev;
    recFor = lessonId; rec = null; hwRows = null; rgRows = null; panel = '';
    const back = kept[lessonId]; delete kept[lessonId];
    if (back) { ({ rec, hwRows, rgRows } = back); if (prev && (prev.rec.together || []).length) rec.together = prev.rec.together; } // 切り替えて戻ってきた: 書きかけのまま（並びの記録の状態は新しいほうを使う）
    else ctx.call('records/lesson', { lessonId }).then(r => {
      if (recFor !== lessonId) return;
      if (r.ok) { rec = r; hwRows = r.homework.map(x => ({ ...x })); rgRows = rangeRowsFrom(r.record); prefetch(ctx, r); } else { rec = { error: r.error.message }; ctx.handleAuth(r); }
      ctx.render();
    });
  }
  bar = null;
  if (!rec) return '<p class="muted" style="margin-top:24px">読み込んでいます…</p>';
  if (rec.error) return `<h1>授業記録</h1><p class="notice error">${esc(rec.error)}</p>`;
  const l = rec.lesson, saved = rec.record || { range: '', comment: '', parentMessage: '', staffNotes: {}, status: 'none' };
  const r = rec.draftInputs ? { ...saved, ...rec.draftInputs } : saved, n = r.staffNotes || {};
  const future = l.date > rec.today, locked = r.status === 'void';
  while (hwRows.length < 3) hwRows.push({ kind: 'homework', title: '', material: '', dueMode: 'nextLesson', dueSubject: l.subject, dueDate: '' }); // 宿題ははじめから3行（空の行は保存しない）
  const state = r.status === 'published' ? '<span class="tag ok">公開済み</span>' : r.status === 'draft' ? '<span class="tag warn">下書き</span>' : r.status === 'void' ? '<span class="tag gray">無効</span>' : '';
  const when = `<div class="small muted">${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}${rec.student.grade ? '・' + esc(rec.student.grade) : ''}</div>`;
  const title = `${esc(rec.student.name)}・${esc(l.subject)}`, sub = `${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}${rec.student.grade ? '・' + esc(rec.student.grade) : ''}`;
  if (future || locked) {
    bar = { title, sub, right: '' };
    const h0 = `${ctx.notice()}${beforePart(ctx)}`;
    return future ? h0 + '<p class="notice">授業の日になったら記録を書けます。</p>' + handoverForm(ctx) : h0 + `<p class="notice">この記録は無効にしました（${esc(r.voidReason || '')}）。</p>`;
  }
  const checks = rec.checks || [], due = rec.nextSameSubject ? mdw(rec.nextSameSubject.date) : 'まだ決まっていません';
  const curCheck = x => rec.draftChecks && rec.draftChecks[x.id] !== undefined ? rec.draftChecks[x.id] : x.checkedHere ? x.checkResult : '';
  const unchecked = checks.filter(x => !curCheck(x)).length, unread = rec.handover.filter(x => !x.read).length;
  // 上の帯: 戻る・名前と日時・三本線（まだチェックしていない宿題や読んでいない引き継ぎメモがあるときは点）
  bar = { title, sub, right: `<button type="button" class="hamb${unchecked || unread ? ' dot' : ''}" data-action="rec-open" data-k="hw" aria-label="宿題と前回のことを開く"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button>` };
  let h = togetherPart(ctx) + ctx.notice();
  h += `<form class="rec" data-form="rec-save" data-version="${rec.record && rec.record.id ? rec.record.version : ''}"><div class="group">`;
  if (!checks.length) h += `<input type="hidden" name="note.homeworkAccuracy" value="${esc(n.homeworkAccuracy || '')}"><input type="hidden" name="note.homeworkReview" value="${esc(n.homeworkReview || '')}">`;
  // 今日の授業
  const range = (rgRows || []).map(rangeLine).filter(Boolean).join('、');
  h += row('range', '範囲', range ? esc(range) : '', '教材とページ');
  h += slider(esc, { name: 'note.understanding', label: '理解度', value: n.understanding, options: CHOICES.understanding.map(([v]) => [v, v]).reverse(), compact: true });
  h += `<label class="rec-line rec-text"><span class="k">コメント</span><textarea class="grow" name="comment" maxlength="2000" rows="2" placeholder="授業の様子（公開するときは必須）">${esc(r.comment)}</textarea></label>`;
  // 今日出す宿題・次回へ（押すと開く）
  const hw = hwRows.filter(x => hwText(x).trim());
  const hwSum = [checks.length ? `前回 ${checks.length - unchecked}/${checks.length}` : '', hw.length ? `今日 ${esc(hwText(hw[0]))}${hw.length > 1 ? ` ほか${hw.length - 1}件` : ''}` : ''].filter(Boolean).join('・');
  h += row('hw', '宿題', hwSum, checks.length ? `前回の宿題 ${checks.length}件をチェック` : `出すときは押す（次の${l.subject} ${due}まで）`);
  const nextBits = [n.nextFocus, r.parentMessage ? '保護者へ: ' + r.parentMessage : '', n.memo ? 'メモあり' : ''].filter(Boolean);
  h += row('next', '次回へ', nextBits.length ? esc(nextBits.join('・')) : '', '次回やること・保護者へ・メモ');
  h += `<datalist id="rec-materials">${(rec.materials || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
    </div><div class="savebar">${state}<span style="flex:1"></span><button type="submit" name="publish" value="0"${ctx.dis()}>下書き</button><button class="primary" type="submit" name="publish" value="1"${ctx.dis()}>保存して公開</button></div>`;
  // 開く画面（いつもフォームの中に置く）
  h += panelHtml('range', '扱った範囲', `${rangeRows(ctx)}<button type="button" class="link small" data-action="rg-add"${rgRows.length >= 10 ? ' disabled' : ''}>＋ 範囲を足す</button>`);
  h += panelHtml('hw', '宿題と前回のこと', beforePart(ctx)
    + (checks.length ? `<div class="rec-block"><div class="rec-label">前回の宿題 <span>○やった △一部 ×やってない（△×は次へ持ち越し）</span></div>${checksPart(ctx)}</div>
      ${slider(esc, { name: 'note.homeworkAccuracy', label: '正答率', value: String(n.homeworkAccuracy || '').replace(/\s*%$/, ''), options: ACCURACY, compact: true })}` : '')
    + `<div class="rec-label" style="margin-top:6px">今日の宿題 <span>期限は次の${esc(l.subject)}の授業（${due}）。使わない行は空でよい</span></div>${homeworkRows(ctx)}${hwRows.every(x => hwText(x).trim()) && hwRows.length < 10 ? '<button type="button" class="link small" data-action="hw-add">＋ もう1つ</button>' : ''}
    <p class="small muted" style="margin:14px 0 0">公開すると、範囲・コメント・保護者への連絡・宿題とそのチェックが生徒と保護者に見えます。決定の授業は実施済みになります。</p>
    ${ctx.isManager && rec.record && rec.record.id ? `<details class="more"><summary>記録を無効にする</summary><div class="row"><input id="rec-void-reason" maxlength="300" placeholder="理由（例: 別の生徒の記録だった）" style="flex:1"><button type="button" class="danger" data-action="rec-void"${ctx.dis()}>無効にする</button></div></details>` : ''}`, 'left');
  h += panelHtml('next', '次回へ', `<label>次回やること・気をつけること<textarea name="note.nextFocus" maxlength="1000" rows="2" placeholder="副詞的用法から。to のあとを原形にするミスに注意">${esc(n.nextFocus || '')}</textarea></label>
    <label>保護者への連絡<textarea name="parentMessage" maxlength="1000" rows="2" placeholder="次回は小テストをします">${esc(r.parentMessage)}</textarea></label>
    <label>メモ<textarea name="note.memo" maxlength="1000" rows="2" placeholder="講師どうしのメモ">${esc(n.memo || '')}</textarea></label>
    <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:-4px"><input type="checkbox" name="hoSend" value="1"${rec.draftHo ? ' checked' : ''} style="width:auto"> このメモを次の担当にも引き継ぎメモとして知らせる</label>
    <div class="planned stack" style="margin:0"><label>授業計画で予定していた単元<input name="note.plannedUnit" maxlength="1000" value="${esc(n.plannedUnit || '')}" placeholder="不定詞の名詞的用法"></label>
      <div class="pace"><div class="field-label">予定に対して</div>${seg('note.pace', CHOICES.pace, n.pace, esc)}</div></div>`);
  h += '</form>';
  return h;
}
// 2人同時の授業の切り替え（ChatGPT の Chat/Work のような形）。名字が同じなら名前で出す。公開済みは ✓、下書きは ・
function prefetch(ctx, r) {
  for (const x of r.together || []) {
    if (x.id === r.lesson.id || kept[x.id]) continue;
    ctx.call('records/lesson', { lessonId: x.id }).then(o => { if (o.ok && !kept[x.id] && recFor !== x.id) kept[x.id] = { rec: o, hwRows: o.homework.map(y => ({ ...y })), rgRows: rangeRowsFrom(o.record) }; });
  }
}
// 丸い背景を、前の人から今の人へ滑らせ、中身を滑る向きに少しずらして出す。描き直しが続いても、最後に描いたあとで1回だけ動かす
function slideSeg() {
  if (slidePending) return; slidePending = true;
  requestAnimationFrame(() => {
    slidePending = false;
    const seg = document.querySelector('.seg2'); if (!seg) return;
    const ind = seg.querySelector('.ind'), to = seg.querySelector('button.on'), moved = swapTo && to.dataset.id === swapTo;
    const from = (moved && seg.querySelector(`button[data-id="${CSS.escape(swapFrom)}"]`)) || to;
    const put = b => { ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft - 3}px)`; };
    ind.style.transition = 'none'; put(from); void ind.offsetWidth; ind.style.transition = ''; seg.classList.add('ready'); put(to);
    if (moved && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const dx = swapDir === 'next' ? 14 : -14;
      document.querySelectorAll('.rec-head, form.rec').forEach(el => el.animate([{ opacity: .35, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.32, .72, 0, 1)' }));
    }
    if (moved) swapFrom = swapTo = swapDir = '';
  });
}
function togetherPart(ctx) {
  const { esc } = ctx, list = rec.together || [];
  if (list.length < 2) return '';
  slideSeg();
  return `<div class="seg2" role="tablist" aria-label="同じ時間の授業"><span class="ind" aria-hidden="true"></span>${list.map(x => {
    const on = x.id === rec.lesson.id, mark = x.recordStatus === 'published' ? ' <span class="ok">✓</span>' : x.recordStatus === 'draft' || (kept[x.id] && kept[x.id].touched) ? ' <span class="muted">・</span>' : '';
    return `<button type="button" role="tab" aria-selected="${on}" class="${on ? 'on' : ''}" data-action="rec-switch" data-id="${esc(x.id)}">${esc(x.name)}${mark}</button>`;
  }).join('')}</div>`;
}
// 1行の要点（押すと開く）
function row(key, label, value, placeholder) {
  return `<button type="button" class="rec-row" data-action="rec-open" data-k="${key}"><span class="k">${label}</span><span class="v${value ? '' : ' ph'}">${value || placeholder}</span><span class="go">›</span></button>`;
}
// 開く画面（下から、宿題は左から）。閉じているときも中の入力欄はフォームに残る
function panelHtml(key, title, body, side = 'bottom') {
  const on = panel === key;
  return `<div class="panel-overlay${on ? ' open' : ''}" data-action="rec-close"></div><section class="panel ${side}${on ? ' open' : ''}" aria-label="${title}"${on ? '' : ' aria-hidden="true" inert'}>
    <div class="panel-head"><strong>${title}</strong><button type="button" class="icon" data-action="rec-close" aria-label="閉じる">×</button></div><div class="panel-body">${body}</div>
    <div class="panel-foot"><button type="button" class="primary" data-action="rec-close">完了</button></div></section>`;
}
// 授業の前に見ること（1つの枠に）: 前回の記録・次回やること・引き継ぎメモ・近いテスト
function beforePart(ctx) {
  const { esc } = ctx, lines = [];
  const p = rec.previous[0];
  if (p) {
    const u = p.staffNotes.understanding;
    lines.push(`<div><span class="muted">前回 ${mdw(p.date)} ${esc(p.subject)}</span> ${esc(p.range || '')}${u ? ` <span class="tag gray">理解度 ${esc(u)}</span>` : ''}</div>`);
    if (p.staffNotes.nextFocus) lines.push(`<div><span class="muted">今回やること</span> ${esc(p.staffNotes.nextFocus)}</div>`);
  }
  if (rec.tests.length) lines.push(`<div><span class="muted">テスト</span> ${rec.tests.map(t => mdw(t.date) + ' ' + esc(t.title)).join('、')}</div>`);
  for (const x of rec.handover) lines.push(`<div class="ho${x.read ? '' : ' unread'}"><span class="muted">引き継ぎ（${esc(x.authorName)}・${esc(x.createdAt.slice(5, 10).replace('-', '/'))}）</span> <span style="white-space:pre-wrap">${esc(x.body)}</span>
    ${x.read ? '' : `<button type="button" class="small-btn" data-action="ho-read" data-id="${esc(x.id)}"${ctx.dis()}>読んだ</button>`}${x.mine ? `<button type="button" class="link small" data-action="ho-close" data-id="${esc(x.id)}"${ctx.dis()}>しまう</button>` : ''}</div>`);
  return lines.length ? `<div class="before small">${lines.join('')}</div>` : '';
}
// 選ぶ項目をボタンの並びで（宿題のチェックと同じ見た目）。前の記録の自由な値はそのまま残す
function seg(name, options, value, esc) {
  const v = value || '', legacy = v && !options.some(o => o[0] === v);
  return `<div class="chk" role="radiogroup">${legacy ? `<label><input type="radio" name="${name}" value="${esc(v)}" checked><span>前: ${esc(v)}</span></label>` : ''}${options.map(([ov, lb]) => `<label><input type="radio" name="${name}" value="${ov}"${ov === v ? ' checked' : ''}><span>${lb}</span></label>`).join('')}</div>`;
}
// 扱った範囲の行: 教材と範囲（宿題と同じ形）。「Keywork p.10〜12、単語 p.3」の文にして保存する
function rangeRowsFrom(record) {
  if (record && record.rangeParts && record.rangeParts.length) return record.rangeParts.map(p => ({ material: p.material || '', text: [p.unit, pagesText(p.pages)].filter(Boolean).join(' ') }));
  if (record && record.range) return [{ material: '', text: record.range }]; // 前の形（文だけ）はそのまま1行に
  return [{ material: '', text: '' }];
}
const rangeLine = x => [x.material, x.text].map(s => (s || '').trim()).filter(Boolean).join(' ');
function rangeRows(ctx) {
  const { esc } = ctx;
  return (rgRows || []).map((x, i) => `<div class="hwrow" data-rg="${i}"><input data-rgf="material" maxlength="60" value="${esc(x.material)}" placeholder="教材（例: Keywork）" list="rec-materials" aria-label="教材"><input data-rgf="text" maxlength="60" value="${esc(x.text)}" placeholder="範囲（例: p.10-12 不定詞）" aria-label="範囲">
    <button type="button" class="icon" data-action="rg-remove" data-i="${i}" aria-label="この範囲を外す">×</button></div>`).join('');
}
// 前回の宿題: 1件1行。印は ○ やってきた・△ 一部・× やってこなかった（値は hidden に入れて送る）
const MARKS = [['done', '○', 'やってきた'], ['partial', '△', '一部'], ['notDone', '×', 'やってこなかった']];
function checksPart(ctx) {
  const { esc } = ctx, list = rec.checks || [];
  const cur = x => rec.draftChecks && rec.draftChecks[x.id] !== undefined ? rec.draftChecks[x.id] : x.checkedHere ? x.checkResult : '';
  return list.map(x => `<div class="hwline"><span class="t">${esc(hwText(x))}${x.status === 'reported' ? ' <span class="tag ok">できた報告</span>' : ''}${x.checkResult && !x.checkedHere ? ` <span class="tag gray">前回${(MARKS.find(m => m[0] === x.checkResult) || ['', ''])[1]}</span>` : ''}</span>
    <span class="mk3" role="group" aria-label="${esc(hwText(x))}">${MARKS.map(([v, m, lb]) => `<button type="button" class="${v}${cur(x) === v ? ' on' : ''}" data-action="chk-set" data-id="${esc(x.id)}" data-v="${v}" aria-pressed="${cur(x) === v}" aria-label="${lb}">${m}</button>`).join('')}</span>
    <input type="hidden" name="chk.${esc(x.id)}" value="${esc(cur(x))}"></div>`).join('');
}
// 宿題の行: 教材（前に使った教材が候補）と範囲だけ。移行で写した形（持ち物・日付の期限）はそのまま残して印だけ出す
function homeworkRows(ctx) {
  const { esc } = ctx;
  const old = x => x.kind === 'item' ? '持ち物（前の形式）' : x.dueMode === 'date' ? `期限 ${x.dueDate ? mdw(x.dueDate) : ''}（前の形式）` : x.dueMode === 'none' ? '期限なし（前の形式）' : '';
  return hwRows.map((x, i) => `<div class="hwrow two" data-hw="${i}"><input data-hwf="material" maxlength="100" value="${esc(x.material || '')}" placeholder="教材" list="rec-materials" aria-label="教材"><input data-hwf="title" maxlength="200" value="${esc(x.title || '')}" placeholder="範囲（p.10-12）" aria-label="範囲">${old(x) || (x.status && x.status !== 'open') ? `<div class="small muted" style="grid-column:1/-1">${old(x)}${x.status && x.status !== 'open' ? ` <span class="tag ${x.status === 'confirmed' ? 'ok' : 'warn'}">${x.status === 'confirmed' ? '確認済み' : 'できたと報告'}</span>` : ''}</div>` : ''}</div>`).join('');
}
function handoverForm(ctx) {
  const { esc } = ctx;
  return `<details class="more"><summary>引き継ぎメモを書く</summary><form class="stack" data-form="ho-add"><label>次の担当・代講への伝言<textarea name="body" maxlength="1000" rows="3" placeholder="例: 分数の約分でつまずきやすい。前回は通分まで確認済み"></textarea></label>
    <label>だれに<select name="toStaffId"><option value="">この生徒を担当する全員</option>${rec.staff.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><button${ctx.dis()}>残す</button></form></details>`;
}
// 宿題の入力欄の今の値を読む（描き直す前に）
function readHomework() {
  if (rgRows) document.querySelectorAll('[data-rg]').forEach(row => { const i = Number(row.dataset.rg); if (rgRows[i]) row.querySelectorAll('[data-rgf]').forEach(f => { rgRows[i][f.dataset.rgf] = f.value; }); });
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
  rec.draftInputs = { comment: v.comment || '', parentMessage: v.parentMessage || '', staffNotes: notes };
  rec.draftHo = v.hoSend === '1';
  rec.draftChecks = {}; for (const x of rec.checks || []) rec.draftChecks[x.id] = v['chk.' + x.id] || '';
}

// 引き継ぎメモだけを読み直す（書きかけの記録はそのまま）
async function refreshHandover(ctx) { const r = await ctx.call('records/lesson', { lessonId: rec.lesson.id }); if (r.ok) rec.handover = r.handover; }

export async function recordsSubmit(ctx, kind, el, ev) {
  if (kind === 'hw-review') {
    const act = ev && ev.submitter ? ev.submitter.value : 'confirm', note = new FormData(el).get('note') || '';
    if (act === 'redo' && !note.trim()) { ctx.say('やり直してほしいところを書いてください', 'error'); return true; }
    const r = await ctx.call('homework/review', { id: el.dataset.id, version: Number(el.dataset.version), action: act, note: act === 'redo' ? note : '' });
    if (r.ok) { reported = null; hwOpen = ''; ctx.say(act === 'confirm' ? '確認しました' : 'やり直しを伝えました', 'ok'); } else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
    return true;
  }
  if (kind === 'rec-save') {
    const v = Object.fromEntries(new FormData(el).entries()), publish = ev && ev.submitter && ev.submitter.value === '1';
    const staffNotes = {}; for (const k of NOTE_KEYS) staffNotes[k] = v['note.' + k] || '';
    if (!staffNotes.plannedUnit.trim()) staffNotes.pace = ''; // 予定がないときは進度を書かない
    const r = await ctx.call('records/save', { lessonId: rec.lesson.id, version: el.dataset.version ? Number(el.dataset.version) : undefined, range: rgRows.map(rangeLine).filter(Boolean).join('、'), rangeParts: rgRows.filter(rangeLine).map(x => ({ unit: (x.text || '').trim(), material: (x.material || '').trim(), pages: '' })), comment: v.comment, parentMessage: v.parentMessage, staffNotes, homework: hwRows.filter(x => (x.title || '').trim() || (x.material || '').trim()).map(x => ({ id: x.id || '', kind: x.kind || 'homework', title: (x.title || '').trim() || x.material, material: (x.title || '').trim() ? x.material : '', dueMode: x.dueMode || 'nextLesson', dueDate: x.dueDate, dueSubject: x.dueSubject || rec.lesson.subject })), homeworkChecks: (rec.checks || []).map(x => ({ id: x.id, result: v['chk.' + x.id] || '' })), publish });
    if (r.ok) {
      // 「次の担当にも知らせる」: メモを引き継ぎメモとしても残す
      let ho = '';
      if (v.hoSend === '1' && staffNotes.memo.trim()) { const hr = await ctx.call('handover/add', { studentId: rec.student.id, body: staffNotes.memo.trim() }); ho = hr.ok ? '。メモを引き継ぎメモとしても残しました' : '。引き継ぎメモは残せませんでした（' + hr.error.message + '）'; }
      recFor = ''; pending = null; panel = ''; ctx.say((publish ? '保存して公開しました' : '下書きを保存しました') + ho, 'ok');
    }
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
  if (a === 'rec-switch') { if (b.dataset.id !== recFor) { const ids = (rec.together || []).map(x => x.id); swapDir = ids.indexOf(b.dataset.id) > ids.indexOf(recFor) ? 'next' : 'prev'; swapTo = b.dataset.id; swapFrom = recFor; location.replace('#record=' + encodeURIComponent(b.dataset.id)); } return true; } // 履歴を増やさない（戻るは前の画面へ）
  if (a === 'rec-open') { panel = b.dataset.k; return true; }
  if (a === 'rec-void') {
    const reason = (document.getElementById('rec-void-reason') || {}).value || '';
    if (!confirm('この記録を無効にしますか？ 生徒・保護者のページから消え、未完了の宿題も取り下げます。')) return true;
    const r = await ctx.call('records/void', { id: rec.record.id, version: rec.record.version, reason });
    if (r.ok) { recFor = ''; pending = null; panel = ''; ctx.say('記録を無効にしました', 'ok'); } else ctx.say(r.error.message, 'error');
    return true;
  }
  if (a === 'rec-close') { panel = ''; return true; }
  if (a === 'chk-set') { const cur = (rec.draftChecks || {})[b.dataset.id] || ''; rec.draftChecks = { ...(rec.draftChecks || {}), [b.dataset.id]: cur === b.dataset.v ? '' : b.dataset.v }; return true; }
  if (a === 'hw-open') { hwOpen = b.dataset.id; ctx.say(''); return true; }
  if (a === 'hw-close') { hwOpen = ''; return true; }
  if (a === 'hw-add') { hwRows.push({ kind: 'homework', title: '', material: (hwRows.at(-1) || {}).material || '', dueMode: 'nextLesson', dueSubject: rec.lesson.subject, dueDate: '' }); return true; } // 同じ教材が続くことが多いので前の行の教材を入れておく
  if (a === 'hw-remove') { hwRows.splice(Number(b.dataset.i), 1); return true; }
  if (a === 'rg-add') { rgRows.push({ material: (rgRows.at(-1) || {}).material || '', text: '' }); return true; }
  if (a === 'rg-remove') { rgRows.splice(Number(b.dataset.i), 1); if (!rgRows.length) rgRows.push({ material: '', text: '' }); return true; }
  if (a === 'ho-read' || a === 'ho-close') { const r = await ctx.call(a === 'ho-read' ? 'handover/read' : 'handover/close', { id: b.dataset.id }); if (r.ok) { await refreshHandover(ctx); pending = null; } else ctx.say(r.error.message, 'error'); return true; }
  return false;
}
