// スタッフの「今日」（docs/UX_STRUCTURE.md 3）。上の帯に「今日」と日付。対応すること（色つきのアイコンと件数）と、今日・明日の授業（1枚の枠）。
// 始まった決定の授業は右の鉛筆の丸ボタンで「実施済みにして記録」へ。記録が済んだ授業は ✓
import { mdw, endOf, statusTag } from '/assets/v2/schedule-view.js?v=20261008-launch1';
import { iconBox, ICON } from '/staff/ui.js?v=20261008-launch1';

let today = null;
export function resetToday() { today = null; }
export const todayBar = () => today && today.today ? { title: '今日', sub: mdw(today.today), right: '' } : null;
// 対応することのアイコン（種類ごと）
const TODO_ICON = { requests: ['mail', '#d0533c'], records: ['comment', '#2f6fde'], handover: ['memo', '#138a8a'], homework: ['homework', '#7b4fd6'], sheets: ['file', '#2e9b5f'], tests: ['accuracy', '#e0a100'], fees: ['yen', '#c0392b'], plans: ['plan', '#5b6672'], effects: ['mail', '#c0392b'] };
const roundIcon = (k, label, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg><span class="sr">${label}</span>`;

export function todayPage(ctx, me) {
  const { esc } = ctx;
  if (!today) { today = { loading: true }; ctx.call('home/today').then(r => { today = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  if (today.loading) return '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
  if (today.error) return `<h1>今日</h1><p class="notice error">${esc(today.error)}</p>`;
  const t = today;
  let h = ctx.notice();
  // 対応すること
  const total = t.todo.reduce((n, x) => n + x.count, 0);
  h += `<div class="sec-title">対応すること${total ? ` <span class="count">${total}</span>` : ''}</div>`;
  h += t.todo.length ? '<div class="group">' + t.todo.map(x => { const [ic, color] = TODO_ICON[x.key] || ['memo', '#5b6672'];
    return `<a class="rec-row" href="${esc(x.link)}"><span class="ibox" style="background:${color}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICON[ic]}</svg></span><span class="v"><span class="lbl">${esc(x.label)}</span>${x.note ? `<small class="muted">${esc(x.note)}</small>` : ''}</span><span class="cnt">${x.count}</span></a>`; }).join('') + '</div>'
    : '<p class="muted small">対応することはありません。</p>';
  // 今日・明日の授業
  for (const [day, label] of [[t.today, '今日の授業'], [t.tomorrow, '明日の授業']]) {
    const ls = t.lessons.filter(l => l.date === day);
    h += `<div class="sec-title">${label}${ls.length ? ` <span class="count gray">${ls.length}</span>` : ''}${day === t.tomorrow ? ` <span class="muted small">${mdw(day)}</span>` : ''}</div>`;
    if (!ls.length) { h += '<p class="muted small">授業はありません。</p>'; continue; }
    h += '<div class="group">' + ls.map(l => {
      const started = Date.parse(l.date + 'T' + l.start + ':00+09:00') <= t.nowMs;
      let act = '';
      if (l.status === 'decided' && started) act = `<button class="ibtn primary" data-action="td-done" data-id="${esc(l.id)}" data-version="${l.version}" aria-label="実施済みにして記録"${ctx.dis()}>${roundIcon('pencil', '実施済みにして記録')}</button>`;
      else if (l.status === 'done' && l.needsRecord) act = `<a class="ibtn warn" href="#record=${encodeURIComponent(l.id)}" aria-label="記録を書く">${roundIcon('pencil', '記録を書く')}</a>`;
      else if (l.status === 'done') act = `<span class="ibtn ok" role="img" aria-label="記録済み">${roundIcon('check', '記録済み')}</span>`;
      else if (l.meetUrl) act = `<a class="ibtn" href="${esc(l.meetUrl)}" target="_blank" rel="noopener" aria-label="Meet を開く">${roundIcon('video', 'Meet')}</a>`;
      return `<div class="lrow"><span class="t">${l.start}<small>〜${endOf(l.start, l.minutes)}</small></span>
        <a class="b" href="#record=${encodeURIComponent(l.id)}"><span class="nm"><strong>${esc(l.studentName)}</strong> ${esc(l.subject)}${l.kind && l.kind !== '通常' ? '<small>（' + esc(l.kind) + '）</small>' : ''}</span>
        <span class="tags">${statusTag(l)}${l.deliveryMode === 'online' ? '<small class="muted">オンライン</small>' : ''}${ctx.isManager ? `<small class="muted">${esc(l.staffName || '担当未定')}</small>` : ''}</span></a>${act}</div>`;
    }).join('') + '</div>';
  }
  if (ctx.isManager && !t.live) h += '<p class="small muted" style="margin-top:14px">切り替えまでは<a href="/kanri/?stay=1">今の管理画面</a>が本番です。</p>';
  return h;
}

export async function todayClick(ctx, a, b) {
  if (a !== 'td-done') return false;
  const r = await ctx.call('schedule/lessons/done', { id: b.dataset.id, version: Number(b.dataset.version) });
  if (r.ok) { today = null; location.hash = '#record=' + encodeURIComponent(b.dataset.id); }
  else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
