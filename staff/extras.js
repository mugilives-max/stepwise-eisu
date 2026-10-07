// スタッフの画面: 設定の下の「受講規約」（#terms）と「送信の記録」（#effects）。教室管理者だけ。
// 受講規約: 今の版（版・名前・全文のリンク・適用日・説明）を決める。家族ごとの同意の状態と記録。
// 送信の記録: 送れなかったメール・カレンダー（失敗・止まっているもの）を送り直す・取り下げる。最近送ったものも見える。
import { sheet, ICON } from '/staff/ui.js?v=20261008-launch1';

let terms = null, effects = null, effOpen = 0;
export function resetExtras() { terms = null; effects = null; effOpen = 0; }
export function leaveExtras() { effOpen = 0; }
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
const jst = t => t ? new Date(Date.parse(t) + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/') : '';

// ---- 受講規約 ----
export function termsPage(ctx) {
  const { esc } = ctx;
  if (!terms) { terms = { loading: true }; ctx.call('admin/terms/get').then(r => { terms = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = ctx.notice();
  if (terms.loading) return h + '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
  if (terms.error) return h + `<p class="notice error">${esc(terms.error)}</p>`;
  const t = terms.terms, f = terms.families;
  h += `<div class="pcard" style="margin-top:12px"><div class="pc-head"><strong>${t.version ? esc(t.title || '受講規約') : '規約の版がまだありません'}</strong>${t.version ? `<span class="tag">${esc(t.version)}</span>` : ''}</div>
    ${t.version ? `<p class="small muted">${t.from ? '適用 ' + esc(t.from) + '・' : ''}同意 ${f.agreed} / ${f.total} 家族${t.url ? `・<a href="${esc(t.url)}" target="_blank" rel="noopener">全文を開く</a>` : '・全文のリンクなし'}</p>${t.note ? `<p class="small">${esc(t.note)}</p>` : ''}` : '<p class="small muted">版を決めると、保護者ページに規約が出て、同意してから計画を承認する形になります。版が空のあいだは、同意は求めません。</p>'}</div>`;
  h += `<div class="sec-title">今の版を決める</div><form class="stack group" style="padding:12px" data-form="terms-set">
    <div class="row"><label style="flex:1">版（例: 2026-11）<input name="version" maxlength="40" value="${esc(t.version)}" placeholder="空にすると同意を求めない"></label><label style="flex:1">適用日<input type="date" name="from" value="${esc(t.from)}"></label></div>
    <label>規約の名前<input name="title" maxlength="80" value="${esc(t.title)}" placeholder="例: 受講規約（2026年11月版）"></label>
    <label>全文のリンク（Drive の PDF など。https://）<input type="url" name="url" maxlength="500" value="${esc(t.url)}" placeholder="https://"></label>
    <label>保護者への一言（任意。何が変わったか）<input name="note" maxlength="500" value="${esc(t.note)}"></label>
    <p class="small muted" style="margin:0">版を変えると、すべての家族が「同意が要る」状態になり、同意するまで新しい計画を承認できません（見送りはできます）。</p>
    <button class="primary"${ctx.dis()}>この版にする</button></form>`;
  h += '<div class="sec-title">同意の記録</div>' + (terms.history.length ? '<div class="group">' + terms.history.map(x => `<div class="evrow"><span class="t"><small>${esc(x.acceptedAt.slice(0, 10))}</small></span><span class="b"><span class="nm">${esc(x.familyName)}</span><small>${esc(x.version)}・${esc(x.via)}${x.actorKind === 'staff' ? '（教室が記録）' : ''}${x.note ? '・' + esc(x.note) : ''}</small></span><span></span></div>`).join('') + '</div>' : '<p class="muted small">まだありません。書面や LINE でもらった同意は、家族の画面の「規約の同意を記録」で残せます。</p>');
  return h;
}

// ---- 送信の記録 ----
export function effectsPage(ctx) {
  const { esc } = ctx;
  if (!effects) { effects = { loading: true }; ctx.call('admin/effects/list').then(r => { effects = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  let h = ctx.notice();
  if (effects.loading) return h + '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
  if (effects.error) return h + `<p class="notice error">${esc(effects.error)}</p>`;
  const row = x => `<button type="button" class="irow" data-action="eff-open" data-id="${x.id}"><span class="b"><b>${esc(x.subject || x.label)}</b><small>${esc(x.label)}${x.to ? '・' + esc(x.to) : ''}・${jst(x.createdAt)}${x.status === 'failed' ? `・<span class="tag danger">送れなかった</span>` : x.status === 'pending' ? '・<span class="tag warn">止まっている</span>' : ''}</small></span><span class="go">›</span></button>`;
  h += `<div class="sec-title">送れなかったもの${effects.failed.length ? ` <span class="count">${effects.failed.length}</span>` : ''}${effects.failed.length ? `<button class="small-btn primary" style="margin-left:auto" data-action="eff-retry-all"${ctx.dis()}>全部送り直す</button>` : ''}</div>`;
  h += effects.failed.length ? '<div class="group">' + effects.failed.map(row).join('') + '</div>' : '<p class="muted small">ありません。</p>';
  h += '<div class="sec-title">最近送ったもの</div>' + (effects.recent.length ? '<div class="group">' + effects.recent.map(row).join('') + '</div>' : '<p class="muted small">直近 30 日に送ったものはありません。</p>');
  h += `<p class="small muted">メールとカレンダーは Apps Script に頼んで送ります。失敗したものは、毎日の定期実行で 3 回まで自動で送り直します。${effects.dismissed ? `切り替え前・テスト用・取り下げで送らなかったもの ${effects.dismissed}件。` : ''}</p>`;
  const x = effOpen && [...effects.failed, ...effects.recent].find(e => e.id === effOpen);
  if (x) h += sheet(esc, x.subject || x.label, `<p class="small muted" style="margin-top:0">${esc(x.label)}${x.to ? '・' + esc(x.to) : ''}<br>作成 ${jst(x.createdAt)}${x.sentAt ? '・送信 ' + jst(x.sentAt) : ''}・試行 ${x.attempts}回</p>
    ${x.error ? `<p class="notice error small">${esc(x.error)}</p>` : ''}
    ${x.status === 'sent' ? '<p class="small">送りました。</p>' : `<div class="row"><button class="primary" data-action="eff-retry" data-id="${x.id}"${ctx.dis()}>送り直す</button><button data-action="eff-dismiss" data-id="${x.id}"${ctx.dis()}>取り下げる（送らない）</button></div>`}`, 'eff-close');
  return h;
}

// ---- 操作 ----
export async function extrasSubmit(ctx, kind, el) {
  if (kind !== 'terms-set') return false;
  const v = Object.fromEntries(new FormData(el).entries());
  if (v.version && v.version !== ((terms && terms.terms && terms.terms.version) || '') && !confirm('規約の版を変えると、すべての家族に同意をお願いする形になります。よろしいですか？')) return true;
  const r = await ctx.call('admin/terms/set', { version: v.version, title: v.title, url: v.url, from: v.from, note: v.note });
  if (r.ok) { terms = null; ctx.say(v.version ? '規約の版を決めました' : '規約の同意を求めない形にしました', 'ok'); } else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
export async function extrasClick(ctx, a, b) {
  let r;
  if (a === 'eff-open') { effOpen = Number(b.dataset.id); ctx.say(''); return true; }
  if (a === 'eff-close') { effOpen = 0; return true; }
  if (a === 'eff-retry' || a === 'eff-retry-all') {
    const ids = a === 'eff-retry' ? [Number(b.dataset.id)] : effects.failed.map(x => x.id);
    r = await ctx.call('admin/effects/retry', { ids });
    if (r.ok) { effects = null; effOpen = 0; ctx.say(r.failed ? `${r.sent}件を送り、${r.failed}件は送れませんでした: ${r.error}` : `${r.sent}件を送りました`, r.failed ? 'error' : 'ok'); }
  } else if (a === 'eff-dismiss') {
    if (!confirm('この送信を取り下げますか？（送りません）')) return true;
    r = await ctx.call('admin/effects/dismiss', { ids: [Number(b.dataset.id)] });
    if (r.ok) { effects = null; effOpen = 0; ctx.say('取り下げました', 'ok'); }
  } else return false;
  if (r && !r.ok && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
