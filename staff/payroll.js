// スタッフの画面: 報酬（7段目）。#payroll と、設定の「時給と源泉徴収」（#rates）。
// 教室管理者: 月ごとの講師の明細（見込み・確定・支払い）、調整。時給と源泉徴収は設定の下。講師: 自分の支払明細だけ（印刷・PDF で保存できる）。
import { sheet, rowButton } from '/staff/ui.js?v=20261002-ux9';
let month = '', list = null, open = '', detail = null, rates = null, mine = null, rateOpen = '';
export function leavePayroll() { open = ''; rateOpen = ''; }
export function resetPayroll() { list = null; detail = null; rates = null; mine = null; open = ''; rateOpen = ''; }

const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const hm = m => `${Math.floor(m / 60)}時間${m % 60 ? (m % 60) + '分' : ''}`;
const md = d => d ? Number(d.slice(5, 7)) + '/' + Number(d.slice(8)) : '';
const thisMonth = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const shift = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
const label = m => `${m.slice(0, 4)}年${Number(m.slice(5))}月`;
const STATUS = { confirmed: ['確定・支払い待ち', 'warn'], paid: ['支払い済み', 'ok'] };

// 明細の表（画面と印刷で共通）
function statementTable(esc, s) {
  const rows = s.items.map(i => `<tr><td>${i.kind === 'adjust' ? '調整' : md(i.date)}</td><td>${esc(i.label)}${i.carried ? ' <span class="small muted">前の月の分</span>' : ''}</td><td>${i.minutes ? i.minutes + '分' : ''}</td><td>${i.rate ? yen(i.rate) : ''}</td><td style="text-align:right">${yen(i.amount)}</td></tr>`).join('');
  return `<table class="small" style="width:100%;border-collapse:collapse"><tr><th style="text-align:left">日</th><th style="text-align:left">内容</th><th style="text-align:left">時間</th><th style="text-align:left">時給</th><th style="text-align:right">金額</th></tr>${rows}</table>
    <table class="small" style="width:100%;margin-top:6px"><tr><td>授業 ${hm(s.lessonMinutes)}</td><td style="text-align:right">${yen(s.lessonAmount)}</td></tr>${s.meetingMinutes ? `<tr><td>面談 ${hm(s.meetingMinutes)}</td><td style="text-align:right">${yen(s.meetingAmount)}</td></tr>` : ''}${s.adjustAmount ? `<tr><td>調整</td><td style="text-align:right">${yen(s.adjustAmount)}</td></tr>` : ''}
    <tr><td><strong>総支給額</strong></td><td style="text-align:right"><strong>${yen(s.gross)}</strong></td></tr><tr><td>源泉徴収</td><td style="text-align:right">${s.withholding ? '−' + yen(s.withholding) : '0円'}</td></tr><tr><td><strong>差引支給額</strong></td><td style="text-align:right"><strong>${yen(s.net)}</strong></td></tr></table>`;
}
// 印刷用の窓に明細だけを出す（ブラウザの印刷で PDF にも保存できる）
export function printStatement(esc, s, name) {
  const w = window.open('', '_blank'); if (!w) return false;
  w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>支払明細 ${esc(label(s.month))} ${esc(name)}</title>
    <style>body{font-family:system-ui,"Hiragino Sans","Yu Gothic",sans-serif;color:#111;margin:32px;max-width:720px}h1{font-size:20px}td,th{padding:4px 6px;border-bottom:1px solid #ddd;font-size:13px}.small{font-size:13px}.muted{color:#666}</style></head>
    <body><h1>支払明細（${esc(label(s.month))}分）</h1><p>${esc(name)} 様</p><p class="small">ステップワイズ英数教室・業務委託の報酬（月末締め・翌月25日払い）<br>確定 ${esc(String(s.confirmedAt || '').slice(0, 10))}・お支払い ${esc(s.paidOn || s.payOn)}${s.paidOn ? '（支払い済み）' : '（予定）'}</p>
    ${statementTable(esc, s)}<script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
  return true;
}

export function payrollPage(ctx, me) {
  const { esc } = ctx;
  if (!ctx.isManager) return minePage(ctx, me);
  if (!month) month = shift(thisMonth(), -1);
  if (!list || list.month !== month) { const want = month; list = { month: want, loading: true }; detail = null; ctx.call('payroll/month', { month: want }).then(r => { if (month !== want) return; list = r.ok ? r : { month: want, staff: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); }
  let h = `<div class="page-head"><h1>報酬</h1></div><p class="sub" style="margin-top:0">講師（業務委託）の報酬。月末締め・翌月25日払い。実施済みの授業と、日が過ぎた面談を数えます。準備と交通費は数えません。</p>${ctx.notice()}
    <div class="row"><button data-action="pr-month" data-d="-1">◀</button><strong style="min-width:8em;text-align:center">${label(month)}</strong><button data-action="pr-month" data-d="1">▶</button></div>`;
  if (list.loading) return h + '<p class="muted">読み込んでいます…</p>';
  h += `<p class="small muted">支払予定日 ${esc(list.payOn)}</p>`;
  if (list.unassigned) h += `<p class="notice">担当の講師がいない実施済みの授業が ${list.unassigned}件あります（だれの報酬にも入りません）。「予定」で担当を決めてください。</p>`;
  const status = s => s.payroll ? STATUS[s.payroll.status] : s.preview.issues.length ? ['確かめることあり', 'danger'] : ['確定前', 'gray'];
  h += list.staff.length ? '<div class="rows">' + list.staff.map(s => {
    const p = s.payroll, v = s.preview, st = status(s);
    return rowButton(esc, 'pr-open', { id: s.staffId }, `${esc(s.name)} <span class="tag ${st[1]}">${st[0]}</span>`, `差引 ${yen(p ? p.net : v.net)}・授業 ${hm((p || v).lessonMinutes)}${(p || v).meetingMinutes ? '・面談 ' + hm((p || v).meetingMinutes) : ''}${v && v.issues.length ? `・確かめること ${v.issues.length}件` : ''}`);
  }).join('') + '</div>' : '<p class="muted">この月の勤務はありません。</p>';
  const s = open && list.staff.find(x => x.staffId === open);
  if (s) {
    const st = status(s);
    h += sheet(esc, `${s.name}（${label(month)}）`, `<p style="margin-top:0"><span class="tag ${st[1]}">${st[0]}</span></p>${s.preview && s.preview.issues.length ? `<ul class="small">${s.preview.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}${detailPart(ctx, s.name)}`, 'pr-close', { wide: true });
  }
  h += '<p class="small muted" style="margin-top:16px">時給と源泉徴収は「設定」にあります（<a href="#rates">開く</a>）。</p>';
  return h;
}
function detailPart(ctx, name) {
  const { esc } = ctx;
  if (!detail || detail.staffId !== open || detail.month !== month) {
    const sid = open, m = month; detail = { staffId: sid, month: m, loading: true };
    ctx.call('payroll/staff', { staffId: sid, month: m }).then(r => { if (open !== sid) return; detail = r.ok ? { staffId: sid, month: m, ...r } : { staffId: sid, month: m, error: r.error.message }; ctx.render(); });
  }
  if (detail.loading) return '<p class="muted">読み込んでいます…</p>';
  if (detail.error) return `<p class="notice error">${esc(detail.error)}</p>`;
  if (detail.payroll) {
    const p = detail.payroll;
    let h = `<div class="stack">${statementTable(esc, p)}<div class="small muted">確定 ${esc(p.confirmedAt.slice(0, 10))}・${p.paidOn ? '支払い ' + esc(p.paidOn) : '支払予定 ' + esc(p.payOn)}</div><div class="row"><button data-action="pr-print"${ctx.dis()}>印刷・PDF で保存</button></div>`;
    if (p.status === 'paid') h += `<form class="row" data-form="pr-unpaid" data-id="${esc(p.id)}" data-version="${p.version}"><button${ctx.dis()}>支払いの記録を戻す</button></form>`;
    else h += `<form class="row" data-form="pr-paid" data-id="${esc(p.id)}" data-version="${p.version}"><label>支払った日<input type="date" name="paidOn" required></label><button class="primary"${ctx.dis()}>支払いを記録</button></form>
      <form class="row" data-form="pr-void" data-id="${esc(p.id)}" data-version="${p.version}"><input name="reason" maxlength="300" placeholder="取り消す理由（例: 時給の入力の誤り）" style="flex:1" required><button class="danger"${ctx.dis()}>取り消して直す</button></form>`;
    return h + '</div>';
  }
  const v = detail.preview, ended = month < thisMonth();
  let h = `<div class="stack">${statementTable(esc, v)}${v.withholdingOn ? '<div class="small muted">この講師は源泉徴収をします。</div>' : ''}`;
  if (v.issues.length) h += `<ul class="small">${v.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
  h += '<div class="small muted">調整（研修の時間・立て替えなど。マイナスもよい）</div>' + detail.adjusts.map(a => `<div class="row small">${esc(a.label)} ${yen(a.amount)} <button data-action="pr-adj-del" data-id="${esc(a.id)}"${ctx.dis()}>外す</button></div>`).join('')
    + `<form class="row" data-form="pr-adj"><input name="label" maxlength="60" placeholder="理由（例: 研修 2時間）" style="flex:2" required><input type="number" name="amount" placeholder="金額" style="width:8em" required><button${ctx.dis()}>足す</button></form>`;
  if (v.canConfirm && ended) h += `<p><button class="primary" data-action="pr-confirm" data-net="${v.net}"${ctx.dis()}>この内容で確定する（差引 ${yen(v.net)}）</button></p><p class="small muted">確定すると講師に明細のお知らせが届きます。確定した明細は変えず、直すときは取り消して確定し直します。</p>`;
  else if (!ended) h += '<p class="small muted">月が終わってから確定できます（月末締め）。</p>';
  return h + '</div>';
}
// 設定の「時給と源泉徴収」（#rates）。講師ごとの行を押すと、下から時給の履歴・新しい時給・源泉徴収
export function ratesPage(ctx) {
  const { esc } = ctx;
  if (!rates) { rates = { loading: true }; ctx.call('payroll/rates/list').then(r => { rates = r.ok ? r : { staff: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); }
  let h = `<div class="page-head"><h1>時給と源泉徴収</h1></div><p class="sub">時給は、変えた月から新しい時給で計算します（確定した明細は変わりません）。源泉徴収が要るかは、税務署か税理士に確かめてから決めてください。</p>${ctx.notice()}`;
  if (rates.loading) return h + '<p class="muted">読み込んでいます…</p>';
  if (!rates.staff.length) return h + '<p class="small muted">講師がいません。「スタッフ」で招待してください。</p>';
  h += '<div class="rows">' + rates.staff.map(s => {
    const now = s.rates[0];
    return rowButton(esc, 'rt-open', { staff: s.id }, `${esc(s.name)}${s.status === 'stopped' ? ' <span class="tag gray">停止</span>' : ''}${now ? '' : ' <span class="tag danger">時給なし</span>'}`,
      (now ? `授業 ${yen(now.lessonHourly)}・面談 ${yen(now.meetingHourly)}（${label(now.startsOn)}から）` : '時給が決まっていません') + (s.withholding ? '・源泉徴収あり' : ''));
  }).join('') + '</div>';
  const s = rateOpen && rates.staff.find(x => x.id === rateOpen);
  if (s) {
    const now = s.rates[0];
    const body = (s.rates.length ? '<div class="small">' + s.rates.map(r => `${label(r.startsOn)}から 授業 ${yen(r.lessonHourly)}・面談 ${yen(r.meetingHourly)}`).join('<br>') + '</div>' : '<p class="small muted">時給が決まっていません。</p>')
      + `<h3>時給を決める</h3><form class="stack" data-form="pr-rate" data-staff="${esc(s.id)}"><label>いつから<input type="month" name="startsOn" required value="${esc(thisMonth())}"></label>
      <div class="row"><label style="flex:1">授業の時給（円）<input type="number" name="lessonHourly" min="0" max="20000" required value="${now ? now.lessonHourly : ''}"></label><label style="flex:1">面談の時給（円）<input type="number" name="meetingHourly" min="0" max="20000" required value="${now ? now.meetingHourly : 1500}"></label></div>
      <button class="primary"${ctx.dis()}>この時給にする</button></form>
      <h3>源泉徴収</h3><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-action="pr-withholding" data-staff="${esc(s.id)}" data-version="${s.version}"${s.withholding ? ' checked' : ''}${ctx.dis()} style="width:auto"> 源泉徴収をする（10.21%）</label>`;
    h += sheet(esc, s.name + ' さんの時給', body, 'rt-close');
  }
  return h;
}

// 講師: 自分の支払明細
function minePage(ctx, me) {
  const { esc } = ctx;
  if (!mine) { mine = { loading: true }; ctx.call('payroll/mine').then(r => { mine = r.ok ? r : { statements: [] }; if (!r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); ctx.render(); }); }
  let h = `<div class="page-head"><h1>報酬</h1></div><p class="sub" style="margin-top:0">あなたの支払明細です。月末締め・翌月25日払い。</p>${ctx.notice()}`;
  if (mine.loading) return h + '<p class="muted">読み込んでいます…</p>';
  if (mine.owner) return h + '<p class="muted">代表のアカウントには支払明細はありません。</p>';
  if (mine.current && mine.current.items) h += `<p class="notice small">${label(mine.current.month)}の見込み（確定前の目安）: 授業 ${hm(mine.current.lessonMinutes)}${mine.current.meetingMinutes ? '・面談 ' + hm(mine.current.meetingMinutes) : ''}・総支給 ${yen(mine.current.gross)}</p>`;
  h += mine.statements.length ? mine.statements.map((s, i) => `<details class="sheet"${i === 0 ? ' open' : ''}><summary><strong>${label(s.month)}分</strong> 差引 ${yen(s.net)} <span class="tag ${STATUS[s.status][1]}">${STATUS[s.status][0]}</span></summary>${statementTable(esc, s)}
    <div class="small muted">お支払い ${esc(s.paidOn || s.payOn)}${s.paidOn ? '（済み）' : '（予定）'}</div><p><button data-action="pr-print-mine" data-i="${i}">印刷・PDF で保存</button></p></details>`).join('') : '<p class="muted">まだ確定した明細はありません。</p>';
  return h;
}

// ---------- 操作 ----------
export async function payrollSubmit(ctx, kind, el) {
  const v = Object.fromEntries(new FormData(el).entries()), id = el.dataset.id, version = Number(el.dataset.version);
  let r, msg;
  if (kind === 'pr-rate') { r = await ctx.call('payroll/rates/save', { staffId: el.dataset.staff, startsOn: v.startsOn, lessonHourly: Number(v.lessonHourly), meetingHourly: Number(v.meetingHourly) }); msg = '時給を保存しました'; if (r.ok) { rates = null; list = null; detail = null; rateOpen = ''; } }
  else if (kind === 'pr-adj') { r = await ctx.call('payroll/adjust/add', { staffId: open, month, label: v.label, amount: Number(v.amount) }); msg = '調整を足しました'; if (r.ok) { detail = null; list = null; } }
  else if (kind === 'pr-paid') { r = await ctx.call('payroll/paid', { id, version, paidOn: v.paidOn }); msg = '支払いを記録しました'; if (r.ok) { detail = null; list = null; } }
  else if (kind === 'pr-unpaid') { if (!confirm('支払いの記録を戻しますか？')) return true; r = await ctx.call('payroll/paid', { id, version, undo: true }); msg = '支払いの記録を戻しました'; if (r.ok) { detail = null; list = null; } }
  else if (kind === 'pr-void') { if (!confirm('この明細を取り消しますか？ 授業・面談・調整は確定の前に戻ります。取り消した明細は記録に残ります。')) return true; r = await ctx.call('payroll/void', { id, version, reason: v.reason }); msg = '取り消しました。直してから確定し直してください'; if (r.ok) { detail = null; list = null; } }
  else return false;
  if (r.ok) ctx.say(msg, 'ok'); else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
export async function payrollClick(ctx, a, b) {
  let r, msg;
  if (a === 'pr-month') { month = shift(month, Number(b.dataset.d)); open = ''; return true; }
  if (a === 'rt-open') { rateOpen = b.dataset.staff; return true; }
  if (a === 'rt-close') { rateOpen = ''; return true; }
  if (a === 'pr-open') { open = b.dataset.id; detail = null; ctx.say(''); return true; }
  if (a === 'pr-close') { open = ''; detail = null; return true; }
  if (a === 'pr-print' || a === 'pr-print-mine') return false; // app.js で（新しい窓を先に開くため）
  if (a === 'pr-confirm') {
    if (!confirm('この内容で確定しますか？ 講師に明細のお知らせが届きます。')) return true;
    r = await ctx.call('payroll/confirm', { staffId: open, month, expectedNet: Number(b.dataset.net) }); msg = '確定しました'; if (r.ok) { detail = null; list = null; }
  } else if (a === 'pr-adj-del') { r = await ctx.call('payroll/adjust/delete', { id: b.dataset.id }); msg = '外しました'; if (r.ok) { detail = null; list = null; } }
  else if (a === 'pr-withholding') { r = await ctx.call('payroll/withholding', { staffId: b.dataset.staff, version: Number(b.dataset.version), withholding: b.checked }); msg = b.checked ? '源泉徴収をするにしました' : '源泉徴収をしないにしました'; if (r.ok) { rates = null; detail = null; list = null; } }
  else return false;
  if (r.ok) ctx.say(msg, 'ok'); else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
// 印刷（クリックのその場で窓を開く）
export function payrollPrint(ctx, a, b, me) {
  if (a === 'pr-print' && detail && detail.payroll) { const row = list.staff.find(s => s.staffId === open); return printStatement(ctx.esc, detail.payroll, row ? row.name : ''); }
  if (a === 'pr-print-mine' && mine && mine.statements) return printStatement(ctx.esc, mine.statements[Number(b.dataset.i)], me.name);
  return false;
}
