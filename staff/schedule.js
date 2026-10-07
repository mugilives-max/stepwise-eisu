// スタッフの画面: 予定（3段目）。月の予定表・選んだ日の授業・連絡への対応・仮予定を作る・休み・面談。
// 教室管理者はすべて、講師は自分の担当の授業と自分の休みだけ。
import { STATUS, REQUEST, EVENT_KIND, mdw, endOf, statusTag, requestTags } from '/assets/v2/schedule-view.js?v=20261008-launch1';
import { nowLocal } from '/assets/v2/cancel-rate.js?v=20261008-launch1';

let month = null, data = null, sel = null, sheet = null, families = null, loadedFor = '';
// スマホ（ライフベアの形）: はじめは月全体。日付を押すと、その週が一番上まで滑り上がり、下から一覧が出る（2週分）。同じ日をもう一度押すか取っ手で月全体に戻る
let calOpen = true, wasOpen = true, calH = null, calTop = null, shownSel = '';
const phone = () => matchMedia('(max-width: 719px)').matches;
// 新しい決まりの取消料（規約案 第4〜7条）の授業か。授業の日が cancelRuleFrom 以降
const rateRule = l => !!(data && data.cancelRuleFrom && l.date >= data.cancelRuleFrom);
// sheet: 下から出る画面。{ kind: 'lesson', id, edit, cancel, tardy } / { kind: 'create' } / { kind: 'off' } / { kind: 'meeting' } / { kind: 'todo' }
const ymOf = d => d.slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const gridStart = ym => { const first = new Date(ym + '-01T00:00:00Z'); return new Date(first - first.getUTCDay() * 86400e3).toISOString().slice(0, 10); };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export function resetSchedule() { data = null; loadedFor = ''; sheet = null; cache = {}; }
// 月ごとに読んだ予定をとっておく（スワイプで月を変えたとき、すぐ出せるように。前後の月は先に読んでおく）。予定を変えたら捨てる
let cache = {}, swipeAt = 0, slideIn = '';
// 月の表では、生徒ごとに授業をまとめ、まだ決まっていないものがあればその色で出す
const RANK = { held: 0, proposed: 1, decided: 2, done: 3 };

function prefetchNear(ctx) {
  for (const m of [addMonths(month, -1), addMonths(month, 1)]) {
    if (cache[m]) continue;
    const from = gridStart(m); ctx.call('schedule/staff/range', { from, to: addDays(from, 41) }).then(r => { if (r.ok && !cache[m]) cache[m] = r; });
  }
}
async function load(ctx) {
  const from = gridStart(month), to = addDays(from, 41);
  loadedFor = month;
  const r = await ctx.call('schedule/staff/range', { from, to });
  if (!r.ok) { if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); data = { lessons: [], openRequests: [], events: [], unavailability: [], meetings: [], students: [], staff: [], kinds: ['通常'], today: '', error: true }; }
  else { data = r; cache[month] = r; if (!sel) sel = r.today; prefetchNear(ctx); }
  ctx.render();
}

// 月の表に出す短い名前: 姓。同じ姓の生徒がいれば名
function shortNames() {
  const fam = {}; data.students.forEach(s => { const f = s.name.split(' ')[0]; fam[f] = (fam[f] || 0) + 1; });
  return Object.fromEntries(data.students.map(s => { const [f, g] = s.name.split(' '); return [s.id, fam[f] > 1 && g ? g : f]; }));
}

export function schedulePage(ctx, me) {
  const { esc } = ctx, manager = me.roles.includes('manager');
  if (!month) month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  if ((!data || loadedFor !== month) && cache[month]) { data = cache[month]; loadedFor = month; prefetchNear(ctx); } // 先に読んであった月はすぐ出す
  if (!data || loadedFor !== month) { if (loadedFor !== month) load(ctx); return '<p class="muted" style="margin-top:20px">読み込んでいます…</p>'; }
  const nameOf = Object.fromEntries(data.students.map(s => [s.id, s.name])), staffOf = Object.fromEntries(data.staff.map(s => [s.id, s.name])), short = shortNames();
  const held = {}; data.lessons.filter(l => l.status === 'held').forEach(l => { held[l.studentId] = (held[l.studentId] || 0) + 1; });
  const todo = manager ? data.openRequests.length + Object.keys(held).length : 0;
  // 上の帯: 月の切り替え・今日・対応すること・作る
  let h = `<div class="sch-bar"><button class="icon" data-action="sch-month" data-n="-1" aria-label="前の月">‹</button><strong class="sch-month">${Number(month.slice(0, 4))}年${Number(month.slice(5))}月</strong><button class="icon" data-action="sch-month" data-n="1" aria-label="次の月">›</button>
    <button class="small-btn" data-action="sch-today">今日</button><span style="flex:1"></span>
    ${todo ? `<button class="small-btn warn" data-action="sch-sheet" data-k="todo">対応すること ${todo}</button>` : ''}
    <button class="small-btn primary" data-action="sch-sheet" data-k="${manager ? 'create' : 'off'}">＋ ${manager ? '仮予定' : '休み'}</button></div>`;
  if (!data.live) h += '<p class="small muted" style="margin:2px 0 6px">切り替え前のため、ここでの操作では Google カレンダーへの登録と保護者へのメールは行いません。</p>';
  h += ctx.notice();
  h += '<div class="sch">';
  // 月の表
  h += `<div class="cal-win">`;
  h += '<div class="month2">' + ['日', '月', '火', '水', '木', '金', '土'].map((w, i) => `<div class="wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('');
  const start = gridStart(month);
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i === 35 && ymOf(d) !== month) break; // 6週目がまるごと次の月なら描かない
    const ls = data.lessons.filter(l => l.date === d && l.status in RANK);
    const bars = data.events.filter(e => e.date <= d && d <= e.dateTo && e.kind !== 'unavailable').map(e => `<span class="bar ${e.kind}">${esc(e.title || 'テスト')}</span>`)
      .concat(data.unavailability.filter(o => o.date === d).map(o => `<span class="bar off">${o.staffId ? '休み' : '休校'}</span>`))
      .concat(data.meetings.filter(m => m.date === d).map(() => '<span class="bar meeting">面談</span>'));
    const by = {}; ls.forEach(l => { const g = by[l.studentId] = by[l.studentId] || { n: 0, rank: 9 }; g.n++; g.rank = Math.min(g.rank, RANK[l.status]); });
    const chips = Object.entries(by).map(([sid, g]) => `<span class="nm r${g.rank}">${esc(short[sid] || '')}${g.n > 1 ? `<small>×${g.n}</small>` : ''}</span>`);
    const lines = bars.concat(chips), shown = lines.slice(0, 4), more = lines.length - shown.length;
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    h += `<button class="cell${ymOf(d) !== month ? ' out' : ''}${d === sel ? ' sel' + (shownSel && shownSel !== sel ? ' enter' : '') : ''}${d === data.today ? ' today' : ''}" data-action="sch-day" data-date="${d}" aria-label="${mdw(d)} 授業${ls.length}件">`
      + `<span class="num${wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''}">${Number(d.slice(8))}</span>${shown.join('')}${more > 0 ? `<span class="more">+${more}</span>` : ''}</button>`;
  }
  h += '</div></div>';
  if (!calOpen || !phone()) h += `<div class="cal-handle" role="separator" aria-label="下へ引くと月全体に戻る"><span></span></div>`; // 取っ手: 下へ引くと閉じる（押しただけでは何もしない）
  const changed = shownSel && shownSel !== sel; shownSel = sel;
  const showDay = !calOpen || !phone(), leaving = calOpen && !wasOpen && phone();
  if (showDay || leaving) h += `<div class="sch-day${changed && showDay && !wasOpen ? ' enter' : ''}${leaving ? ' leaving' : ''}">${dayPanel(ctx, me, manager, nameOf, staffOf)}</div>`;
  h += '</div>';
  animCal(ctx);
  if (sheet) h += sheetHtml(ctx, me, manager, nameOf, staffOf, held);
  return h;
}

// スマホ: カレンダーの窓の高さと位置を、前の形から新しい形へ 0.38秒で動かす（最初は速く、最後はゆっくり）。一覧は下から出入りする
let animPending = false;
function animCal(ctx) {
  setTimeout(() => { bindDrag(ctx); bindSwipe(ctx); }, 0); // 描くたびに、取っ手と月の表に指の動きを付ける（動きの途中でも）
  if (animPending) return; animPending = true; // 続けて描き直しても、最後に描いた画面で1回だけ動かす
  requestAnimationFrame(() => {
    animPending = false;
    const win = document.querySelector('.cal-win'); if (!win) return;
    if (!phone()) { win.style.maxHeight = ''; wasOpen = calOpen; return; }
    const wd = win.querySelector('.wd'), cell = win.querySelector('.cell.sel') || win.querySelector('.cell.today') || win.querySelector('.cell');
    const wdH = wd ? wd.offsetHeight : 0, rowH = cell ? cell.offsetHeight : 74, full = win.scrollHeight;
    const toH = calOpen ? full : wdH + 2 * rowH, toTop = calOpen ? 0 : Math.max(0, (cell ? cell.offsetTop : 0) - wdH);
    const fromH = calH === null ? toH : calH, fromTop = calTop === null ? toTop : calTop;
    const day = document.querySelector('.sch-day'), opening = !calOpen && wasOpen;
    calH = toH; calTop = toTop; wasOpen = calOpen;
    const done = () => { win.style.maxHeight = calOpen ? 'none' : toH + 'px'; win.scrollTop = toTop; };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || (Math.abs(fromH - toH) < 2 && Math.abs(fromTop - toTop) < 2)) { done(); if (day && day.classList.contains('leaving')) day.remove(); return; }
    const ms = 380, ease = q => 1 - Math.pow(1 - q, 3), t0 = performance.now();
    win.style.maxHeight = fromH + 'px'; win.scrollTop = fromTop;
    const step = now => { const q = Math.min(1, (now - t0) / ms), e = ease(q); win.style.maxHeight = fromH + (toH - fromH) * e + 'px'; win.scrollTop = fromTop + (toTop - fromTop) * e; if (q < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
    if (day && opening) day.animate([{ transform: 'translateY(60vh)', opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: ms, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    if (day && day.classList.contains('leaving')) day.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(60vh)', opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => day.remove();
    win.addEventListener('scroll', () => { if (!calOpen) calTop = win.scrollTop; }, { passive: true });
  });
}
// 月の表を左右にスワイプ: 指に付いて動き、2割以上か素早く払えば次（左へ）・前（右へ）の月へ滑って替わる。足りなければ戻る
const EASE = 'cubic-bezier(.32, .72, 0, 1)';
function bindSwipe(ctx) {
  const win = document.querySelector('.cal-win'), grid = win && win.querySelector('.month2'); if (!grid) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (slideIn && !still) grid.animate([{ transform: `translateX(${slideIn === 'next' ? 60 : -60}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE });
  slideIn = '';
  let x0 = null, y0 = 0, dx = 0, horiz = null, lastX = 0, lastT = 0, v = 0;
  win.onpointerdown = e => { if (e.pointerType === 'mouse') return; x0 = lastX = e.clientX; y0 = e.clientY; dx = 0; v = 0; horiz = null; lastT = e.timeStamp; };
  win.onpointermove = e => {
    if (x0 === null) return;
    const ddx = e.clientX - x0, ddy = e.clientY - y0;
    if (horiz === null && Math.abs(ddx) + Math.abs(ddy) > 10) horiz = Math.abs(ddx) > Math.abs(ddy) * 1.2;
    if (!horiz) return;
    dx = ddx; v = (e.clientX - lastX) / Math.max(1, e.timeStamp - lastT); lastX = e.clientX; lastT = e.timeStamp;
    grid.style.transform = `translateX(${dx}px)`; grid.style.opacity = String(1 - Math.min(.5, Math.abs(dx) / win.offsetWidth * .7));
  };
  const end = () => {
    if (x0 === null) return; x0 = null; if (!horiz) return; swipeAt = Date.now();
    const W = win.offsetWidth, go = Math.abs(dx) > W * .2 || (Math.abs(v) > .4 && Math.abs(dx) > 24), dir = dx < 0 ? 'next' : 'prev';
    const a = grid.animate([{ transform: `translateX(${dx}px)`, opacity: Number(grid.style.opacity || 1) }, go ? { transform: `translateX(${dx < 0 ? -W : W}px)`, opacity: 0 } : { transform: 'none', opacity: 1 }],
      { duration: still ? 1 : go ? 200 : 240, easing: go ? 'cubic-bezier(.4, 0, 1, 1)' : EASE, fill: 'forwards' });
    let finished = false; // 動きが止まっても（画面が描かれていないときなど）、少し待てば必ず月を替える
    const fin = () => {
      if (finished) return; finished = true;
      if (!go) { grid.style.transform = ''; grid.style.opacity = ''; a.cancel(); return; }
      month = addMonths(month, dir === 'next' ? 1 : -1); sel = month + '-01'; sheet = null;
      calOpen = true; wasOpen = true; calH = null; calTop = null; slideIn = dir; ctx.render();
    };
    a.onfinish = fin; setTimeout(fin, (still ? 1 : go ? 200 : 240) + 150);
  };
  win.onpointerup = end; win.onpointercancel = end;
}
// 取っ手を下へ引く: 引いた分だけカレンダーが広がり、一覧は薄くなる。約70px 以上か、素早く払ったら閉じて月全体へ。足りなければ元へ戻る
function bindDrag(ctx) {
  const hd = document.querySelector('.cal-handle'), win = document.querySelector('.cal-win'), day = document.querySelector('.sch-day');
  if (!hd || !win || !day || calOpen || !phone()) return;
  let y0 = null, dy = 0, lastY = 0, lastT = 0, v = 0, twoH = 0, full = 0, top0 = 0;
  const apply = d => { const q = Math.min(1, d / Math.max(1, full - twoH)); win.style.maxHeight = twoH + (full - twoH) * q + 'px'; win.scrollTop = top0 * (1 - q); day.style.opacity = String(1 - q * 0.7); };
  hd.onpointerdown = e => { y0 = lastY = e.clientY; lastT = e.timeStamp; dy = 0; v = 0; twoH = win.offsetHeight; full = win.scrollHeight; top0 = win.scrollTop; try { hd.setPointerCapture(e.pointerId); } catch {} hd.classList.add('grab'); };
  hd.onpointermove = e => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); v = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT); lastY = e.clientY; lastT = e.timeStamp; apply(dy); };
  const end = () => {
    if (y0 === null) return; y0 = null; hd.classList.remove('grab');
    const close = dy > 70 || (v > 0.5 && dy > 16), fromD = dy, toD = close ? Math.max(1, full - twoH) : 0, ms = close ? 260 : 220, t0 = performance.now(), ease = q => 1 - Math.pow(1 - q, 3);
    const step = now => {
      const q = Math.min(1, (now - t0) / ms); apply(fromD + (toD - fromD) * ease(q));
      if (q < 1) return requestAnimationFrame(step);
      if (close) { calOpen = true; wasOpen = true; calH = full; calTop = 0; ctx.render(); } else { day.style.opacity = ''; }
    };
    requestAnimationFrame(step);
  };
  hd.onpointerup = end; hd.onpointercancel = end;
}
// 選んだ日の一覧と、そのあとの6日（1行ずつ。押すと下から詳しい画面）
function dayPanel(ctx, me, manager, nameOf, staffOf) {
  const last = addDays(gridStart(month), 41);
  let h = oneDay(ctx, me, manager, nameOf, staffOf, sel, true);
  for (let i = 1; i <= 6; i++) { const d = addDays(sel, i); if (d > last) break; h += oneDay(ctx, me, manager, nameOf, staffOf, d, false); }
  return h;
}
function oneDay(ctx, me, manager, nameOf, staffOf, d, first) {
  const { esc } = ctx;
  const ls = data.lessons.filter(l => l.date === d).sort((a, b) => a.start.localeCompare(b.start)), offs = data.unavailability.filter(o => o.date === d), evs = data.events.filter(e => e.date <= d && d <= e.dateTo), mts = data.meetings.filter(m => m.date === d);
  let h = first ? `<div class="day-title"><strong>${mdw(d)}</strong><span class="muted small">授業 ${ls.filter(l => l.status in RANK).length}件</span><span style="flex:1"></span>${manager ? '<button class="small-btn" data-action="sch-sheet" data-k="create">＋ この日に仮予定</button>' : ''}</div>`
    : `<button class="day-band" data-action="sch-day" data-date="${d}">${mdw(d)}</button>`;
  if (!ls.length && !offs.length && !evs.length && !mts.length) return h + `<p class="muted small"${first ? '' : ' style="margin:4px 2px 8px"'}>予定はありません。</p>`;
  h += '<div class="rows">';
  evs.forEach(e => { h += `<div class="ev ${e.kind}"><span class="t">${e.start ? e.start + '〜' : '終日'}</span><span class="b">${EVENT_KIND[e.kind]}：${esc(e.studentName)} ${esc(e.title)}</span>${manager ? `<button class="x" data-action="sch-ev-del" data-id="${esc(e.id)}" aria-label="消す"${ctx.dis()}>×</button>` : ''}</div>`; });
  offs.forEach(o => { h += `<div class="ev off"><span class="t">${o.start ? o.start + '〜' + o.end : '終日'}</span><span class="b">休み：${esc(o.staffId ? staffOf[o.staffId] || '' : '教室全体')} ${esc(o.note)}</span>${manager || o.staffId === me.id ? `<button class="x" data-action="sch-off-del" data-id="${esc(o.id)}" aria-label="消す"${ctx.dis()}>×</button>` : ''}</div>`; });
  mts.forEach(m => { h += `<div class="ev meeting"><span class="t">${m.start}〜${endOf(m.start, m.minutes)}</span><span class="b">面談：${esc(m.title)}${m.deliveryMode === 'online' ? '（オンライン）' : ''}</span><button class="x" data-action="sch-mt-cancel" data-id="${esc(m.id)}" aria-label="取りやめる"${ctx.dis()}>×</button></div>`; });
  ls.forEach(l => {
    h += `<button class="lesson s-${l.status}" data-action="sch-open" data-id="${esc(l.id)}"><span class="t">${l.start}<small>〜${endOf(l.start, l.minutes)}</small></span>`
      + `<span class="b"><span><strong>${esc(nameOf[l.studentId] || '')}</strong> ${esc(l.subject)}${l.kind !== '通常' ? '<small>（' + esc(l.kind) + '）</small>' : ''}${l.deliveryMode === 'online' ? ' <small class="muted">オンライン</small>' : ''}</span>`
      + `<span class="tags">${statusTag(l)}${requestTags(l)}<small class="muted">${esc(staffOf[l.staffId] || '担当未定')}</small></span></span><span class="go">›</span></button>`;
  });
  return h + '</div>';
}

// 下から出る画面（パソコンでは真ん中に出る）
function sheetHtml(ctx, me, manager, nameOf, staffOf, held) {
  const { esc } = ctx;
  let title = '', body = '';
  if (sheet.kind === 'lesson') {
    const l = lessonById(sheet.id); if (!l) { sheet = null; return ''; }
    const past = l.date <= data.today, mine = manager || l.staffId === me.id;
    title = `${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}`;
    body = `<div class="stack" style="margin:0"><div><strong style="font-size:17px">${esc(nameOf[l.studentId] || '')}</strong> ${esc(l.subject)}${l.kind !== '通常' ? '（' + esc(l.kind) + '）' : ''}</div>
      <div>${statusTag(l)}${requestTags(l)}${l.lateStart ? '<span class="tag gray">当日の時間変更</span>' : ''}${l.lostMinutes ? `<span class="tag warn">遅刻 ${l.lostMinutes}分</span>` : ''}</div>
      <div class="small muted">担当 ${esc(staffOf[l.staffId] || '未定')}・${l.deliveryMode === 'online' ? 'オンライン' : '対面'}${l.meetUrl ? `・<a href="${esc(l.meetUrl)}" target="_blank" rel="noopener">Meet を開く</a>` : ''}${l.note ? '<br>メモ：' + esc(l.note) : ''}</div>`;
    if (sheet.edit) body += editForm(ctx, l);
    else if (sheet.cancel) body += cancelForm(ctx, l);
    else if (sheet.tardy) body += tardyForm(ctx, l);
    else {
      const main = [], sub = [], danger = [];
      if (manager && ['held', 'proposed'].includes(l.status)) main.push(`<button class="primary" data-action="sch-decide" data-id="${esc(l.id)}"${ctx.dis()}>決定する</button>`);
      if (l.status === 'decided' && past && mine) main.push(`<button class="primary" data-action="sch-done" data-id="${esc(l.id)}"${ctx.dis()}>実施済みにする</button>`);
      if (['decided', 'done'].includes(l.status) && past && mine) main.push(`<a class="btn" href="#record=${encodeURIComponent(l.id)}">記録を書く</a>`);
      if (manager && ['held', 'proposed', 'decided'].includes(l.status)) sub.push(`<button data-action="sch-edit" data-id="${esc(l.id)}"${ctx.dis()}>日時・内容を直す</button>`);
      if (manager && ['proposed', 'decided'].includes(l.status)) sub.push(`<button data-action="sch-rest" data-id="${esc(l.id)}"${ctx.dis()}>お休みにする</button>`);
      if (['decided', 'done'].includes(l.status) && mine && rateRule(l) && Date.now() >= Date.parse(l.date + 'T' + l.start + ':00+09:00')) sub.push(`<button data-action="sch-tardy" data-id="${esc(l.id)}"${ctx.dis()}>${l.lostMinutes ? '遅刻を直す' : '遅刻を記録'}</button>`);
      if (manager && l.status === 'decided') danger.push(`<button class="danger" data-action="sch-cancel" data-id="${esc(l.id)}"${ctx.dis()}>キャンセルにする</button>`);
      if (manager && l.status !== 'done') danger.push(`<button class="danger" data-action="sch-delete" data-id="${esc(l.id)}"${ctx.dis()}>削除（入力ミス）</button>`);
      body += (main.length ? `<div class="row">${main.join('')}</div>` : '') + (sub.length ? `<div class="row">${sub.join('')}</div>` : '')
        + (danger.length ? `<details class="small"><summary class="muted">そのほかの操作</summary><div class="row" style="margin-top:8px">${danger.join('')}</div></details>` : '');
    }
    body += '</div>';
  } else if (sheet.kind === 'create') { title = '仮予定を作る'; body = createForm(ctx, me); }
  else if (sheet.kind === 'off') { title = '休みを登録'; body = offForm(ctx, me, manager); }
  else if (sheet.kind === 'meeting') { title = '面談を登録'; body = meetingForm(ctx); }
  else if (sheet.kind === 'todo') {
    title = '対応すること';
    body = (data.openRequests.length ? `<h2 style="margin-top:0">生徒・保護者からの連絡（${data.openRequests.length}件）</h2><div class="list">` + data.openRequests.map(r => `<div><div><span class="tag ${r.kind === 'cancel' ? 'danger' : 'warn'}">${REQUEST[r.kind]}</span> <strong>${esc(r.studentName)}</strong> ${mdw(r.date)} ${r.start} ${esc(r.subject)}
      <div class="small">${esc(r.note || '')}<span class="muted">（${r.fromKind === 'family' ? '保護者' : r.fromKind === 'student' ? '生徒' : 'スタッフ'}・${esc(r.receivedAt.slice(5, 16).replace('T', ' '))}）</span></div>
      <div class="small muted">${r.kind === 'move' ? '授業を開いて「日時・内容を直す」で日時を変えると、済みになります。' : r.kind === 'late' ? (rateRule(r) ? '応じるときは「日時・内容を直す」で開始時刻を変え、「生徒の申し出で開始を遅らせる」に印を付けてください（遅らせた分の取消料）。応じないときは「済みにする」。' : '応じるときは「日時・内容を直す」で開始時刻を変えてください（料金は変わりません）。') : r.kind === 'cancel' ? (rateRule(r) ? 'キャンセル料は連絡の時刻で自動に計算しました（「請求」で確かめられます）。' : 'キャンセル料は「請求」で決めます。') : ''}</div></div>
      <div class="row"><button data-action="sch-goto" data-date="${r.date}" data-id="${esc(r.lessonId || '')}">授業を開く</button><button data-action="sch-resolve" data-id="${esc(r.id)}"${ctx.dis()}>済みにする</button></div></div>`).join('') + '</div>' : '')
      + (Object.keys(held).length ? `<h2>未送信の仮予定</h2><div class="list">` + Object.entries(held).map(([sid, n]) => `<div><div><strong>${esc(nameOf[sid] || '')}</strong> ${n}件</div><div><button class="primary" data-action="sch-send" data-sid="${esc(sid)}"${ctx.dis()}>予定表を送る</button></div></div>`).join('') + '</div>' : '');
  }
  const tabs = (manager && ['create', 'off', 'meeting'].includes(sheet.kind)) ? `<div class="seg">${[['create', '仮予定'], ['off', '休み'], ['meeting', '面談']].map(([k, lb]) => `<button class="${sheet.kind === k ? 'on' : ''}" data-action="sch-sheet" data-k="${k}">${lb}</button>`).join('')}</div>` : '';
  return `<div class="overlay" data-action="sch-close"></div><section class="bsheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="bsheet-head"><strong>${esc(title)}</strong><button class="icon" data-action="sch-close" aria-label="閉じる">×</button></div>${tabs}<div class="bsheet-body">${body}</div></section>`;
}

const minutesOptions = v => [30, 45, 60, 90, 120, 150, 180].map(m => `<option value="${m}"${m === Number(v) ? ' selected' : ''}>${m}分</option>`).join('');
const staffOptions = (ctx, v) => '<option value="">未定</option>' + data.staff.filter(s => s.teacher).map(s => `<option value="${ctx.esc(s.id)}"${s.id === v ? ' selected' : ''}>${ctx.esc(s.name)}</option>`).join('');
const kindOptions = (ctx, v) => data.kinds.map(k => `<option${k === v ? ' selected' : ''}>${ctx.esc(k)}</option>`).join('');
function createForm(ctx, me) {
  const { esc } = ctx;
  return `<form class="stack" data-form="sch-create" style="margin:0">
    <label>生徒<select name="studentId" required>${data.students.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始<input type="time" name="start" value="17:00" step="300" required></label><label style="flex:1">長さ<select name="minutes">${minutesOptions(90)}</select></label></div>
    <div class="row"><label style="flex:1">科目<input name="subject" maxlength="30" required placeholder="数学"></label><label style="flex:1">種類<select name="kind">${kindOptions(ctx, '通常')}</select></label>
      <label style="flex:1">形式<select name="deliveryMode"><option value="in_person">対面</option><option value="online">オンライン</option></select></label></div>
    <div class="row"><label style="flex:1">担当<select name="staffId">${staffOptions(ctx, me.id)}</select></label><label style="flex:1">くり返し<select name="repeat">${[1, 2, 3, 4, 5, 8, 12].map(n => `<option value="${n}">${n === 1 ? 'この日だけ' : '毎週×' + n + '回'}</option>`).join('')}</select></label></div>
    <label>送り方<select name="send"><option value="now">今すぐ送る（締め切りまでに連絡がなければ決定）</option><option value="hold">予定表にまとめて、あとで送る</option></select></label>
    <p class="small muted">締め切りは、送った日の3日後（翌月分だけなら今月25日）。授業の2日前を超えません。明日までの授業は締め切りを置かないので「決定する」で決めてください。</p>
    <div class="row"><button class="primary"${ctx.dis()}>作る</button></div></form>`;
}
function editForm(ctx, l) {
  const after = Date.now() > Date.parse(l.date + 'T23:00:00+09:00') - 86400e3;
  return `<form class="stack" data-form="sch-update" data-id="${ctx.esc(l.id)}" data-version="${l.version}" style="margin:8px 0 0">
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${l.date}"></label><label style="flex:1">開始<input type="time" name="start" value="${l.start}" step="300"></label><label style="flex:1">長さ<select name="minutes">${minutesOptions(l.minutes)}</select></label></div>
    <div class="row"><label style="flex:1">科目<input name="subject" maxlength="30" value="${ctx.esc(l.subject)}"></label><label style="flex:1">種類<select name="kind">${kindOptions(ctx, l.kind)}</select></label>
      <label style="flex:1">形式<select name="deliveryMode"><option value="in_person"${l.deliveryMode === 'in_person' ? ' selected' : ''}>対面</option><option value="online"${l.deliveryMode === 'online' ? ' selected' : ''}>オンライン</option></select></label></div>
    <label>担当<select name="staffId">${staffOptions(ctx, l.staffId)}</select></label>
    <label>メモ（スタッフだけ）<input name="note" maxlength="1000" value="${ctx.esc(l.note || '')}"></label>
    ${l.status === 'decided' && after ? (rateRule(l)
      ? `<label class="checks"><label><input type="checkbox" name="lateStart"> 生徒の申し出で開始を遅らせる（遅らせた分の取消料がかかります）</label></label>
        <label>申し出を受けた時刻（空なら「開始を遅らせたい」の連絡の時刻、なければ今）<input type="datetime-local" name="receivedAt"></label>`
      : '<label class="checks"><label><input type="checkbox" name="lateStart"> 当日の開始時刻の変更として記録する（生徒の申し出・料金は変えない）</label></label>') : ''}
    <div class="row"><button class="primary"${ctx.dis()}>保存</button><button type="button" data-action="sch-edit-cancel">やめる</button></div></form>`;
}
// キャンセル（新しい決まり）: 連絡を受けた時刻で取消料が決まる。LINE などで受けた時刻を入れる
function cancelForm(ctx, l) {
  return `<form class="stack" data-form="sch-cancel" data-id="${ctx.esc(l.id)}" data-version="${l.version}" style="margin:8px 0 0">
    <p class="small" style="margin:0">キャンセル料は、連絡を受けた時刻で決まります（前日23時〜開始3時間前は25%、そこから開始時刻の100%まで上がります）。前日23時までの連絡なら「お休みにする」を使ってください。</p>
    <label>連絡を受けた時刻<input type="datetime-local" name="receivedAt" value="${nowLocal()}"></label>
    <label class="checks"><label><input type="checkbox" name="noNotice"> 連絡がなかった（無断欠席。100%）</label></label>
    <div class="row"><button class="danger"${ctx.dis()}>キャンセルにする</button><button type="button" data-action="sch-edit-cancel">やめる</button></div></form>`;
}
// 遅刻（新しい決まり）: 予定の時刻に終わる。遅れた分は授業料に入れず、遅れるという連絡を受けた時刻の率で取消料
function tardyForm(ctx, l) {
  return `<form class="stack" data-form="sch-tardy" data-id="${ctx.esc(l.id)}" data-version="${l.version}" style="margin:8px 0 0">
    <p class="small" style="margin:0">授業は予定の時刻（${endOf(l.start, l.minutes)}）に終わります。遅れた分は授業料に入れず、取消料になります。0分にすると取り消せます。</p>
    <label>遅れた分数<input type="number" name="lateMinutes" min="0" max="${l.minutes - 1}" step="1" value="${l.lostMinutes || ''}" required inputmode="numeric"></label>
    <label>遅れるという連絡を受けた時刻（連絡がなければ空）<input type="datetime-local" name="receivedAt"></label>
    <div class="row"><button class="primary"${ctx.dis()}>記録する</button><button type="button" data-action="sch-edit-cancel">やめる</button></div></form>`;
}
function offForm(ctx, me, manager) {
  return `<form class="stack" data-form="sch-off" style="margin:0">${manager ? `<label>だれの休み<select name="staffId"><option value="">教室全体</option>${data.staff.map(s => `<option value="${ctx.esc(s.id)}"${s.id === me.id ? ' selected' : ''}>${ctx.esc(s.name)}</option>`).join('')}</select></label>` : ''}
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始（終日なら空）<input type="time" name="start"></label><label style="flex:1">終了<input type="time" name="end"></label></div>
    <label>メモ（生徒には見せない）<input name="note" maxlength="100"></label><div class="row"><button class="primary"${ctx.dis()}>登録する</button></div></form>`;
}
function meetingForm(ctx) {
  if (!families) { ctx.call('admin/families/list').then(r => { families = r.ok ? r.families : []; ctx.render(); }); return '<p class="muted">読み込んでいます…</p>'; }
  return `<form class="stack" data-form="sch-meeting" style="margin:0"><label>家族<select name="familyId">${families.map(f => `<option value="${ctx.esc(f.id)}">${ctx.esc(f.name)}</option>`).join('')}</select></label>
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始<input type="time" name="start" value="19:00" step="300" required></label><label style="flex:1">長さ<select name="minutes">${[15, 20, 30, 45, 60].map(m => `<option value="${m}"${m === 30 ? ' selected' : ''}>${m}分</option>`).join('')}</select></label></div>
    <div class="row"><label style="flex:1">形式<select name="deliveryMode"><option value="in_person">対面</option><option value="online">オンライン（Meet）</option></select></label><label style="flex:2">題名<input name="title" value="面談" maxlength="60"></label></div>
    <div class="row"><button class="primary"${ctx.dis()}>登録する</button></div></form>`;
}

const yen = n => Number(n).toLocaleString('ja-JP') + '円';
const lessonById = id => (data && data.lessons ? data.lessons.find(l => l.id === id) : null); // ほかの画面のボタン（data-id つき）でも落ちないように
const values = el => Object.fromEntries(new FormData(el).entries());
async function after(ctx, r, okMessage) {
  if (r.ok) { data = null; loadedFor = ''; cache = {}; if (sheet && sheet.kind === 'lesson') sheet = null; if (okMessage) ctx.say(okMessage, 'ok'); return true; }
  if (r.error && r.error.needForce && confirm(r.error.message)) return 'force';
  if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}

export async function scheduleSubmit(ctx, kind, el) {
  const v = values(el);
  if (kind === 'sch-create') {
    const body = { studentId: v.studentId, date: v.date, start: v.start, minutes: Number(v.minutes), subject: v.subject, kind: v.kind, deliveryMode: v.deliveryMode, staffId: v.staffId, repeat: Number(v.repeat), hold: v.send === 'hold' };
    let r = await ctx.call('schedule/lessons/create', body);
    if ((await after(ctx, r, '')) === 'force') r = await ctx.call('schedule/lessons/create', { ...body, force: true });
    if (r.ok) { sheet = null; cache = {}; sel = v.date; ctx.say(r.held ? `${r.created}件を予定表に入れました（まだ送っていません）` : `${r.created}件の仮予定を送りました${r.confirmBy ? '（締め切り ' + Number(r.confirmBy.slice(5, 7)) + '/' + Number(r.confirmBy.slice(8)) + '）' : ''}`, 'ok'); data = null; loadedFor = ''; }
    return true;
  }
  if (kind === 'sch-update') {
    const body = { id: el.dataset.id, version: Number(el.dataset.version), date: v.date, start: v.start, minutes: Number(v.minutes), subject: v.subject, kind: v.kind, deliveryMode: v.deliveryMode, staffId: v.staffId, note: v.note, lateStart: v.lateStart === 'on', receivedAt: v.receivedAt || '' };
    let r = await ctx.call('schedule/lessons/update', body);
    const saved = x => x.ok && x.fee ? `保存しました（開始を遅らせた分の取消料 ${yen(x.fee.amount)}）` : '保存しました';
    if ((await after(ctx, r, saved(r))) === 'force') { r = await ctx.call('schedule/lessons/update', { ...body, force: true }); await after(ctx, r, saved(r)); }
    if (r.ok) { sel = v.date; sheet = null; }
    return true;
  }
  if (kind === 'sch-cancel') {
    const r = await ctx.call('schedule/lessons/cancel', { id: el.dataset.id, version: Number(el.dataset.version), receivedAt: v.receivedAt || '', noNotice: v.noNotice === 'on' });
    await after(ctx, r, r.ok && r.fee ? `キャンセルにしました（キャンセル料 ${yen(r.fee.amount)}）` : 'キャンセルにしました');
    return true;
  }
  if (kind === 'sch-tardy') {
    const r = await ctx.call('schedule/lessons/tardy', { id: el.dataset.id, version: Number(el.dataset.version), lateMinutes: Number(v.lateMinutes || 0), receivedAt: v.receivedAt || '' });
    await after(ctx, r, r.ok ? (r.fee ? `遅刻を記録しました（取消料 ${yen(r.fee.amount)}）` : '遅刻の記録を取り消しました') : '');
    return true;
  }
  if (kind === 'sch-off') { const r = await ctx.call('schedule/unavailability/add', v); await after(ctx, r, '休みを登録しました'); if (r.ok) sheet = null; return true; }
  if (kind === 'sch-meeting') { const r = await ctx.call('schedule/meetings/create', { ...v, minutes: Number(v.minutes) }); await after(ctx, r, '面談を登録しました'); if (r.ok) sheet = null; return true; }
  return false;
}

export async function scheduleClick(ctx, a, b) {
  const id = b.dataset.id, l = id ? lessonById(id) : null;
  if (a === 'sch-month') { month = addMonths(month, Number(b.dataset.n)); sel = month + '-01'; data = null; sheet = null; slideIn = Number(b.dataset.n) > 0 ? 'next' : 'prev'; calOpen = true; wasOpen = true; calH = calTop = null; return true; } // 矢印でもスワイプと同じく滑って替わる
  if (a === 'sch-today') { const t = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); sel = t; if (ymOf(t) !== month) { month = ymOf(t); data = null; } return true; }
  if (a === 'sch-day') {
    if (Date.now() - swipeAt < 400) return true; // スワイプした指を離したときの押し
    const d = b.dataset.date;
    if (b.classList.contains('day-band')) { sel = d; window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
    if (phone() && calOpen) { sel = d; calOpen = false; } // 月全体から日を押した: その週を上へ、一覧を下から
    else if (phone() && d === sel) calOpen = true; // 選んでいる日をもう一度: 月全体に戻る
    else sel = d;
    return true;
  }
  if (a === 'sch-goto') { sel = b.dataset.date; sheet = b.dataset.id ? { kind: 'lesson', id: b.dataset.id } : null; if (ymOf(sel) !== month) { month = ymOf(sel); data = null; } return true; }
  if (a === 'sch-sheet') { sheet = { kind: b.dataset.k }; return true; }
  if (a === 'sch-open') { sheet = { kind: 'lesson', id }; return true; }
  if (a === 'sch-close') { sheet = null; return true; }
  if (a === 'sch-edit') { sheet = { kind: 'lesson', id, edit: true }; return true; }
  if (a === 'sch-tardy') { sheet = { kind: 'lesson', id, tardy: true }; return true; }
  if (a === 'sch-cancel' && l && rateRule(l)) { sheet = { kind: 'lesson', id, cancel: true }; return true; } // 新しい決まり: 連絡を受けた時刻を入れる画面
  if (a === 'sch-edit-cancel') { sheet = sheet && sheet.id ? { kind: 'lesson', id: sheet.id } : null; return true; }
  const simple = { 'sch-decide': ['schedule/lessons/decide', '決定しました'], 'sch-done': ['schedule/lessons/done', '実施済みにしました'], 'sch-rest': ['schedule/lessons/rest', 'お休みにしました'], 'sch-cancel': ['schedule/lessons/cancel', 'キャンセルにしました'], 'sch-delete': ['schedule/lessons/delete', '削除しました'] };
  if (simple[a] && l) {
    if (a === 'sch-delete' && !confirm('この授業を削除しますか？ 入力ミスのときだけ使ってください（記録は残りません）。お休み・キャンセルは別のボタンです。')) return true;
    if (a === 'sch-cancel' && !confirm('この授業をキャンセル（キャンセル料の対象）にしますか？ 前日23時までの連絡なら「お休みにする」を使ってください。')) return true;
    await after(ctx, await ctx.call(simple[a][0], { id: l.id, version: l.version }), simple[a][1]); return true;
  }
  if (a === 'sch-resolve') { await after(ctx, await ctx.call('schedule/requests/resolve', { id }), '済みにしました'); return true; }
  if (a === 'sch-send') { if (!confirm('未送信の仮予定を予定表として送りますか？ 保護者に1回お知らせします。')) return true; const r = await ctx.call('schedule/lessons/sendHeld', { studentId: b.dataset.sid }); await after(ctx, r, r.ok ? r.sent + '件の予定表を送りました' : ''); return true; }
  if (a === 'sch-off-del') { await after(ctx, await ctx.call('schedule/unavailability/delete', { id }), '休みを消しました'); return true; }
  if (a === 'sch-ev-del') { if (!confirm('この共有予定を消しますか？')) return true; await after(ctx, await ctx.call('schedule/events/delete', { id }), '消しました'); return true; }
  if (a === 'sch-mt-cancel') { if (!confirm('この面談を取りやめますか？')) return true; await after(ctx, await ctx.call('schedule/meetings/cancel', { id }), '面談を取りやめました'); return true; }
  return false;
}
