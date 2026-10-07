// スタッフの「月の仕事」と「設定」（docs/UX_STRUCTURE.md 3）。設定は アカウント・教室の運営（時給・授業の種類）・システム（スタッフ・移行）。
// 月の仕事は、月の流れの順（前月分の請求 → 翌月の計画 → 翌月の予定表 → 前月分の給与）に、どこまで済んだかを出す（API monthly/overview）。
// 1 つの仕事が 1 枚の白い枠。上の行（色つきのアイコン・名前・時期）を押すとその画面へ。今の時期の枠は青い縁。
import { ICON } from '/staff/ui.js?v=20261008-launch1';

let overview = null;
export function resetMonthly() { overview = null; }
const mon = m => Number(m.slice(5)) + '月';
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const PERSON = '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>';
const SWAP = '<path d="M4 7h13l-3-3M20 17H7l3 3"/>';
const ibox = (k, color, label) => `<span class="ibox" style="background:${color}" role="img" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || (k === 'person' ? PERSON : k === 'swap' ? SWAP : '')}</svg></span>`;
// 進み具合の印: [ラベル, 数, 色, 0でも出す] を並べる
const chips = items => { const list = items.filter(([, n, , always]) => n || always); return list.length ? '<div class="tags">' + list.map(([label, n, cls]) => `<span class="tag ${cls}">${label} ${n}</span>`).join('') + '</div>' : ''; };
const names = (esc, rows, f = r => r.name) => rows.slice(0, 8).map(r => esc(f(r))).join('・') + (rows.length > 8 ? ` ほか${rows.length - 8}` : '');

export const monthlyBar = () => ({ title: '月の仕事', sub: overview && overview.now ? '' : '', right: '' });
export function monthlyPage(ctx) {
  const { esc } = ctx;
  if (!overview) { overview = { loading: true }; ctx.call('monthly/overview').then(r => { overview = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = ctx.notice();
  if (overview.loading) return h + '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
  if (overview.error) return h + `<p class="notice error">${esc(overview.error)}</p>`;
  const o = overview, b = o.billing, p = o.planning, s = o.schedule, y = o.payroll;
  // 1 枚の枠: 上の行を押すとその画面へ。中は印と、確かめることの名前
  const step = (key, icon, color, when, title, href, body) => `<section class="job${o.now === key ? ' now' : ''}"><a class="job-head" href="${href}">${ibox(icon, color, title)}<span class="v"><span class="lbl">${title}</span><small>${when}${o.now === key ? '・<b>今の時期</b>' : ''}</small></span><span class="go">›</span></a>${body ? `<div class="job-body">${body}</div>` : ''}</section>`;
  // 1. 前月分の請求
  let bb = chips([['確定', b.confirmed, '', true], ['確定できる', b.ready, 'ok'], ['確かめること', b.check.length, 'danger'], ['入金済み', b.paid, 'ok'], ['振込の連絡', b.reported, 'warn'], ['お支払い待ち', b.waiting, 'gray'], ['キャンセル料の判断', b.fees, 'danger']]);
  bb += `<div class="small muted">${b.families}家族。${md(b.closeOn)}の0時10分に、確かめることのない家族の分を自動で確定します。</div>`;
  if (b.check.length) bb += '<div class="small">' + b.check.map(f => `<div><b>${esc(f.name)}</b>：${esc(f.issues.join(' / '))}</div>`).join('') + '</div>';
  if (b.unapproved.length) bb += `<div class="small muted">計画の承認がない授業: ${b.unapproved.map(f => esc(f.name) + ' ' + f.n + '件').join('・')}</div>`;
  h += step('billing', 'yen', '#c0392b', '1〜2日', `${mon(b.month)}分の請求`, '#billing', bb);
  // 2. 翌月の計画
  let pb = chips([['生徒', p.students, 'gray', true], ['計画なし', p.none.length, 'danger'], ['下書き', p.draft, 'gray'], ['承認待ち', p.proposed.length, 'warn'], ['承認済み', p.approved, 'ok']]);
  if (p.none.length) pb += `<div class="small">計画がまだない: ${names(esc, p.none)}</div>`;
  if (p.proposed.length) pb += `<div class="small muted">承認待ち: ${p.proposed.map(x => esc(x.name) + (x.remindedAt ? `（お願い ${md(x.remindedAt.slice(0, 10))}）` : '')).join('・')}</div>`;
  h += step('planning', 'plan', '#5b6672', '〜20日', `${mon(p.month)}の計画`, '#plans', pb);
  // 3. 翌月の予定表
  let sb = chips([['予定なし', s.none.length, 'danger'], ['未送信', s.held.reduce((n, x) => n + x.n, 0), 'gray'], ['仮予定', s.proposed, 'warn'], ['決定', s.decided, 'ok', true]]);
  if (s.none.length) sb += `<div class="small">授業がまだない: ${names(esc, s.none)}</div>`;
  if (s.held.length) sb += `<div class="small muted">予定表を送っていない: ${s.held.map(x => esc(x.name) + ' ' + x.n + '件').join('・')}</div>`;
  sb += '<div class="small muted">締め切りは原則25日。連絡がなければ締め切りの翌日に決定します。</div>';
  h += step('planning', 'calendar', '#e0a100', '〜20日', `${mon(s.month)}の予定表`, '#schedule', sb);
  // 4. 前月分の給与
  let yb = chips([['講師', y.staff, 'gray', true], ['確定できる', y.ready, 'ok'], ['確かめること', y.check.length, 'danger'], ['支払い待ち', y.confirmed, 'warn'], ['支払い済み', y.paid, 'ok']]);
  yb += `<div class="small muted">支払日 ${md(y.payOn)}。</div>`;
  if (y.check.length) yb += '<div class="small">' + y.check.map(x => `<div><b>${esc(x.name)}</b>：${esc(x.issues.join(' / '))}</div>`).join('') + '</div>';
  if (y.unassigned) yb += `<div class="small" style="color:var(--danger)">担当の講師がいない実施済みの授業が ${y.unassigned}件あります。</div>`;
  h += step('closing', 'payroll', '#2e9b5f', '月末〜25日', `${mon(y.month)}分の給与`, '#payroll', yb);
  return h;
}

// 設定: 色つきのアイコンの行。押すとその画面へ
const row = (href, icon, color, title, note) => `<a class="todo-row" href="${href}">${ibox(icon, color, title)}<span class="v"><span class="lbl">${title}</span><small>${note}</small></span><span class="go">›</span></a>`;
export function settingsPage(ctx, me) {
  const { esc } = ctx, roles = me.roles;
  let h = ctx.notice();
  h += '<div class="group" style="margin-top:12px">' + row('#account', 'person', '#2f6fde', esc(me.name) + ' さん', esc(me.email) + '・パスワード・ログアウト') + '</div>';
  if (roles.includes('manager')) h += '<div class="sec-title">教室の運営</div><div class="group">' + row('#rates', 'yen', '#2e9b5f', '時給と源泉徴収', '講師ごとの授業・面談の時給、甲欄・乙欄') + row('#kinds', 'plan', '#5b6672', '授業の種類と標準料金', '計画を作るときの初期値') + row('#terms', 'file', '#c98a00', '受講規約', '今の版・全文のリンク・家族の同意') + row('#effects', 'mail', '#d0533c', '送信の記録', '送れなかったメール・カレンダーを送り直す') + '</div>';
  if (roles.includes('sysadmin')) h += '<div class="sec-title">システム</div><div class="group">' + row('#staff', 'person', '#7b4fd6', 'スタッフ', '招待・名前と役割・停止') + row('#migrate', 'swap', '#c98a00', '移行と切り替え', '今の仕組みからの写し・照らし合わせ・切り替え') + '</div>';
  return h;
}
