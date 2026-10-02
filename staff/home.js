// スタッフの「今日」（docs/UX_STRUCTURE.md 3）。対応することと、今日・明日の授業。授業のあとは「実施済みにして記録」で記録の画面へ。
import { mdw, endOf, statusTag } from '/assets/v2/schedule-view.js?v=20261003-ux14';

let today = null;
export function resetToday() { today = null; }

export function todayPage(ctx, me) {
  const { esc } = ctx;
  if (!today) { today = { loading: true }; ctx.call('home/today').then(r => { today = r.ok ? r : { error: r.error.message }; if (!r.ok) ctx.handleAuth(r); ctx.render(); }); }
  if (today.loading) return '<p class="muted" style="margin-top:20px">読み込んでいます…</p>';
  if (today.error) return `<h1>今日</h1><p class="notice error">${esc(today.error)}</p>`;
  const t = today;
  let h = `<div class="page-head"><h1>今日</h1><span class="muted">${mdw(t.today)}</span></div>${ctx.notice()}`;
  if (!t.live) h += '<p class="small muted" style="margin:0 0 8px">新しい管理画面は準備中です（切り替えまでは今の管理画面が本番です）。</p>';
  // 対応すること
  h += `<h2>対応すること${t.todo.length ? ` <span class="count">${t.todo.reduce((n, x) => n + x.count, 0)}</span>` : ''}</h2>`;
  h += t.todo.length ? '<div class="rows">' + t.todo.map(x => `<a class="todo" href="${esc(x.link)}"><span class="b"><strong>${esc(x.label)}</strong>${x.note ? `<small class="muted">${esc(x.note)}</small>` : ''}</span><span class="n">${x.count}</span><span class="go">›</span></a>`).join('') + '</div>'
    : '<p class="muted small">対応することはありません。</p>';
  // 今日・明日の授業
  for (const [day, label] of [[t.today, '今日の授業'], [t.tomorrow, '明日の授業']]) {
    const ls = t.lessons.filter(l => l.date === day);
    h += `<h2>${label}${ls.length ? ` <span class="count">${ls.length}</span>` : ''}</h2>`;
    if (!ls.length) { h += '<p class="muted small">授業はありません。</p>'; continue; }
    h += '<div class="rows">' + ls.map(l => {
      const started = Date.parse(l.date + 'T' + l.start + ':00+09:00') <= t.nowMs;
      let act = '';
      if (l.status === 'decided' && started) act = `<button class="small-btn primary" data-action="td-done" data-id="${esc(l.id)}" data-version="${l.version}"${ctx.dis()}>実施済みにして記録</button>`;
      else if (l.status === 'done' && l.needsRecord) act = `<a class="small-btn primary" href="#record=${encodeURIComponent(l.id)}">記録を書く</a>`;
      else if (l.status === 'done') act = '<span class="tag ok">記録済み</span>';
      else if (l.meetUrl) act = `<a class="small-btn" href="${esc(l.meetUrl)}" target="_blank" rel="noopener">Meet</a>`;
      return `<div class="lesson-row"><span class="t">${l.start}<small>〜${endOf(l.start, l.minutes)}</small></span>
        <a class="b" href="#record=${encodeURIComponent(l.id)}"><span><strong>${esc(l.studentName)}</strong> ${esc(l.subject)}${l.kind && l.kind !== '通常' ? '<small>（' + esc(l.kind) + '）</small>' : ''}${l.deliveryMode === 'online' ? ' <small class="muted">オンライン</small>' : ''}</span>
        <span class="tags">${statusTag(l)}${ctx.isManager ? `<small class="muted">${esc(l.staffName || '担当未定')}</small>` : ''}</span></a><span class="act">${act}</span></div>`;
    }).join('') + '</div>';
  }
  h += `<p class="small" style="margin-top:14px"><a href="#schedule">予定を開く</a>${ctx.isManager ? ' ・ <a href="/kanri/?stay=1">今の管理画面</a>' : ''}</p>`;
  return h;
}

export async function todayClick(ctx, a, b) {
  if (a !== 'td-done') return false;
  const r = await ctx.call('schedule/lessons/done', { id: b.dataset.id, version: Number(b.dataset.version) });
  if (r.ok) { today = null; location.hash = '#record=' + encodeURIComponent(b.dataset.id); }
  else if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
