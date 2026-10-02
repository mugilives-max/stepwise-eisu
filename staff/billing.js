// スタッフの画面: 授業計画（#plans）と請求（#billing、キャンセル料を含む）。5段目。教室管理者だけ。設定の「授業の種類と標準料金」（#kinds）も。
// 計画は月ごとに生徒の行を並べる。請求は月ごとに家族の行を並べ、開くと内訳。
import { sheet, rowButton } from '/staff/ui.js?v=20261003-ux19';
// 下から出る画面: lineOpen（計画の行）・editing（直す）・consentFor（承諾を記録）・addFor（足す）・openFamily（請求の内訳）・feeOpen（キャンセル料）
let plans = null, planMonth = '', editing = '', consentFor = '', addFor = '', kindOpen = null, lineOpen = '', feeOpen = '';
let bill = null, billMonth = '', openFamily = '', detail = null, fees = null;
export function leaveBilling() { kindOpen = null; lineOpen = editing = consentFor = addFor = openFamily = feeOpen = ''; }
export function resetBilling() { kindOpen = null; lineOpen = feeOpen = ''; plans = null; bill = null; detail = null; fees = null; editing = ''; consentFor = ''; addFor = ''; openFamily = ''; }

const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const thisMonth = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const monthEnd = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const monthLabel = m => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const LINE_STATUS = { draft: ['下書き', 'gray'], proposed: ['承認待ち', 'warn'], approved: ['承認', 'ok'], declined: ['見送り', 'gray'] };
const INV_STATUS = { confirmed: ['お支払い待ち', 'warn'], reported: ['振込の連絡あり', 'warn'], paid: ['入金済み', 'ok'], void: ['取消', 'gray'] };
const FEE_TYPE = { late: '開始前の連絡', noshow: '開始後・連絡なし' };
const monthPicker = (m, action) => `<div class="row"><button data-action="${action}" data-d="-1">◀</button><strong style="min-width:8em;text-align:center">${monthLabel(m)}</strong><button data-action="${action}" data-d="1">▶</button></div>`;

// ---------- 計画 ----------
function needPlans(ctx) {
  if (!planMonth) planMonth = shift(thisMonth(), new Date(Date.now() + 9 * 3600e3).getUTCDate() >= 15 ? 1 : 0);
  if (!plans || plans.month !== planMonth) {
    const want = planMonth; plans = { month: want, loading: true };
    ctx.call('billing/plans/list', { month: want }).then(r => { if (planMonth !== want) return; plans = r.ok ? r : { month: want, students: [], kinds: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); });
  }
}
export function plansPage(ctx) {
  const { esc } = ctx;
  needPlans(ctx);
  let h = `<div class="page-head"><h1>授業計画</h1></div><p class="sub" style="margin-top:0">月ごとの授業計画（科目・回数・1回の時間・1回の授業料）。下書きを作って家族にお知らせし、保護者が承認します。料金は承認した計画で決まります。</p>${ctx.notice()}${monthPicker(planMonth, 'pl-month')}`;
  if (plans.loading) return h + '<p class="muted">読み込んでいます…</p>';
  h += `<p><button data-action="pl-copy"${ctx.dis()}>先月と同じ内容で下書きを作る（在籍の全員）</button></p>`;
  const byFamily = {};
  for (const s of plans.students) (byFamily[s.familyId] = byFamily[s.familyId] || []).push(s);
  for (const group of Object.values(byFamily)) {
    const drafts = group.reduce((n, s) => n + s.lines.filter(l => l.status === 'draft').length, 0);
    const asks = group.flatMap(s => s.lines.filter(l => l.status === 'proposed')), last = asks.map(l => l.remindedAt).filter(Boolean).sort().at(-1) || '';
    h += `<div class="sheet stack"><div class="row" style="justify-content:space-between"><strong>${esc(group[0].familyLabel)}</strong><div class="row">${drafts ? `<button class="primary" data-action="pl-send" data-family="${esc(group[0].familyId)}"${ctx.dis()}>下書き ${drafts}件をお知らせする</button>` : ''}${asks.length ? remindButton(ctx, group[0].familyId, asks.length, last) : ''}</div></div>`;
    for (const s of group) h += studentPlans(ctx, s);
    h += '</div>';
  }
  if (!plans.students.length) h += '<p class="muted">在籍の生徒がいません。</p>';
  h += planSheet(ctx);
  h += '<p class="small muted" style="margin-top:16px">授業の種類と標準料金は「設定」にあります（<a href="#kinds">開く</a>）。</p>';
  return h;
}
function studentPlans(ctx, s) {
  const { esc } = ctx;
  let h = `<div><h3 style="margin:8px 0 4px">${esc(s.name)} <span class="small muted">基本単価 ${yen(s.baseRate30)}/30分${s.status === 'paused' ? '・休会' : ''}</span></h3>`;
  if (s.unplanned) h += `<p class="small notice">計画に入っていない授業が ${s.unplanned}件あります（承認がないと請求できません）。</p>`;
  if (s.lines.length) h += '<div class="rows">' + s.lines.map(l => lineRow(ctx, s, l)).join('') + '</div>';
  else h += '<p class="small muted">この月の計画はまだありません。</p>';
  h += `<p style="margin:6px 0 4px"><button class="small-btn" data-action="pl-add" data-id="${esc(s.id)}"${ctx.dis()}>＋ 計画を足す</button></p>`;
  return h + '</div>';
}
const lineCount = l => l.status === 'approved' && l.approvedCount !== l.count ? `${l.approvedCount}回（お知らせ ${l.count}回）` : `${l.count}回`;
const lineWhole = l => l.startDate === plans.month + '-01' && l.endDate === monthEnd(plans.month);
function lineRow(ctx, s, l) {
  const { esc } = ctx, [label, cls] = LINE_STATUS[l.status];
  return rowButton(esc, 'pl-line', { id: l.id }, `${esc(l.subject)}${l.kind !== '通常' ? ` <span class="tag gray">${esc(l.kind)}</span>` : ''}${l.parentId ? ' <span class="tag">追加</span>' : ''} <span class="tag ${cls}">${label}</span>`,
    `${lineWhole(l) ? '' : md(l.startDate) + '〜' + md(l.endDate) + '・'}${lineCount(l)}・1回 ${l.minutes}分 ${yen(l.fee)}・決定・実施 ${l.assigned}回${l.tentative ? `・仮予定 ${l.tentative}回` : ''}${l.familyAck === 'inquiry' ? '・<strong style="color:var(--danger)">保護者から問い合わせ</strong>' : ''}`);
}
// 計画の行を押したとき・直す・承諾を記録・足す（下から出る画面）
function planSheet(ctx) {
  const { esc } = ctx;
  const find = id => { for (const s of plans.students) { const l = s.lines.find(x => x.id === id); if (l) return [s, l]; } return []; };
  if (addFor) { const s = plans.students.find(x => x.id === addFor); return s ? sheet(esc, s.name + ' の計画を足す', lineForm(ctx, s, null), 'pl-close') : ''; }
  if (editing) { const [s, l] = find(editing); return l ? sheet(esc, `${s.name} ${l.subject} を直す`, lineForm(ctx, s, l), 'pl-close') : ''; }
  if (consentFor) {
    const [s, l] = find(consentFor); if (!l) return '';
    return sheet(esc, `${s.name} ${l.subject} の承諾を記録`, `<form class="stack" data-form="pl-consent" data-id="${esc(l.id)}" data-version="${l.version}"><div class="small muted">LINE・電話・対面で承諾をもらったときに記録します。保護者ページにも出て、保護者が確かめられます。</div>
      <div class="row"><label style="flex:1">承諾をもらった日<input type="date" name="consentDate" required></label><label style="flex:1">方法<input name="via" maxlength="40" placeholder="LINE・電話・対面" required></label></div><label>回数<input type="number" name="approvedCount" min="1" max="${l.count}" value="${l.count}" style="width:6em"></label>
      <label>メモ（授業のあとで承諾をもらったときは必須）<input name="note" maxlength="300"></label><div class="row"><button class="primary"${ctx.dis()}>承認として記録</button><button type="button" data-action="pl-close"${ctx.dis()}>やめる</button></div></form>`, 'pl-close');
  }
  if (!lineOpen) return '';
  const [s, l] = find(lineOpen); if (!l) return '';
  const [label, cls] = LINE_STATUS[l.status];
  let body = `<p style="margin-top:0"><span class="tag ${cls}">${label}</span>${l.kind !== '通常' ? ` <span class="tag gray">${esc(l.kind)}</span>` : ''}${l.parentId ? ' <span class="tag">追加</span>' : ''}</p>
    <div class="small">${md(l.startDate)}〜${md(l.endDate)}・${lineCount(l)}・1回 ${l.minutes}分 ${yen(l.fee)}</div><div class="small muted">決定・実施 ${l.assigned}回${l.tentative ? `・仮予定 ${l.tentative}回` : ''}</div>`;
  if (l.comment) body += `<div class="small" style="margin-top:6px">保護者への説明: ${esc(l.comment)}</div>`;
  if (l.status === 'approved' || l.status === 'declined') body += `<div class="small muted" style="margin-top:6px">${l.approvedBy === 'family' ? '保護者ページで' : esc(l.approvedVia) + 'で'}${l.status === 'approved' ? '承認' : '見送り'}（${esc(l.consentDate)}）${l.approvalNote ? '・' + esc(l.approvalNote) : ''}${l.familyAck === 'confirmed' ? '・保護者が確認済み' : l.familyAck === 'inquiry' ? '' : l.approvedBy === 'staff' ? '・保護者の確認待ち' : ''}</div>`;
  if (l.familyAck === 'inquiry') body += `<p class="notice error small">保護者から問い合わせ: ${esc(l.familyAckNote)}</p>`;
  body += `<div class="row" style="margin-top:14px">${l.locked ? '<span class="small muted">請求済みの授業があるので直せません</span>' : `<button data-action="pl-edit" data-id="${esc(l.id)}"${ctx.dis()}>直す</button>`}
    ${l.status !== 'approved' ? `<button data-action="pl-consent" data-id="${esc(l.id)}"${ctx.dis()}>承諾を記録</button>` : ''}
    ${l.locked ? '' : `<button class="danger" data-action="pl-delete" data-id="${esc(l.id)}" data-version="${l.version}"${ctx.dis()}>消す</button>`}</div>`;
  return sheet(esc, `${s.name} ${l.subject}`, body, 'pl-close');
}
// 承認のお願いを送るボタン（計画・請求の画面で共通）。同じ家族に1日1回まで
function remindButton(ctx, familyId, n, last) {
  return `<button data-action="pl-remind" data-family="${ctx.esc(familyId)}"${ctx.dis()}>承認のお願いを送る（${n}件）</button>${last ? `<span class="small muted">前回 ${md(new Date(Date.parse(last) + 9 * 3600e3).toISOString().slice(0, 10))}</span>` : ''}`;
}
// 計画の行の入力欄（新しく足す・直す）。初期値は授業の種類の標準 → 基本単価
function lineForm(ctx, s, l) {
  const { esc } = ctx, kinds = plans.kinds.filter(k => k.active || (l && k.name === l.kind));
  const std = kinds.find(k => k.name === (l ? l.kind : '通常')) || {};
  const minutes = l ? l.minutes : std.standardMinutes || 60, fee = l ? l.fee : std.standardFee || Math.round(s.baseRate30 * minutes / 30);
  const parents = s.lines.filter(x => !x.parentId && x.status !== 'declined' && (!l || x.id !== l.id));
  return `<form class="stack" data-form="pl-save" data-student="${esc(s.id)}"${l ? ` data-id="${esc(l.id)}" data-version="${l.version}"` : ''}>
    ${l && l.status !== 'draft' ? '<p class="small notice">直すと承認は消えて下書きに戻ります。もう一度お知らせしてください。</p>' : ''}
    <div class="row"><label style="flex:1">科目<input name="subject" maxlength="30" value="${esc(l ? l.subject : '')}" required></label>
    <label>種類<select name="kind">${(kinds.length ? kinds : [{ name: '通常' }]).map(k => `<option${(l ? l.kind : '通常') === k.name ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>
    <label>回数<input type="number" name="count" min="1" max="60" value="${l ? l.count : 4}" style="width:5em" required></label>
    <label>1回の時間（分）<input type="number" name="minutes" min="15" max="300" step="15" value="${minutes}" style="width:6em" required></label>
    <label>1回の授業料（円）<input type="number" name="fee" min="0" max="100000" value="${fee}" style="width:7em" required></label></div>
    <div class="small muted">基本単価なら 60分 ${yen(s.baseRate30 * 2)}・90分 ${yen(s.baseRate30 * 3)}・120分 ${yen(s.baseRate30 * 4)}</div>
    <div class="row"><label>期間<input type="date" name="startDate" value="${l ? l.startDate : plans.month + '-01'}" required></label><label>〜<input type="date" name="endDate" value="${l ? l.endDate : monthEnd(plans.month)}" required></label>
    <label>追加の計画（テスト前など）<select name="parentId"><option value="">ふつうの計画</option>${parents.map(p => `<option value="${esc(p.id)}"${l && l.parentId === p.id ? ' selected' : ''}>${esc(p.subject)}（${md(p.startDate)}〜${md(p.endDate)}）への追加</option>`).join('')}</select></label></div>
    <label>保護者への説明（任意）<input name="comment" maxlength="500" value="${esc(l ? l.comment : '')}" placeholder="例: 2学期中間テストに向けて計算の復習"></label>
    <div class="row"><button class="primary"${ctx.dis()}>${l ? '直して下書きにする' : '下書きを作る'}</button><button type="button" data-action="pl-close"${ctx.dis()}>やめる</button></div></form>`;
}
// 設定の「授業の種類と標準料金」（#kinds）。種類を押すと下から直す画面
export function kindsPage(ctx) {
  const { esc } = ctx;
  needPlans(ctx);
  let h = `<div class="page-head"><h1>授業の種類と標準料金</h1></div><p class="sub">計画を作るときの初期値です。標準の料金が0円なら、生徒の基本単価で計算します。</p>${ctx.notice()}`;
  if (plans.loading) return h + '<p class="muted">読み込んでいます…</p>';
  h += '<div class="rows">' + plans.kinds.map(k => rowButton(esc, 'kind-open', { name: k.name }, `${esc(k.name)}${k.active ? '' : ' <span class="tag gray">使わない</span>'}`,
    `標準 ${k.standardMinutes ? k.standardMinutes + '分' : '時間なし'}・${k.standardFee ? yen(k.standardFee) : '生徒の基本単価'}`)).join('') + '</div>';
  h += `<p style="margin-top:12px"><button data-action="kind-open" data-name=""${ctx.dis()}>種類を足す</button></p>`;
  if (kindOpen !== null) {
    const k = plans.kinds.find(x => x.name === kindOpen);
    const body = `<form class="stack" data-form="kind-save">${k ? `<input type="hidden" name="name" value="${esc(k.name)}">` : '<label>名前<input name="name" maxlength="20" placeholder="例: 講習" required></label>'}
      <div class="row"><label style="flex:1">標準の時間（分）<input type="number" name="standardMinutes" min="0" max="300" step="15" value="${k ? k.standardMinutes : ''}"></label><label style="flex:1">標準の料金（円）<input type="number" name="standardFee" min="0" max="100000" value="${k ? k.standardFee : ''}"></label></div>
      <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="active" value="1"${!k || k.active ? ' checked' : ''} style="width:auto"> 計画で使う</label>
      <button class="primary"${ctx.dis()}>${k ? '保存' : '足す'}</button></form>`;
    h += sheet(esc, k ? k.name : '授業の種類を足す', body, 'kind-close');
  }
  return h;
}

// ---------- 請求 ----------
export function billingPage(ctx) {
  const { esc } = ctx;
  if (!billMonth) billMonth = shift(thisMonth(), -1);
  if (!bill || bill.month !== billMonth) {
    const want = billMonth; bill = { month: want, loading: true }; detail = null;
    ctx.call('billing/month', { month: want }).then(r => { if (billMonth !== want) return; bill = r.ok ? r : { month: want, families: [], voided: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); });
  }
  if (!fees) { fees = { loading: true }; ctx.call('billing/fees/list').then(r => { fees = r.ok ? r : { fees: [] }; ctx.render(); }); }
  let h = `<div class="page-head"><h1>請求</h1></div><p class="sub" style="margin-top:0">家族ごと・月ごとの請求。月の分は翌月3日の0時10分に自動で確定します（確かめることがある家族は止まります）。1日・2日に内容を確かめてください。</p>${ctx.notice()}`;
  h += feesPart(ctx);
  h += `<h2>月の請求</h2>${monthPicker(billMonth, 'bl-month')}`;
  if (bill.loading) return h + '<p class="muted">読み込んでいます…</p>';
  if (!bill.families.length) h += '<p class="muted">この月に請求するものはありません。</p>';
  h += '<div class="rows">' + bill.families.map(f => {
    const st = invStatus(f), n = f.preview ? f.preview.issues.length : 0;
    return rowButton(esc, 'bl-open', { id: f.familyId }, `${esc(f.name)} <span class="tag ${st[1]}">${st[0]}</span>`,
      `${yen(f.invoice ? f.invoice.total : f.preview.total)}${n ? `・確かめること ${n}件` : ''}${f.preview && f.preview.pendingCount ? `・承認のない授業 ${f.preview.pendingCount}件` : ''}`);
  }).join('') + '</div>';
  const f = openFamily && bill.families.find(x => x.familyId === openFamily);
  if (f) {
    const st = invStatus(f);
    let body = `<p style="margin-top:0"><span class="tag ${st[1]}">${st[0]}</span></p>`;
    if (f.preview && f.preview.issues.length) body += `<ul class="small">${f.preview.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    if (f.preview && f.preview.pendingCount) body += `<div class="small muted">計画の承認がない授業 ${f.preview.pendingCount}件（請求に入りません）</div>`;
    if (f.preview && f.proposedPlans) body += `<div class="row" style="margin:6px 0">${remindButton(ctx, f.familyId, f.proposedPlans, f.remindedAt)}</div>`;
    h += sheet(esc, `${f.name}（${monthLabel(billMonth)}）`, body + detailPart(ctx), 'bl-close', { wide: true });
  }
  if (bill.voided.length) h += `<h3>取り消した請求</h3><ul class="small">${bill.voided.map(v => `<li>${esc(v.name)} ${yen(v.total)}（${esc(v.voidReason)}）</li>`).join('')}</ul>`;
  return h;
}
const invStatus = f => f.invoice ? INV_STATUS[f.invoice.status] : f.preview.issues.length ? ['確かめることあり', 'danger'] : f.preview.pendingCount ? ['承認待ちの授業あり', 'warn'] : ['確定前', 'gray'];
function detailPart(ctx) {
  const { esc } = ctx;
  if (!detail || detail.familyId !== openFamily || detail.month !== billMonth) {
    const fid = openFamily, m = billMonth; detail = { familyId: fid, month: m, loading: true };
    ctx.call('billing/family', { familyId: fid, month: m }).then(r => { if (openFamily !== fid) return; detail = r.ok ? { familyId: fid, month: m, ...r } : { familyId: fid, month: m, error: r.error.message }; ctx.render(); });
  }
  if (detail.loading) return '<p class="muted">読み込んでいます…</p>';
  if (detail.error) return `<p class="notice error">${esc(detail.error)}</p>`;
  const row = i => `<tr><td>${md(i.date)}</td><td>${esc(i.subject)}${i.lessonKind && i.lessonKind !== '通常' ? '（' + esc(i.lessonKind) + '）' : ''}${i.label ? ' <span class="small muted">' + esc(i.label) + '</span>' : ''}${i.carried ? ' <span class="small muted">前の月の分</span>' : ''}</td><td>${i.kind === 'lesson' ? i.minutes + '分' : ''}</td><td style="text-align:right">${yen(i.amount)}</td></tr>`;
  if (detail.invoice) {
    const v = detail.invoice, byStudent = {};
    for (const i of detail.items) (byStudent[i.studentName] = byStudent[i.studentName] || []).push(i);
    let h = `<div class="stack"><div>確定 ${esc(v.confirmedAt.slice(0, 10))}（${v.confirmedBy === 'auto' ? '自動' : v.confirmedBy === 'legacy' ? '今の仕組みから写し' : '手で確定'}）${v.reportedAt ? '・振込の連絡 ' + esc(v.reportedAt.slice(0, 10)) : ''}${v.paidOn ? '・入金 ' + esc(v.paidOn) + '（' + esc(v.paidMethod) + '）' : ''}</div>`;
    for (const [name, items] of Object.entries(byStudent)) h += `<div><strong>${esc(name)}</strong><table class="small" style="width:100%">${items.map(row).join('')}</table></div>`;
    h += `<div><strong>合計 ${yen(v.total)}</strong></div>`;
    if (v.status === 'paid') h += `<form class="row" data-form="bl-unpaid" data-id="${esc(v.id)}" data-version="${v.version}"><input name="reason" maxlength="300" placeholder="入金の記録を戻す理由" style="flex:1" required><button${ctx.dis()}>入金の記録を戻す</button></form>`;
    else h += `<form class="row" data-form="bl-paid" data-id="${esc(v.id)}" data-version="${v.version}"><label>入金日<input type="date" name="paidOn" required></label><label>方法<input name="method" maxlength="20" value="振込" style="width:6em"></label><button class="primary"${ctx.dis()}>入金を記録</button></form>
      <form class="row" data-form="bl-void" data-id="${esc(v.id)}" data-version="${v.version}"><input name="reason" maxlength="300" placeholder="取り消す理由（例: 金額の誤り）" style="flex:1" required><button class="danger"${ctx.dis()}>請求を取り消す</button></form>`;
    return h + '</div>';
  }
  const p = detail.preview;
  let h = '<div class="stack">';
  for (const s of p.students) {
    h += `<div><strong>${esc(s.name)}</strong> ${yen(s.total)}<table class="small" style="width:100%">${s.items.map(row).join('')}</table>`;
    if (s.pending.length) h += `<div class="small muted">計画の承認がない授業（請求に入りません。承認されたら次の請求に入ります）: ${s.pending.map(x => `${md(x.date)} ${esc(x.subject)}（見込み ${yen(x.estimate)}）`).join('、')}</div>`;
    h += '</div>';
  }
  h += `<div><strong>合計 ${yen(p.total)}</strong></div>`;
  if (p.issues.length) h += `<ul class="small">${p.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const ended = billMonth < thisMonth();
  if (p.canConfirm && ended) h += `<p><button class="primary" data-action="bl-confirm" data-total="${p.total}"${ctx.dis()}>この内容で確定する（${yen(p.total)}）</button></p>`;
  else if (!ended) h += '<p class="small muted">月が終わってから確定できます。</p>';
  return h + '</div>';
}
function feesPart(ctx) {
  const { esc } = ctx;
  if (fees.loading) return '';
  const open = fees.fees.filter(f => f.decision === 'pending' || f.reliefStatus === 'pending');
  const rest = fees.fees.filter(f => !open.includes(f) && !f.invoiceId);
  let h = `<h2>キャンセル料${open.length ? ` <span class="count">${open.length}</span>` : ''}</h2>`;
  if (!fees.fees.length) return h + '<p class="small muted">請求前のキャンセル料はありません。</p>';
  const title = f => `${esc(f.studentName)} ${md(f.date)} ${esc(f.start)} ${esc(f.subject)}`;
  h += '<div class="rows">' + open.map(f => rowButton(esc, 'fee-open', { id: f.id }, `${title(f)} <span class="tag danger">${f.reliefStatus === 'pending' ? '減額・免除の申請' : '判断待ち'}</span>`, `${FEE_TYPE[f.type]}・規定額 ${yen(f.standardAmount)}`)).join('')
    + rest.map(f => `<div class="todo"><span class="b"><strong>${title(f)}</strong><small class="muted">${f.decision === 'charge' ? '規定どおり' : f.decision === 'waive' ? '免除' : '減額'} ${yen(f.amount)}${f.note ? '・' + esc(f.note) : ''}${f.reliefStatus ? '・申請への回答済み' : ''}（請求前）</small></span></div>`).join('') + '</div>';
  const f = feeOpen && open.find(x => x.id === feeOpen);
  if (f) {
    let body = `<div class="small">${FEE_TYPE[f.type]}・規定額 ${yen(f.standardAmount)}${f.receivedAt ? `<br><span class="muted">連絡 ${esc(f.receivedAt.slice(5, 16).replace('T', ' '))}</span>` : ''}</div>`;
    body += f.reliefStatus === 'pending'
      ? `<p class="small">いまの金額 ${yen(f.amount)}<br><strong>減額・免除の申請</strong>: ${esc(f.reliefReason)}</p><form class="stack" data-form="fee-relief" data-id="${esc(f.id)}" data-version="${f.version}"><div class="row"><select name="result" style="flex:1"><option value="unchanged">そのまま</option><option value="reduced">減額する</option><option value="waived">免除する</option></select><input type="number" name="amount" min="0" placeholder="減額後の金額" style="flex:1"></div>
        <label>回答（保護者に見えます）<input name="response" maxlength="300" required></label><button class="primary"${ctx.dis()}>回答する</button></form>`
      : `<form class="stack" data-form="fee-decide" data-id="${esc(f.id)}" data-version="${f.version}" style="margin-top:10px"><div class="row"><select name="decision" style="flex:1"><option value="charge">規定どおり（${yen(f.standardAmount)}）</option><option value="adjust">減額する</option><option value="waive">免除する</option></select><input type="number" name="amount" min="0" placeholder="減額後の金額" style="flex:1"></div>
        <label>減額・免除の理由（保護者に見えます）<input name="note" maxlength="300"></label><button class="primary"${ctx.dis()}>決める</button></form>`;
    h += sheet(esc, `キャンセル料 ${f.studentName} ${md(f.date)}`, body, 'fee-close');
  }
  return h;
}

// ---------- 操作 ----------
const num = v => v === '' || v === undefined ? undefined : Number(v);
export async function billingSubmit(ctx, kind, el) {
  const v = Object.fromEntries(new FormData(el).entries()), id = el.dataset.id, version = Number(el.dataset.version);
  let r, msg;
  if (kind === 'pl-save') {
    r = await ctx.call('billing/plans/save', { id, version: id ? version : undefined, studentId: el.dataset.student, subject: v.subject, kind: v.kind, count: num(v.count), minutes: num(v.minutes), fee: num(v.fee), startDate: v.startDate, endDate: v.endDate, parentId: v.parentId, comment: v.comment });
    msg = '下書きにしました。「お知らせする」で家族に送ります'; if (r.ok) { editing = addFor = lineOpen = ''; plans = null; }
  } else if (kind === 'pl-consent') {
    r = await ctx.call('billing/plans/consent', { id, version, consentDate: v.consentDate, via: v.via, approvedCount: num(v.approvedCount), note: v.note });
    msg = '承認として記録しました'; if (r.ok) { consentFor = lineOpen = ''; plans = null; }
  } else if (kind === 'kind-save') {
    r = await ctx.call('billing/kinds/save', { name: v.name, standardMinutes: num(v.standardMinutes) || 0, standardFee: num(v.standardFee) || 0, active: v.active === '1' });
    msg = '授業の種類を保存しました'; if (r.ok) { plans = null; kindOpen = null; }
  } else if (kind === 'fee-decide') {
    r = await ctx.call('billing/fees/decide', { id, version, decision: v.decision, amount: num(v.amount), note: v.note });
    msg = 'キャンセル料を決めました'; if (r.ok) { fees = null; bill = null; feeOpen = ''; }
  } else if (kind === 'fee-relief') {
    r = await ctx.call('billing/fees/relief', { id, version, result: v.result, amount: num(v.amount), response: v.response });
    msg = '申請に回答しました'; if (r.ok) { fees = null; bill = null; feeOpen = ''; }
  } else if (kind === 'bl-paid') {
    r = await ctx.call('billing/paid', { id, version, paidOn: v.paidOn, method: v.method }); msg = '入金を記録しました'; if (r.ok) { bill = null; detail = null; }
  } else if (kind === 'bl-unpaid') {
    r = await ctx.call('billing/paid', { id, version, undo: true, reason: v.reason }); msg = '入金の記録を戻しました'; if (r.ok) { bill = null; detail = null; }
  } else if (kind === 'bl-void') {
    if (!confirm('この請求を取り消しますか？ 授業とキャンセル料は請求前に戻ります。')) return true;
    r = await ctx.call('billing/void', { id, version, reason: v.reason }); msg = '請求を取り消しました。直してから、もう一度確定してください'; if (r.ok) { bill = null; detail = null; fees = null; }
  } else return false;
  if (r.ok) ctx.say(msg, 'ok'); else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
export async function billingClick(ctx, a, b) {
  let r, msg;
  if (a === 'kind-open') { kindOpen = b.dataset.name; return true; }
  if (a === 'kind-close') { kindOpen = null; return true; }
  if (a === 'pl-month') { planMonth = shift(planMonth, Number(b.dataset.d)); editing = consentFor = addFor = lineOpen = ''; return true; }
  if (a === 'pl-line') { lineOpen = b.dataset.id; editing = consentFor = addFor = ''; ctx.say(''); return true; }
  if (a === 'fee-open') { feeOpen = b.dataset.id; ctx.say(''); return true; }
  if (a === 'fee-close') { feeOpen = ''; return true; }
  if (a === 'bl-close') { openFamily = ''; detail = null; return true; }
  if (a === 'bl-month') { billMonth = shift(billMonth, Number(b.dataset.d)); openFamily = ''; return true; }
  if (a === 'pl-add') { addFor = b.dataset.id; editing = consentFor = lineOpen = ''; return true; }
  if (a === 'pl-edit') { editing = b.dataset.id; consentFor = addFor = ''; return true; }
  if (a === 'pl-consent') { consentFor = b.dataset.id; editing = addFor = ''; return true; }
  if (a === 'pl-close') { editing = consentFor = addFor = lineOpen = ''; return true; }
  if (a === 'bl-open') { openFamily = b.dataset.id; detail = null; ctx.say(''); return true; }
  if (a === 'pl-copy') {
    if (!confirm(`${monthLabel(planMonth)}の計画の下書きを、先月と同じ内容で作りますか？ もう計画がある科目は作りません。`)) return true;
    r = await ctx.call('billing/plans/copyMonth', { month: planMonth }); msg = r.ok ? `下書きを ${r.created}件 作りました` : ''; if (r.ok) plans = null;
  } else if (a === 'pl-send') {
    if (!confirm('この家族に、下書きの計画をまとめてお知らせしますか？ 保護者ページに出て、承認をお願いするメールが届きます。')) return true;
    r = await ctx.call('billing/plans/send', { familyId: b.dataset.family }); msg = r.ok ? `${r.sent}件をお知らせしました` : ''; if (r.ok) plans = null;
  } else if (a === 'pl-remind') {
    if (!confirm('この家族に、承認待ちの計画の「承認のお願い」をメールで送りますか？')) return true;
    r = await ctx.call('billing/plans/remind', { familyId: b.dataset.family }); msg = r.ok ? `承認のお願いを送りました（${r.reminded}件）` : ''; if (r.ok) { plans = null; bill = null; }
  } else if (a === 'pl-delete') {
    if (!confirm('この計画を消しますか？')) return true;
    r = await ctx.call('billing/plans/delete', { id: b.dataset.id, version: Number(b.dataset.version) }); msg = '消しました'; if (r.ok) { plans = null; lineOpen = ''; }
  } else if (a === 'bl-confirm') {
    if (!confirm('この内容で請求を確定しますか？ 保護者ページに出て、メールでお知らせします。')) return true;
    r = await ctx.call('billing/confirm', { familyId: openFamily, month: billMonth, expectedTotal: Number(b.dataset.total) }); msg = '請求を確定しました'; if (r.ok) { bill = null; detail = null; fees = null; }
  } else return false;
  if (r.ok) ctx.say(msg, 'ok'); else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
