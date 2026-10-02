// スタッフの画面: 移行の準備（システム管理者）。今の台帳の家族・生徒が新しい形にどう写るかを見て、写す。
// 写しても今の仕組みは何も変わらない。何度でも写し直せる。保護者へのメールは切り替えまで送らない。
let preview = null, schedPreview = null, recPreview = null, billPreview = null, compare = null, check = null, cutover = null;
export function resetMigrate() { preview = null; schedPreview = null; recPreview = null; billPreview = null; compare = null; check = null; cutover = null; }

export function migratePage(ctx) {
  const { esc } = ctx;
  let h = `<h1>移行の準備</h1><p class="sub">今の仕組みの家族・生徒を、新しい形（家族の下に生徒）へ写します。写しても今の仕組みは変わりません。何度でも写し直せます。切り替えまでは、保護者へのメールは送りません。</p>${ctx.notice()}`;
  h += `<h2>まとめて写し直す</h2><p class="small muted">一度写したあとで今の仕組みのデータが増えたときは、ここから 1→2→3→4 を順に写し直します。写した生徒につながる予定・記録・宿題・計画・請求は、新しい仕組みで入れたものも含めて置き換わります（切り替え前だけ使えます）。</p>
    <p><button class="primary" data-action="mig-all"${ctx.dis()}>全部を順に写し直す</button></p>`;
  h += `<h2>1. 家族と生徒</h2><p><button data-action="mig-preview"${ctx.dis()}>${preview ? 'もう一度見る' : 'どう写るかを見る'}</button></p>`;
  if (!preview) return h + schedulePart(ctx) + recordsPart(ctx) + billingPart(ctx) + checkPart(ctx) + cutoverPart(ctx);
  const students = preview.families.reduce((n, f) => n + f.students.length, 0);
  h += `<h2>写すもの</h2><p>${preview.families.length}家族・${students}人${preview.copiedFamilies ? `（いまの新しい台帳には、前に写した ${preview.copiedFamilies}家族があります。写し直すと置き換えます）` : ''}</p>`;
  if (preview.problems.length) h += `<h2>気になる点（${preview.problems.length}件）</h2><ul>${preview.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  h += '<h2>家族ごと</h2><div class="list">' + preview.families.map(f => `<div><div><strong>${esc(f.name)}</strong> <span class="tag ${f.status === 'active' ? '' : 'warn'}">${f.status === 'active' ? '保護者ページ登録済み' : f.status === 'stopped' ? '停止' : '登録待ち'}</span>${f.testOnly ? '<span class="tag gray">テスト</span>' : ''}
    <div class="small muted">${esc(f.guardianName || '保護者名なし')}・${esc(f.email || 'メールなし')}${f.phone ? '・' + esc(f.phone) : ''}</div>
    <div class="small">${f.students.map(s => `${esc(s.name)}（${esc(s.grade || '学年なし')}・${s.status === 'enrolled' ? '在籍' : s.status === 'paused' ? '休会' : '退会'}・${Number(s.baseRate30 || 0).toLocaleString('ja-JP')}円/30分）`).join('、') || '生徒なし'}</div></div><div></div></div>`).join('') + '</div>';
  h += `<p><button class="primary" data-action="mig-apply"${ctx.dis()}>この内容で新しい台帳に写す</button></p>`;
  return h + schedulePart(ctx) + recordsPart(ctx) + billingPart(ctx) + checkPart(ctx) + cutoverPart(ctx);
}
// 5. 照らし合わせ: 今の台帳の元の件数・金額と、写したものを並べる
function checkPart(ctx) {
  const { esc } = ctx, n = v => typeof v === 'number' ? v.toLocaleString('ja-JP') : esc(v);
  let h = `<h2>5. 照らし合わせ（件数と金額）</h2><p class="small muted">写したあとで押します。今の仕組みの元の表を直接数えて、新しい台帳と並べます。差があるときは、決めて写さないもの（理由つき）か、写し直しが要るものかを出します。</p>
    <p><button class="primary" data-action="mig-check"${ctx.dis()}>照らし合わせる</button></p>`;
  if (!check) return h;
  h += check.problems ? `<p class="notice error">確かめが要る差が ${check.problems}件あります。今の仕組みで増えた分があれば「全部を順に写し直す」をしてから、もう一度照らし合わせてください。</p>` : '<p class="notice ok">すべて合っています（差は、決めて写さないものだけです）。</p>';
  let area = '';
  h += '<div style="overflow-x:auto"><table class="small" style="width:100%"><tr><th style="text-align:left">項目</th><th>今の仕組み</th><th>新しい仕組み</th><th></th></tr>' + check.rows.map(r => {
    const head = r.area !== area ? `<tr><td colspan="4"><strong>${esc(r.area)}</strong></td></tr>` : ''; area = r.area;
    const tag = r.same ? '<span class="tag ok">同じ</span>' : r.expected ? '<span class="tag gray">決めた差</span>' : '<span class="tag danger">違う</span>';
    return head + `<tr><td>${esc(r.item)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td><td style="text-align:right">${n(r.old)}</td><td style="text-align:right">${n(r.new)}</td><td>${tag}</td></tr>`;
  }).join('') + '</table></div>';
  if (check.skip.length) h += `<h3>写さないもの（決めたこと）</h3><ul class="small">${check.skip.map(x => `<li>${esc(x.table)}（${x.count}件）: ${esc(x.why)}</li>`).join('')}</ul>`;
  return h;
}
// 6. 切り替えの予行: 切り替えた瞬間に何が起きるかを数える（何もしない）
function cutoverPart(ctx) {
  const { esc } = ctx;
  let h = `<h2>6. 切り替えの予行</h2><p class="small muted">切り替えたときに起きること（保護者のログイン・カレンダー・残っている対応）を数えます。実際には何も送らず、何も変えません。</p>
    <p><button data-action="mig-cutover"${ctx.dis()}>予行する</button></p>`;
  if (!cutover) return h;
  const c = cutover, f = c.families;
  h += `<div class="sheet stack small"><div>状態: ${c.live ? '<strong>切り替え済み</strong>' : 'まだ切り替えていない（保護者へのメール・カレンダーは止めてある）'}・最後に写した時刻 ${esc(c.lastCopy ? c.lastCopy.slice(0, 16).replace('T', ' ') + '（UTC）' : 'まだ')}</div>
    <div><strong>保護者</strong>（子どもがいる家族 ${f.total}）: 今のパスワードでログインできる ${f.canLogin}・登録の案内を送る ${f.needInvite}・メールアドレスなし ${f.noEmail}${f.testOnly ? `・テスト用 ${f.testOnly}` : ''}</div>
    <div><strong>生徒</strong> ${c.students}人: 今の専用リンクの鍵のまま新しいページを開ける</div>
    <div><strong>カレンダー</strong>（今日以降の決定の授業・面談）: 今の予定を引き継ぐ ${c.calendar.keep}・新しく作る ${c.calendar.create}${c.calendar.onlineWithoutMeet ? `・<strong>Meet のないオンライン授業 ${c.calendar.onlineWithoutMeet}</strong>（切り替えたあとで作り直す）` : ''}</div>
    <div><strong>残っている対応</strong>: 連絡 ${c.open.requests}・キャンセル料の判断 ${c.open.fees}・承認待ちの計画 ${c.open.plans}・仮予定 ${c.open.proposed}</div>
    <div class="muted">切り替え前に止めてあったお知らせ ${c.open.held}件は、切り替えても送りません（古い内容のため）。</div></div>`;
  return h;
}
// 4. 計画・キャンセル料・請求（授業記録まで写したあと）と、請求の比べ合わせ
function billingPart(ctx) {
  const { esc } = ctx, yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
  let h = `<h2>4. 授業計画・キャンセル料・請求</h2><p class="small muted">予定まで写したあとで使います。今の仕組みでは消えているキャンセルの授業は、控えから作ります。取り消した請求は写しません。</p>
    <p><button data-action="mig-b-preview"${ctx.dis()}>${billPreview ? 'もう一度見る' : 'どう写るかを見る'}</button></p>`;
  if (billPreview) {
    const b = billPreview;
    h += `<p>授業計画 ${b.planLines.total}件（承認 ${b.planLines.approved}・承認待ち ${b.planLines.proposed}）、キャンセルの授業 ${b.cancelled}件・お休み ${b.rested}件、キャンセル料 ${b.fees}件、請求 ${b.invoices.total}件（入金済み ${b.invoices.paid}・${esc(b.invoices.months.join('・') || '月なし')}）</p>`;
    if (b.problems.length) h += `<ul>${b.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
    h += `<p><button class="primary" data-action="mig-b-apply"${ctx.dis()}>計画・請求を新しい台帳に写す</button></p>`;
  }
  h += `<h3>請求を比べる</h3><p class="small muted">写した請求（今の仕組みの金額）と、新しい仕組みで計算し直した金額を、家族ごとに並べます。</p>
    <form class="row" data-form="mig-compare"><input type="month" name="month" value="${esc(compare ? compare.month : '')}" required><button${ctx.dis()}>比べる</button></form>`;
  if (compare) {
    h += compare.families.length ? '<div class="list">' + compare.families.map(f => `<div><div><strong>${esc(f.name)}</strong> <span class="tag ${f.same ? 'ok' : 'danger'}">${f.same ? '同じ' : '違う'}</span>
      <div class="small">今の仕組み ${yen(f.old)}${f.oldFrom === '' ? '（請求なし）' : ''}／新しい計算 ${yen(f.new)}${f.pendingCount ? `・計画の承認がない授業 ${f.pendingCount}件` : ''}</div>
      ${f.issues.length ? `<ul class="small">${f.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}<div class="small muted">${f.students.map(s => `${esc(s.name)} ${yen(s.total)}（${s.items}件${s.pending ? '・承認待ち ' + s.pending + '件' : ''}）`).join('、')}</div></div><div></div></div>`).join('') + '</div>' : '<p class="muted">この月の請求はありません。</p>';
  }
  return h;
}
export async function migrateSubmit(ctx, kind, el) {
  if (kind !== 'mig-compare') return false;
  const month = new FormData(el).get('month');
  const r = await ctx.call('admin/migrate/billing/compare', { month });
  if (r.ok) { compare = r; ctx.say(''); } else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
// 3. 授業記録・宿題（予定を写したあと）
function recordsPart(ctx) {
  const { esc } = ctx;
  let h = `<h2>3. 授業記録・宿題・授業準備のメモ</h2><p class="small muted">予定を写したあとで使います。公開した版・先生だけのメモ・宿題の状態をそのまま写します。授業準備のメモは引き継ぎメモになります。</p>
    <p><button data-action="mig-r-preview"${ctx.dis()}>${recPreview ? 'もう一度見る' : 'どう写るかを見る'}</button></p>`;
  if (!recPreview) return h;
  h += `<p>授業記録 ${recPreview.records.total}件（公開 ${recPreview.records.published}・無効 ${recPreview.records.void}）、宿題 ${recPreview.homework.total}件（未完了 ${recPreview.homework.open}・できた報告 ${recPreview.homework.reported}・確認済み ${recPreview.homework.confirmed}）、引き継ぎメモ ${recPreview.handover}件</p>`;
  if (recPreview.problems.length) h += `<ul>${recPreview.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  return h + `<p><button class="primary" data-action="mig-r-apply"${ctx.dis()}>授業記録・宿題を新しい台帳に写す</button></p>`;
}
// 2. 予定（家族・生徒を写したあと）
function schedulePart(ctx) {
  const { esc } = ctx;
  let h = `<h2>2. 予定（授業・連絡・共有予定・休み・授業の種類）</h2><p class="small muted">家族と生徒を写したあとで使います。授業希望は写しません（やめる機能）。キャンセル済みの授業とキャンセル料は、請求の段階で写します。</p>
    <p><button data-action="mig-s-preview"${ctx.dis()}>${schedPreview ? 'もう一度見る' : 'どう写るかを見る'}</button></p>`;
  if (!schedPreview) return h;
  const l = schedPreview.lessons;
  h += `<p>授業 ${l.total}件（未送信 ${l.held}・仮予定 ${l.proposed}・決定 ${l.decided}・実施済み ${l.done}）、連絡 ${schedPreview.requests}件、共有予定 ${schedPreview.sharedEvents}件、休み ${schedPreview.unavailability}件、授業の種類 ${esc(schedPreview.kinds.join('・'))}${schedPreview.copied ? `（前に写した授業 ${schedPreview.copied}件を置き換えます）` : ''}</p>`;
  if (schedPreview.problems.length) h += `<ul>${schedPreview.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  return h + `<p><button class="primary" data-action="mig-s-apply"${ctx.dis()}>予定を新しい台帳に写す</button></p>`;
}

export async function migrateClick(ctx, a) {
  let r;
  if (a === 'mig-all') {
    if (!confirm('家族・生徒 → 予定 → 授業記録・宿題 → 計画・請求 の順に、全部を写し直しますか？ 写した生徒につながる予定・記録・宿題・計画・請求は置き換わります。今の仕組みは変わりません。')) return true;
    r = await ctx.call('admin/migrate/all/apply', { confirm: true });
    if (r.ok) {
      preview = null; schedPreview = null; recPreview = null; ctx.afterMigrate();
      const probs = [...r.identity.problems, ...r.schedule.problems, ...r.records.problems, ...r.billing.problems];
      ctx.say(`${r.identity.families}家族・${r.identity.students}人、授業 ${r.schedule.lessons}件、授業記録 ${r.records.records}件・宿題 ${r.records.homework}件、計画 ${r.billing.planLines}件・請求 ${r.billing.invoices}件を写しました。${probs.length ? '気になる点: ' + probs.join(' / ') : ''}`, 'ok'); return true;
    }
  } else if (a === 'mig-check') { r = await ctx.call('admin/migrate/check'); if (r.ok) { check = r; ctx.say(''); return true; } }
  else if (a === 'mig-cutover') { r = await ctx.call('admin/cutover/preview'); if (r.ok) { cutover = r; ctx.say(''); return true; } }
  else if (a === 'mig-b-preview') { r = await ctx.call('admin/migrate/billing/preview'); if (r.ok) { billPreview = r; ctx.say(''); return true; } }
  else if (a === 'mig-b-apply') {
    if (!confirm('今の仕組みの授業計画・キャンセル料・請求を、新しい台帳に写しますか？ 前に写したものは置き換えます。今の仕組みは変わりません。')) return true;
    r = await ctx.call('admin/migrate/billing/apply', { confirm: true });
    if (r.ok) { billPreview = null; ctx.afterMigrate(); ctx.say(`計画 ${r.planLines}件・キャンセル料 ${r.fees}件・請求 ${r.invoices}件を写しました。「請求を比べる」で確かめてください`, 'ok'); return true; }
  } else if (a === 'mig-preview') { r = await ctx.call('admin/migrate/identity/preview'); if (r.ok) { preview = r; ctx.say(''); return true; } }
  else if (a === 'mig-apply') {
    if (!confirm('今の仕組みの家族・生徒を、新しい台帳に写しますか？ 前に写したものは置き換えます。今の仕組みは変わりません。')) return true;
    r = await ctx.call('admin/migrate/identity/apply', { confirm: true });
    if (r.ok) { preview = null; ctx.afterMigrate(); ctx.say(`${r.families}家族・${r.students}人を写しました。「家族と生徒」で確かめてください`, 'ok'); return true; }
  } else if (a === 'mig-r-preview') { r = await ctx.call('admin/migrate/records/preview'); if (r.ok) { recPreview = r; ctx.say(''); return true; } }
  else if (a === 'mig-r-apply') {
    if (!confirm('今の仕組みの授業記録・宿題を、新しい台帳に写しますか？ 前に写したものは置き換えます。今の仕組みは変わりません。')) return true;
    r = await ctx.call('admin/migrate/records/apply', { confirm: true });
    if (r.ok) { recPreview = null; ctx.afterMigrate(); ctx.say(`授業記録 ${r.records}件・宿題 ${r.homework}件・引き継ぎメモ ${r.handover}件を写しました。「記録」で確かめてください`, 'ok'); return true; }
  } else if (a === 'mig-s-preview') { r = await ctx.call('admin/migrate/schedule/preview'); if (r.ok) { schedPreview = r; ctx.say(''); return true; } }
  else if (a === 'mig-s-apply') {
    if (!confirm('今の仕組みの予定を、新しい台帳に写しますか？ 前に写した予定は置き換えます。今の仕組みは変わりません。カレンダーへの登録や保護者へのメールは行いません。')) return true;
    r = await ctx.call('admin/migrate/schedule/apply', { confirm: true });
    if (r.ok) { schedPreview = null; ctx.afterMigrate(); ctx.say(`授業 ${r.lessons}件・連絡 ${r.requests}件・共有予定 ${r.sharedEvents}件・休み ${r.unavailability}件を写しました。「予定」で確かめてください`, 'ok'); return true; }
  } else return false;
  if (r && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
