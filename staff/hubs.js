// スタッフの「月の仕事」と「設定」（docs/UX_STRUCTURE.md 3）。今は今までの画面への入口。月の仕事の進み具合の表示は、あとで作り込む（作る順番の5）。
const card = (esc, href, title, note) => `<a class="todo" href="${href}"><span class="b"><strong>${esc(title)}</strong><small class="muted">${esc(note)}</small></span><span class="go">›</span></a>`;

export function monthlyPage(ctx) {
  const { esc } = ctx, d = new Date(Date.now() + 9 * 3600e3), m = d.getUTCMonth() + 1, prev = m === 1 ? 12 : m - 1, next = m === 12 ? 1 : m + 1;
  return `<div class="page-head"><h1>月の仕事</h1><span class="muted">${m}月</span></div>${ctx.notice()}
    <h2>1〜2日：${prev}月分の請求</h2><div class="rows">${card(esc, '#billing', '請求を確かめる', '3日の0時10分に自動で確定します。キャンセル料の判断もここ')}</div>
    <h2>〜20日：${next}月の計画と予定表</h2><div class="rows">${card(esc, '#plans', '授業計画', '先月と同じ内容で下書き → 家族にお知らせ → 承認を待つ')}${card(esc, '#schedule', '予定表（仮予定）', '月の表で仮予定を作り、予定表にまとめて送る')}</div>
    <h2>月が終わったら〜25日：${prev}月分の報酬</h2><div class="rows">${card(esc, '#payroll', '講師の報酬', '確かめて確定 → 25日に支払って記録')}</div>`;
}

export function settingsPage(ctx, me) {
  const { esc } = ctx, roles = me.roles;
  let h = `<div class="page-head"><h1>設定</h1></div>${ctx.notice()}<div class="rows">`;
  if (roles.includes('sysadmin')) h += card(esc, '#staff', 'スタッフ', '招待・役割・停止');
  if (roles.includes('manager')) h += card(esc, '#payroll', '時給と源泉徴収', '「報酬」の下にあります') + card(esc, '#plans', '授業の種類と標準料金', '「計画」の下にあります');
  if (roles.includes('sysadmin')) h += card(esc, '#migrate', '移行と切り替え', '今の仕組みからの写し・照らし合わせ・切り替え');
  h += card(esc, '#account', 'アカウント', 'パスワード・ログアウト') + '</div>';
  return h;
}
