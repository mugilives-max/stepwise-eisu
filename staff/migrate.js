// スタッフの画面: 移行の準備（システム管理者）。今の台帳の家族・生徒が新しい形にどう写るかを見て、写す。
// 写しても今の仕組みは何も変わらない。何度でも写し直せる。保護者へのメールは切り替えまで送らない。
let preview = null, schedPreview = null, recPreview = null;
export function resetMigrate() { preview = null; schedPreview = null; recPreview = null; }

export function migratePage(ctx) {
  const { esc } = ctx;
  let h = `<h1>移行の準備</h1><p class="sub">今の仕組みの家族・生徒を、新しい形（家族の下に生徒）へ写します。写しても今の仕組みは変わりません。何度でも写し直せます。切り替えまでは、保護者へのメールは送りません。</p>${ctx.notice()}`;
  h += `<h2>1. 家族と生徒</h2><p><button data-action="mig-preview"${ctx.dis()}>${preview ? 'もう一度見る' : 'どう写るかを見る'}</button></p>`;
  if (!preview) return h + schedulePart(ctx) + recordsPart(ctx);
  const students = preview.families.reduce((n, f) => n + f.students.length, 0);
  h += `<h2>写すもの</h2><p>${preview.families.length}家族・${students}人${preview.copiedFamilies ? `（いまの新しい台帳には、前に写した ${preview.copiedFamilies}家族があります。写し直すと置き換えます）` : ''}</p>`;
  if (preview.problems.length) h += `<h2>気になる点（${preview.problems.length}件）</h2><ul>${preview.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`;
  h += '<h2>家族ごと</h2><div class="list">' + preview.families.map(f => `<div><div><strong>${esc(f.name)}</strong> <span class="tag ${f.status === 'active' ? '' : 'warn'}">${f.status === 'active' ? '保護者ページ登録済み' : f.status === 'stopped' ? '停止' : '登録待ち'}</span>${f.testOnly ? '<span class="tag gray">テスト</span>' : ''}
    <div class="small muted">${esc(f.guardianName || '保護者名なし')}・${esc(f.email || 'メールなし')}${f.phone ? '・' + esc(f.phone) : ''}</div>
    <div class="small">${f.students.map(s => `${esc(s.name)}（${esc(s.grade || '学年なし')}・${s.status === 'enrolled' ? '在籍' : s.status === 'paused' ? '休会' : '退会'}・${Number(s.baseRate30 || 0).toLocaleString('ja-JP')}円/30分）`).join('、') || '生徒なし'}</div></div><div></div></div>`).join('') + '</div>';
  h += `<p><button class="primary" data-action="mig-apply"${ctx.dis()}>この内容で新しい台帳に写す</button></p>`;
  return h + schedulePart(ctx) + recordsPart(ctx);
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
  if (a === 'mig-preview') { r = await ctx.call('admin/migrate/identity/preview'); if (r.ok) { preview = r; ctx.say(''); return true; } }
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
