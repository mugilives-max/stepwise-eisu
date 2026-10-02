// スタッフの「月の仕事」と「設定」（docs/UX_STRUCTURE.md 3）。設定は アカウント・教室の運営（時給・授業の種類）・システム（スタッフ・移行）。
// 月の仕事は、月の流れの順（前月分の請求 → 翌月の計画 → 翌月の予定表 → 前月分の報酬）に、どこまで済んだかを出す（API monthly/overview）。
let overview = null;
export function resetMonthly() { overview = null; }
const card = (esc, href, title, note) => `<a class="todo" href="${href}"><span class="b"><strong>${esc(title)}</strong><small class="muted">${esc(note)}</small></span><span class="go">›</span></a>`;
const mon = m => Number(m.slice(5)) + '月';
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
// 進み具合の1行: [ラベル, 数, 色] を並べる。数が0のものは出さない（done は常に出す）
const chips = items => '<div class="tags" style="margin:4px 0">' + items.filter(([, n, , always]) => n || always).map(([label, n, cls]) => `<span class="tag ${cls}">${label} ${n}</span>`).join('') + '</div>';
const names = (esc, rows, f = r => r.name) => rows.length ? `<div class="small muted">${rows.slice(0, 8).map(r => esc(f(r))).join('・')}${rows.length > 8 ? ` ほか${rows.length - 8}` : ''}</div>` : '';

export function monthlyPage(ctx) {
  const { esc } = ctx;
  if (!overview) { overview = { loading: true }; ctx.call('monthly/overview').then(r => { overview = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = `<div class="page-head"><h1>月の仕事</h1></div>${ctx.notice()}`;
  if (overview.loading) return h + '<p class="muted">読み込んでいます…</p>';
  if (overview.error) return h + `<p class="notice error">${esc(overview.error)}</p>`;
  const o = overview, b = o.billing, p = o.planning, s = o.schedule, y = o.payroll;
  const step = (key, title, body, href, button) => `<section class="step${o.now === key ? ' now' : ''}"><h2>${title}${o.now === key ? ' <span class="tag warn">今の時期</span>' : ''}</h2>${body}<p><a class="small-btn${o.now === key ? ' primary' : ''}" href="${href}">${button}</a></p></section>`;
  // 1. 請求
  let bb = chips([['確定', b.confirmed, '', true], ['確定できる', b.ready, 'ok'], ['確かめること', b.check.length, 'danger'], ['入金済み', b.paid, 'ok'], ['振込の連絡あり', b.reported, 'warn'], ['お支払い待ち', b.waiting, 'gray'], ['キャンセル料の判断', b.fees, 'danger']]);
  bb += `<div class="small muted">${b.families}家族。${md(b.closeOn)}の0時10分に、確かめることのない家族の分を自動で確定します。</div>`;
  if (b.check.length) bb += '<div class="small" style="margin-top:4px">' + b.check.map(f => `<div><strong>${esc(f.name)}</strong>：${esc(f.issues.join(' / '))}</div>`).join('') + '</div>';
  if (b.unapproved.length) bb += `<div class="small muted">計画の承認がない授業: ${b.unapproved.map(f => esc(f.name) + ' ' + f.n + '件').join('・')}（承認されたら次の請求に入ります）</div>`;
  h += step('billing', `1〜2日：${mon(b.month)}分の請求`, bb, '#billing', '請求を開く');
  // 2. 翌月の計画
  let pb = chips([['生徒', p.students, 'gray', true], ['計画なし', p.none.length, 'danger'], ['下書き', p.draft, 'gray'], ['承認待ち', p.proposed.length, 'warn'], ['承認済み', p.approved, 'ok']]);
  if (p.none.length) pb += `<div class="small">計画がまだない: ${names(esc, p.none).replace(/^<div class="small muted">|<\/div>$/g, '')}</div>`;
  if (p.proposed.length) pb += `<div class="small muted">承認待ち: ${p.proposed.map(x => esc(x.name) + (x.remindedAt ? `（お願い ${md(x.remindedAt.slice(0, 10))}）` : '')).join('・')}</div>`;
  h += step('planning', `〜20日：${mon(p.month)}の計画`, pb, '#plans', '計画を開く');
  // 3. 翌月の予定表
  let sb = chips([['予定なし', s.none.length, 'danger'], ['未送信', s.held.reduce((n, x) => n + x.n, 0), 'gray'], ['仮予定', s.proposed, 'warn'], ['決定', s.decided, 'ok', true]]);
  if (s.none.length) sb += `<div class="small">授業がまだない: ${names(esc, s.none).replace(/^<div class="small muted">|<\/div>$/g, '')}</div>`;
  if (s.held.length) sb += `<div class="small muted">予定表を送っていない: ${s.held.map(x => esc(x.name) + ' ' + x.n + '件').join('・')}</div>`;
  sb += '<div class="small muted">締め切りは原則25日。連絡がなければ締め切りの翌日に決定します。</div>';
  h += step('planning', `〜20日：${mon(s.month)}の予定表`, sb, '#schedule', '予定を開く');
  // 4. 報酬
  let yb = chips([['講師', y.staff, 'gray', true], ['確定できる', y.ready, 'ok'], ['確かめること', y.check.length, 'danger'], ['確定・支払い待ち', y.confirmed, 'warn'], ['支払い済み', y.paid, 'ok']]);
  yb += `<div class="small muted">支払日 ${md(y.payOn)}。</div>`;
  if (y.check.length) yb += '<div class="small" style="margin-top:4px">' + y.check.map(x => `<div><strong>${esc(x.name)}</strong>：${esc(x.issues.join(' / '))}</div>`).join('') + '</div>';
  if (y.unassigned) yb += `<div class="small" style="color:var(--danger)">担当の講師がいない実施済みの授業が ${y.unassigned}件あります。</div>`;
  h += step('closing', `月が終わったら〜25日：${mon(y.month)}分の報酬`, yb, '#payroll', '報酬を開く');
  return h;
}

export function settingsPage(ctx, me) {
  const { esc } = ctx, roles = me.roles;
  let h = `<div class="page-head"><h1>設定</h1></div>${ctx.notice()}`;
  h += '<div class="rows">' + card(esc, '#account', me.name + ' さん', me.email + '・パスワード・ログアウト') + '</div>';
  if (roles.includes('manager')) h += '<h2>教室の運営</h2><div class="rows">' + card(esc, '#rates', '時給と源泉徴収', '講師ごとの授業・面談の時給、源泉徴収') + card(esc, '#kinds', '授業の種類と標準料金', '計画を作るときの初期値') + '</div>';
  if (roles.includes('sysadmin')) h += '<h2>システム</h2><div class="rows">' + card(esc, '#staff', 'スタッフ', '招待・名前と役割・停止') + card(esc, '#migrate', '移行と切り替え', '今の仕組みからの写し・照らし合わせ・切り替え') + '</div>';
  return h;
}
