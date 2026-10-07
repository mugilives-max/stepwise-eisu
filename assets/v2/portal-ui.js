// 保護者・生徒の画面で共通に使う部品（作り直し v2）。
// 考え方（docs/UX_STRUCTURE.md 1）: 一覧は白い枠に 1 件 1 行、操作は押すと下から出る画面で。文字より印で分かるように。
// - 授業の一覧（日付ごと）と、授業を押したときの画面（変更・お休み・キャンセルの連絡）
// - 宿題の一覧（左の丸を押して「できた」）
// - 授業の記録（1 件 1 枚。保護者への一言は目立たせる）
// - 授業計画（月ごとに 1 枚。承認は月に 1 回）、請求、キャンセル料
// - テスト・行事
import { esc } from '/assets/v2/api.js';
import { mdw, endOf, STATUS, REQUEST, choiceOf, EVENT_KIND, eventForm } from '/assets/v2/schedule-view.js?v=20261008-launch1';
import { hwText, hwSubject } from '/assets/v2/learning-view.js?v=20261008-launch1';
import { partText } from '/assets/v2/cancel-rate.js?v=20261008-launch1';
import { sheet, ICON } from '/staff/ui.js?v=20261008-launch1';

export const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
export const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
export const monthLabel = m => `${Number(m.slice(5, 7))}月`;
export const given = name => String(name || '').split(' ').pop();
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const wd = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
export const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
export { sheet, ICON };
export const PORTAL_ICON = {
  ...ICON,
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
  book: '<path d="M4 6c2.5-1.2 5.3-1.2 8 .8 2.7-2 5.5-2 8-.8v12c-2.5-1.2-5.3-1.2-8 .8-2.7-2-5.5-2-8-.8z"/><path d="M12 6.8v12"/>',
  flag: '<path d="M6 21V4.5h10.5l-2 3.8 2 3.7H6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
export const picon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${PORTAL_ICON[k] || ''}</svg>`;
export const ibox = (k, color, label = '') => `<span class="ibox" style="background:${color}" role="img" aria-label="${esc(label)}">${picon(k)}</span>`;

// 日数の言い方（今日・明日・あと n 日）
export function daysText(date, today) {
  const n = Math.round((Date.parse(date) - Date.parse(today)) / 86400e3);
  return n === 0 ? '今日' : n === 1 ? '明日' : n > 1 ? `あと${n}日` : '';
}

// ---- 授業 ----
const openRequest = l => (l.requests || []).find(r => r.status === 'open');
const statusText = l => {
  const r = openRequest(l);
  if (r) return [`<span class="tag ${r.kind === 'cancel' ? 'danger' : 'warn'}">${REQUEST[r.kind]}・先生の返事待ち</span>`];
  const [cls, label] = STATUS[l.status] || ['gray', l.status];
  const t = [];
  if (l.status === 'proposed') t.push(`<span class="tag warn">仮予定${l.confirmBy ? '・' + md(l.confirmBy) + 'まで' : ''}</span>`);
  else if (l.status !== 'decided') t.push(`<span class="tag ${cls}">${label}</span>`);
  return t;
};
// 日付ごとにまとめた授業の一覧（白い枠）。行を押すと data-action="lesson" で下から出る画面
export function lessonRows(lessons, { names = {}, today = '', emptyText = 'これからの授業はありません。' } = {}) {
  if (!lessons.length) return `<p class="muted small">${emptyText}</p>`;
  let h = '', last = '';
  for (const l of lessons) {
    if (l.date !== last) { if (last) h += '</div>'; h += `<div class="day-head2${l.date === today ? ' today' : ''}">${mdw(l.date)}${l.date === today ? '<small>今日</small>' : ''}</div><div class="group">`; last = l.date; }
    const faded = ['rested', 'cancelled'].includes(l.status);
    h += `<button type="button" class="lrow pl${faded ? ' faded' : ''}" data-action="lesson" data-id="${esc(l.id)}"><span class="t">${l.start}<small>〜${endOf(l.start, l.minutes)}</small></span>
      <span class="b"><span class="nm">${names[l.studentId] ? `<b>${esc(given(names[l.studentId]))}</b> ` : ''}${esc(l.subject)}${l.kind && l.kind !== '通常' ? `<small>（${esc(l.kind)}）</small>` : ''}${l.deliveryMode === 'online' ? '<small class="muted">・オンライン</small>' : ''}</span>
      <span class="tags">${statusText(l).join('')}</span></span><span class="go">›</span></button>`;
  }
  return h + '</div>';
}
// 次の授業（ホームの一番上）。押すと同じ下から出る画面
export function nextLessonHero(l, { names = {}, today = '' } = {}) {
  if (!l) return '<div class="hero empty"><span class="k">次の授業</span><strong>まだ決まっていません</strong></div>';
  const when = daysText(l.date, today);
  return `<button type="button" class="hero" data-action="lesson" data-id="${esc(l.id)}"><span class="k">次の授業${when ? `<b>${when}</b>` : ''}</span>
    <strong>${md(l.date)}<small>（${wd(l.date)}）</small> ${l.start}<small>〜${endOf(l.start, l.minutes)}</small></strong>
    <span class="s">${names[l.studentId] ? esc(given(names[l.studentId])) + '　' : ''}${esc(l.subject)}${l.deliveryMode === 'online' ? '・オンライン' : '・教室'}${l.status === 'proposed' ? '<span class="tag warn">仮予定</span>' : ''}</span></button>`;
}
// 授業を押したときの画面。state: { id, pick, note }。canRequest=false なら見るだけ
export function lessonSheet(l, state, { names = {}, canRequest = true, busy = false, sendLabel = '連絡する' } = {}) {
  const title = `${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}`;
  const req = openRequest(l);
  let body = `<div class="ls-head"><strong>${names[l.studentId] ? esc(names[l.studentId]) + '　' : ''}${esc(l.subject)}${l.kind && l.kind !== '通常' ? `（${esc(l.kind)}）` : ''}</strong><span class="small muted">${l.deliveryMode === 'online' ? 'オンライン' : '教室で'}${l.minutes ? `・${l.minutes}分` : ''}</span><span class="tags">${statusText(l).join('') || '<span class="tag">決定</span>'}</span></div>`;
  if (l.meetUrl && l.status === 'decided') body += `<a class="btn wide" href="${esc(l.meetUrl)}" target="_blank" rel="noopener">${picon('video')} Meet に参加する</a>`;
  if (req) {
    body += `<div class="ls-req"><div><b>${REQUEST[req.kind]}</b>を連絡済みです${req.note ? `<div class="small muted">${esc(req.note)}</div>` : ''}<div class="small muted">先生の返事をお待ちください。</div></div>${canRequest ? `<button data-action="withdraw" data-id="${esc(req.id)}"${busy ? ' disabled' : ''}>連絡を取り下げる</button>` : ''}</div>`;
    return sheet(esc, title, body, 'close-sheet');
  }
  const choices = canRequest ? (l.choices || []) : [];
  if (!choices.length) {
    body += `<p class="small muted">${!canRequest ? '予定の変更・お休みの連絡は、保護者の方からお願いします。' : ['rested', 'cancelled', 'done'].includes(l.status) ? 'この授業は' + (STATUS[l.status] || [])[1] + 'です。' : '授業が始まっているため、ここからは連絡できません。先生に直接お知らせください。'}</p>`;
    return sheet(esc, title, body, 'close-sheet');
  }
  body += `<h3>連絡する</h3><div class="choice-list">` + choices.map(c => { const [label, cost, how] = choiceOf(l, c); const on = state.pick === c;
    return `<button type="button" class="choice${on ? ' on' : ''}${c === 'cancel' ? ' danger' : ''}" data-action="pick" data-c="${c}" aria-pressed="${on}"><span class="b"><b>${esc(label)}</b>${on ? `<small>${esc(how)}</small>` : ''}</span><span class="cost">${esc(cost)}</span></button>`; }).join('') + '</div>';
  if (state.pick) {
    const offerRest = state.pick === 'rest' && l.status === 'proposed';
    body += offerRest ? '<p class="small muted">この仮予定をお休みにします。料金はかかりません。</p>' : `<input id="change-note" maxlength="500" value="${esc(state.note || '')}" placeholder="${esc(choiceOf(l, state.pick)[3])}" autocomplete="off">`;
    body += `<div class="row" style="margin-top:10px"><button class="${state.pick === 'cancel' ? 'danger' : 'primary'} wide" data-action="send-change"${busy ? ' disabled' : ''}>${busy ? '送っています…' : sendLabel}</button></div>`;
  }
  return sheet(esc, title, body, 'close-sheet');
}

// ---- 宿題 ----
// 1 件 1 行。左の丸を押して「できた」。先生が確認すると緑の ✓
export function homeworkRows(list, { names = {}, canReport = true, emptyText = '今やる宿題はありません。' } = {}) {
  if (!list.length) return `<p class="muted small">${emptyText}</p>`;
  return '<div class="group">' + list.map(w => {
    const st = w.status, sub = hwSubject(w);
    const due = w.dueMode === 'none' ? '' : w.due ? `${md(w.due)}(${wd(w.due)})まで` : w.dueMode === 'nextLesson' ? '次の授業まで' : '';
    const check = w.checkResult === 'partial' && st === 'open' ? '<span class="tag warn">前回は一部だけ</span>' : w.checkResult === 'notDone' && st === 'open' ? '<span class="tag danger">前回はできていない</span>' : '';
    const btn = st === 'confirmed' ? `<span class="hw-dot done" role="img" aria-label="先生が確認しました">${picon('check')}</span>`
      : !canReport ? `<span class="hw-dot${st === 'reported' ? ' on' : ''}" role="img" aria-label="${st === 'reported' ? 'できたと報告済み' : '未完了'}">${st === 'reported' ? picon('check') : ''}</span>`
      : st === 'reported' ? `<button type="button" class="hw-dot on" data-action="hw-undo" data-id="${esc(w.id)}" aria-label="できたの報告を取り消す">${picon('check')}</button>`
      : `<button type="button" class="hw-dot" data-action="hw-done" data-id="${esc(w.id)}" aria-label="できた"></button>`;
    return `<div class="hw${st !== 'open' ? ' ' + st : ''}">${btn}<span class="b"><span class="nm">${esc(hwText(w))}</span><small>${names[w.studentId] ? esc(given(names[w.studentId])) + '・' : ''}${sub ? esc(sub) + '・' : ''}${esc(due)}${st === 'reported' ? '・先生の確認待ち' : ''}${check ? ' ' + check : ''}${w.reviewNote && st === 'open' ? `<span class="note">先生から: ${esc(w.reviewNote)}</span>` : ''}</small></span></div>`;
  }).join('') + '</div>';
}

// ---- 授業の記録（1 件 1 枚） ----
const CHECK_TEXT = { done: ['ok', 'やってきた'], partial: ['warn', '一部だけ'], notDone: ['danger', 'やってこなかった'] };
export function recordCards(records, homework = [], { names = {}, limit = 0 } = {}) {
  const list = limit ? records.slice(0, limit) : records;
  if (!list.length) return '<p class="muted small">公開された授業の記録はまだありません。</p>';
  return list.map(r => {
    const checks = homework.filter(w => w.checkedRecordId === r.id && CHECK_TEXT[w.checkResult]);
    return `<article class="rcard"><div class="rc-head"><strong>${md(r.date)}<small>（${wd(r.date)}）</small> ${esc(r.subject)}${r.kind && r.kind !== '通常' ? `<small>（${esc(r.kind)}）</small>` : ''}</strong>${names[r.studentId] ? `<span class="tag gray">${esc(given(names[r.studentId]))}</span>` : ''}</div>
      ${r.range ? `<div class="rc-line">${ibox('book', '#2f6fde', '扱った範囲')}<span>${esc(r.range)}</span></div>` : ''}
      ${r.comment ? `<div class="rc-line">${ibox('comment', '#5b6672', '授業の様子')}<span class="pre">${esc(r.comment)}</span></div>` : ''}
      ${r.parentMessage ? `<div class="rc-line pm">${ibox('parent', '#138a8a', '保護者の方へ')}<span class="pre"><b>保護者の方へ</b>${esc(r.parentMessage)}</span></div>` : ''}
      ${checks.length ? `<div class="rc-line">${ibox('homework', '#7b4fd6', '宿題のチェック')}<span class="chk-list">${checks.map(w => `<span>${esc(hwText(w))} <span class="tag ${CHECK_TEXT[w.checkResult][0]}">${CHECK_TEXT[w.checkResult][1]}</span></span>`).join('')}</span></div>` : ''}
    </article>`;
  }).join('');
}

// ---- 授業計画（月ごとに 1 枚） ----
const planMonth = l => l.startDate.slice(0, 7);
const groupByMonth = lines => { const m = new Map(); for (const l of lines) { const k = planMonth(l); if (!m.has(k)) m.set(k, []); m.get(k).push(l); } return [...m.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1); };
const lineLabel = (l, multi) => `${multi ? `<b>${esc(given(l.studentName))}</b> ` : ''}${esc(l.subject)}${l.kind !== '通常' ? `（${esc(l.kind)}）` : ''}${l.parentId ? ' <span class="tag">追加</span>' : ''}${l.comment ? `<small class="muted">${esc(l.comment)}</small>` : ''}`;
const period = l => l.startDate.slice(8) === '01' && Number(l.endDate.slice(8)) >= 28 && l.startDate.slice(0, 7) === l.endDate.slice(0, 7) ? '' : `${md(l.startDate)}〜${md(l.endDate)}`;
// 承認をお願いしている月。counts: { [lineId]: 承認する回数 }（画面で変えた値）
export function planApprovalCard(month, lines, { multi, counts = {}, dis = '' }) {
  const n = l => counts[l.id] === undefined ? l.count : counts[l.id];
  const total = lines.reduce((s, l) => s + n(l) * l.fee, 0);
  const rows = lines.map(l => `<div class="pl"><span class="b">${lineLabel(l, multi)}${period(l) ? `<small class="muted">${period(l)}</small>` : ''}</span>
      <span class="n"><select name="count-${esc(l.id)}" data-plan-count="${esc(l.id)}" aria-label="回数">${Array.from({ length: l.count - l.minCount + 1 }, (_, i) => l.count - i).map(k => `<option value="${k}"${n(l) === k ? ' selected' : ''}>${k}回</option>`).join('')}${l.minCount === 0 ? `<option value="0"${n(l) === 0 ? ' selected' : ''}>見送る</option>` : ''}</select><small>1回 ${esc(l.minutes)}分・${yen(l.fee)}</small></span>
      <span class="amt">${yen(n(l) * l.fee)}</span></div>${l.minCount ? `<div class="small muted pl-note">すでに決まっている授業が${l.minCount}回あるため、${l.minCount}回より少なくはできません。</div>` : ''}`).join('');
  return `<form class="pcard ask" data-form="plan-approve" data-month="${esc(month)}"><div class="pc-head"><strong>${monthLabel(month)}の授業計画</strong><span class="tag warn">承認をお願いします</span></div>
    <div class="pl-list">${rows}</div><div class="pc-total"><span>合計（見込み）</span><strong>${yen(total)}</strong></div>
    <p class="small muted">回数を減らしたいときは、各行の回数を変えてから承認してください。承認すると、この回数で授業を進めます。</p>
    <button class="primary wide"${dis}>この内容で承認する</button></form>`;
}
// 先生が記録した承諾（LINE など）を確かめてもらう月
export function planAckCard(month, lines, { multi, dis = '' }) {
  const via = lines[0].approvedVia, date = lines[0].consentDate;
  const rows = lines.map(l => `<div class="pl"><span class="b">${lineLabel(l, multi)}</span><span class="n"><small>${l.approvedCount}回・1回 ${yen(l.fee)}</small></span><span class="amt">${yen(l.approvedCount * l.fee)}</span></div>`).join('');
  const total = lines.reduce((s, l) => s + l.approvedCount * l.fee, 0);
  return `<div class="pcard ack" data-month="${esc(month)}"><div class="pc-head"><strong>${monthLabel(month)}の授業計画</strong><span class="tag">確かめてください</span></div>
    <p class="small muted">${esc(via)}で承諾いただいた内容を、先生が記録しました（${esc(date)}）。</p>
    <div class="pl-list">${rows}</div><div class="pc-total"><span>合計（見込み）</span><strong>${yen(total)}</strong></div>
    <div class="row"><button class="primary" data-action="plan-ack-month" data-month="${esc(month)}"${dis}>この内容で合っています</button><button data-action="plan-inquiry" data-month="${esc(month)}"${dis}>違うところがある</button></div></div>`;
}
// 決まった計画の一覧（月ごと）
export function planHistory(lines, { multi }) {
  const groups = groupByMonth(lines);
  if (!groups.length) return '';
  return '<div class="group">' + groups.map(([m, ls]) => {
    const total = ls.reduce((s, l) => s + (l.status === 'approved' ? l.approvedCount * l.fee : 0), 0);
    return `<details class="ph"><summary><span class="b"><b>${monthLabel(m)}</b><small>${ls.map(l => `${multi ? given(l.studentName) + ' ' : ''}${l.subject}${l.status === 'approved' ? ` ${l.approvedCount}回` : '（見送り）'}`).map(esc).join('・')}</small></span><span class="amt">${yen(total)}</span></summary>
      <div class="pl-list">${ls.map(l => `<div class="pl"><span class="b">${lineLabel(l, multi)}</span><span class="n"><small>${l.status === 'approved' ? `${l.approvedCount}回・1回 ${yen(l.fee)}<br>${esc(l.consentDate)}・${esc(l.approvedVia)}${l.familyAck === 'inquiry' ? '・問い合わせ中' : ''}` : '見送り'}</small></span><span class="amt">${l.status === 'approved' ? yen(l.approvedCount * l.fee) : ''}</span></div>`).join('')}</div></details>`;
  }).join('') + '</div>';
}
export function planGroups(plans) {
  const asks = plans.filter(l => l.status === 'proposed'), acks = plans.filter(l => l.status === 'approved' && l.approvedBy === 'staff' && !l.familyAck);
  const others = plans.filter(l => !asks.includes(l) && !acks.includes(l));
  return { asks: groupByMonth(asks), acks: groupByMonth(acks), others };
}
export const inquirySheet = (month, note, busy) => sheet(esc, `${monthLabel(month)}の授業計画について`, `<p class="small muted">違うところや確かめたいことを書いてください。先生に届きます。</p><textarea id="inquiry-note" rows="3" maxlength="500" placeholder="例: 英語は 4 回ではなく 3 回で話していました">${esc(note || '')}</textarea><div class="row" style="margin-top:10px"><button class="primary wide" data-action="send-inquiry" data-month="${esc(month)}"${busy ? ' disabled' : ''}>${busy ? '送っています…' : '先生に伝える'}</button></div>`, 'close-sheet');

// ---- 請求 ----
const INV = { confirmed: ['お支払い待ち', 'warn'], reported: ['入金の確認待ち', ''], paid: ['お支払い済み', 'ok'] };
export function invoiceRows(invoices) {
  if (!invoices.length) return '<p class="muted small">まだ請求はありません。実施した授業の分を、翌月3日に確定してお知らせします。</p>';
  return '<div class="group">' + invoices.map(v => { const [label, cls] = INV[v.status] || [v.status, ''];
    return `<button type="button" class="irow" data-action="invoice" data-id="${esc(v.id)}"><span class="b"><b>${v.month.slice(0, 4)}年${monthLabel(v.month)}分</b><small><span class="tag ${cls}">${label}</span>${v.status === 'paid' && v.paidOn ? ` ${md(v.paidOn)}` : ''}</small></span><span class="amt">${yen(v.total)}</span><span class="go">›</span></button>`; }).join('') + '</div>';
}
export function invoiceSheet(v, { multi, busy = false }) {
  const [label, cls] = INV[v.status] || [v.status, ''], by = {};
  for (const i of v.items) (by[i.studentName] = by[i.studentName] || []).push(i);
  let body = `<div class="inv-total"><span class="tag ${cls}">${label}</span><strong>${yen(v.total)}</strong></div>`;
  body += Object.entries(by).map(([name, items]) => `${multi ? `<h3>${esc(name)}</h3>` : ''}<table class="itbl">${items.map(i => `<tr><td>${i.date ? md(i.date) : ''}</td><td>${esc(i.subject)}${i.label ? `<small class="muted"> ${esc(i.label)}</small>` : ''}</td><td class="r">${i.kind === 'lesson' && i.minutes ? i.minutes + '分' : ''}</td><td class="r">${yen(i.amount)}</td></tr>`).join('')}</table>`).join('');
  if (v.status === 'confirmed') body += `<p class="small muted">お振込のあと、下のボタンで知らせてください。先生が入金を確かめます。</p><button class="primary wide" data-action="inv-report" data-id="${esc(v.id)}" data-version="${v.version}"${busy ? ' disabled' : ''}>振り込みました</button>`;
  else if (v.status === 'reported') body += '<p class="small muted">振込のご連絡ありがとうございます。先生が入金を確かめます。</p>';
  else if (v.status === 'paid') body += `<p class="small muted">入金を確認しました（${esc(v.paidOn)}）。ありがとうございました。</p>`;
  return sheet(esc, `${v.month.slice(0, 4)}年${monthLabel(v.month)}分の授業料`, body, 'close-sheet');
}

// ---- キャンセル料 ----
export function feeRows(fees, { multi }) {
  if (!fees.length) return '';
  return '<div class="group">' + fees.map(f => `<button type="button" class="irow" data-action="fee" data-id="${esc(f.id)}"><span class="b"><b>${md(f.date)} ${esc(f.start)} ${multi ? esc(given(f.studentName)) + ' ' : ''}${esc(f.subject)}</b><small>${f.invoiceId ? '請求済み' : f.reliefStatus === 'pending' ? '減額・免除を申請中' : f.reliefStatus ? '申請に回答あり' : '次の請求に入ります'}</small></span><span class="amt">${yen(f.amount)}</span><span class="go">›</span></button>`).join('') + '</div>';
}
export function feeSheet(f, { busy = false, note = '' }) {
  let body = `<div class="inv-total"><span class="small muted">${(f.parts || []).length ? f.parts.map(p => esc(partText(p, f.date))).join('<br>') : 'キャンセル料'}</span><strong>${yen(f.amount)}</strong></div>`;
  if (f.note) body += `<p class="small muted">${esc(f.note)}</p>`;
  if (f.reliefStatus === 'pending') body += '<p class="small">減額・免除の申請を受け付けました。先生からの回答をお待ちください。</p>';
  else if (f.reliefStatus) body += `<p class="small">申請への回答: ${esc(f.reliefResponse)}</p>`;
  else if (!f.invoiceId && f.amount > 0) body += `<h3>減額・免除を申請する</h3><p class="small muted">急な病気で受診した、電車の運休など、やむを得ない事情のときに申請できます。</p><textarea id="relief-note" rows="2" maxlength="1000" placeholder="事情を書いてください（例: 急に熱が出て受診したため）">${esc(note)}</textarea><div class="row" style="margin-top:10px"><button class="primary wide" data-action="send-relief" data-id="${esc(f.id)}" data-version="${f.version}"${busy ? ' disabled' : ''}>${busy ? '送っています…' : '申請する'}</button></div>`;
  return sheet(esc, `${mdw(f.date)} ${esc(f.subject)} のキャンセル料`, body, 'close-sheet');
}

// ---- テスト・行事 ----
export function eventRows(events, { names = {}, canDelete = () => false, today = '' } = {}) {
  if (!events.length) return '<p class="muted small">知らせた予定はありません。</p>';
  return '<div class="group">' + events.map(e => `<div class="evrow"><span class="t">${md(e.date)}<small>${wd(e.date)}${e.dateTo !== e.date ? '〜' + md(e.dateTo) : ''}</small></span><span class="b"><span class="nm">${esc(e.title || EVENT_KIND[e.kind])}</span><small>${names[e.studentId] ? esc(given(names[e.studentId])) + '・' : ''}${EVENT_KIND[e.kind]}${e.start ? '・' + e.start + '〜' + e.end : ''}${e.date >= today && daysText(e.date, today) ? '・' + daysText(e.date, today) : ''}</small></span>${canDelete(e) ? `<button type="button" class="x" data-action="del-event" data-id="${esc(e.id)}" aria-label="消す">${picon('x')}</button>` : '<span></span>'}</div>`).join('') + '</div>';
}
export const eventSheet = students => sheet(esc, 'テスト・行事を知らせる', `<p class="small muted">テスト・行事・授業ができない日を知らせると、先生が予定を作るときの参考にします。</p>${eventForm(students)}`, 'close-sheet');

// 下から出る画面の共通の動き: Esc で閉じる、閉じるときは滑って戻る（スタッフの画面と同じ）
export function wireSheets(app, { reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches } = {}) {
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { const x = app.querySelector('.bsheet-head button.icon'); if (x) x.click(); } });
  let pass = false;
  document.addEventListener('click', ev => {
    if (pass || reduced()) return;
    const closer = ev.target.closest('.overlay, .bsheet-head [data-action]'); if (!closer) return;
    const box = document.querySelector('.bsheet'); if (!box) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    box.classList.add('closing'); document.querySelectorAll('.overlay').forEach(o => o.classList.add('closing'));
    setTimeout(() => { pass = true; closer.click(); pass = false; }, 210);
  }, true);
}
// 描き直しても開いている下から出る画面は動かさない（中のスクロールも保つ）
export function keepSheet(app, draw) {
  const was = app.querySelector('.bsheet'), label = was && was.getAttribute('aria-label'), top = was ? was.scrollTop : 0;
  draw();
  const now = app.querySelector('.bsheet');
  if (now && label === now.getAttribute('aria-label')) { now.classList.add('still'); now.scrollTop = top; }
}
