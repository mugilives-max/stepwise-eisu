// 月の予定表（保護者・生徒の画面で共通。スタッフの予定と同じ見た目と動き）。
// スマホ（ライフベアの形）: はじめは月全体。日を押すと、その週が一番上まで滑り上がり、下から一覧が出る（2週分の窓）。
// 同じ日をもう一度押すか、取っ手を下へ引くと月全体に戻る。月の表を左右にスワイプ（矢印でも）すると月が替わる。
// パソコンでは、左に月の表、右に選んだ日の一覧。
// 使い方: const cal = monthCalendar({ today, onChange }) を 1 つ持ち、描くときに cal.html(...)、描いたあとに cal.afterRender()、押したときに cal.click(action, el)。
export const ymOf = d => d.slice(0, 7);
export const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
export const gridStart = ym => { const first = new Date(ym + '-01T00:00:00Z'); return new Date(first - first.getUTCDay() * 86400e3).toISOString().slice(0, 10); };
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export const gridEnd = ym => addDays(gridStart(ym), 41);
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const mdw = d => { const t = new Date(d + 'T00:00:00Z'); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + '(' + WD[t.getUTCDay()] + ')'; };
const EASE = 'cubic-bezier(.32, .72, 0, 1)';
const phone = () => matchMedia('(max-width: 719px)').matches;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function monthCalendar({ today, onChange }) {
  const cal = {
    month: ymOf(today), sel: today, today,
    calOpen: true, wasOpen: true, calH: null, calTop: null, shownSel: '', slideIn: '', swipeAt: 0, animPending: false,
  };
  const change = () => onChange && onChange();

  // 上の帯: ‹ 月 › 今日 と、呼ぶ側の追加（右側）
  cal.bar = (esc, extra = '') => `<div class="sch-bar"><button class="icon" data-action="cal-month" data-n="-1" aria-label="前の月">‹</button><strong class="sch-month">${Number(cal.month.slice(0, 4))}年${Number(cal.month.slice(5))}月</strong><button class="icon" data-action="cal-month" data-n="1" aria-label="次の月">›</button>
    <button class="small-btn" data-action="cal-today">今日</button><span style="flex:1"></span>${extra}</div>`;

  // 月の表 + 選んだ日の一覧。cell(d) は { lines: [html…], count } を返す。day(d, first) はその日の一覧（HTML）
  cal.html = (esc, { cell, day, dayTitle = true }) => {
    const start = gridStart(cal.month);
    let h = '<div class="sch"><div class="cal-win"><div class="month2">' + WD.map((w, i) => `<div class="wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i === 35 && ymOf(d) !== cal.month) break;
      const { lines = [], count = 0 } = cell(d) || {};
      const shown = lines.slice(0, 4), more = lines.length - shown.length, wd = new Date(d + 'T00:00:00Z').getUTCDay();
      h += `<button type="button" class="cell${ymOf(d) !== cal.month ? ' out' : ''}${d === cal.sel ? ' sel' + (cal.shownSel && cal.shownSel !== cal.sel ? ' enter' : '') : ''}${d === cal.today ? ' today' : ''}" data-action="cal-day" data-date="${d}" aria-label="${mdw(d)} 予定${count}件">`
        + `<span class="num${wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''}">${Number(d.slice(8))}</span>${shown.join('')}${more > 0 ? `<span class="more">+${more}</span>` : ''}</button>`;
    }
    h += '</div></div>';
    if (!cal.calOpen || !phone()) h += '<div class="cal-handle" role="separator" aria-label="下へ引くと月全体に戻る"><span></span></div>';
    const changed = cal.shownSel && cal.shownSel !== cal.sel; cal.shownSel = cal.sel;
    const showDay = !cal.calOpen || !phone(), leaving = cal.calOpen && !cal.wasOpen && phone();
    if (showDay || leaving) {
      const last = gridEnd(cal.month);
      let body = day(cal.sel, true);
      for (let i = 1; i <= 6; i++) { const d = addDays(cal.sel, i); if (d > last) break; body += day(d, false); }
      h += `<div class="sch-day${changed && showDay && !cal.wasOpen ? ' enter' : ''}${leaving ? ' leaving' : ''}">${body}</div>`;
    }
    return h + '</div>';
  };
  // 選んだ日の見出し（1 日目）と、そのあとの日の帯
  cal.dayHead = (d, first, note = '') => first ? `<div class="day-title"><strong>${mdw(d)}</strong>${note}</div>` : `<button type="button" class="day-band" data-action="cal-day" data-date="${d}">${mdw(d)}</button>`;

  // 押したとき。扱ったら true（呼ぶ側は描き直す。月が替わるときは onChange で読み直す）
  cal.click = (a, b) => {
    if (a === 'cal-month') { cal.month = addMonths(cal.month, Number(b.dataset.n)); cal.sel = cal.month + '-01'; cal.slideIn = Number(b.dataset.n) > 0 ? 'next' : 'prev'; cal.calOpen = true; cal.wasOpen = true; cal.calH = cal.calTop = null; change(); return true; }
    if (a === 'cal-today') { cal.sel = cal.today; if (ymOf(cal.today) !== cal.month) { cal.month = ymOf(cal.today); change(); } return true; }
    if (a === 'cal-day') {
      if (Date.now() - cal.swipeAt < 400) return true;
      const d = b.dataset.date;
      if (b.classList.contains('day-band')) { cal.sel = d; window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
      if (phone() && cal.calOpen) { cal.sel = d; cal.calOpen = false; }
      else if (phone() && d === cal.sel) cal.calOpen = true;
      else cal.sel = d;
      return true;
    }
    return false;
  };

  // 描いたあと: 窓の高さと位置を 0.38 秒で動かし、取っ手と月の表に指の動きを付ける
  cal.afterRender = render => {
    setTimeout(() => { bindDrag(render); bindSwipe(render); }, 0);
    if (cal.animPending) return; cal.animPending = true;
    requestAnimationFrame(() => {
      cal.animPending = false;
      const win = document.querySelector('.cal-win'); if (!win) return;
      if (!phone()) { win.style.maxHeight = ''; cal.wasOpen = cal.calOpen; return; }
      const wd = win.querySelector('.wd'), cell = win.querySelector('.cell.sel') || win.querySelector('.cell.today') || win.querySelector('.cell');
      const wdH = wd ? wd.offsetHeight : 0, rowH = cell ? cell.offsetHeight : 74, full = win.scrollHeight;
      const toH = cal.calOpen ? full : wdH + 2 * rowH, toTop = cal.calOpen ? 0 : Math.max(0, (cell ? cell.offsetTop : 0) - wdH);
      const fromH = cal.calH === null ? toH : cal.calH, fromTop = cal.calTop === null ? toTop : cal.calTop;
      const day = document.querySelector('.sch-day'), opening = !cal.calOpen && cal.wasOpen;
      cal.calH = toH; cal.calTop = toTop; cal.wasOpen = cal.calOpen;
      const done = () => { win.style.maxHeight = cal.calOpen ? 'none' : toH + 'px'; win.scrollTop = toTop; };
      if (still() || (Math.abs(fromH - toH) < 2 && Math.abs(fromTop - toTop) < 2)) { done(); if (day && day.classList.contains('leaving')) day.remove(); return; }
      const ms = 380, ease = q => 1 - Math.pow(1 - q, 3), t0 = performance.now();
      win.style.maxHeight = fromH + 'px'; win.scrollTop = fromTop;
      const step = now => { const q = Math.min(1, (now - t0) / ms), e = ease(q); win.style.maxHeight = fromH + (toH - fromH) * e + 'px'; win.scrollTop = fromTop + (toTop - fromTop) * e; if (q < 1) requestAnimationFrame(step); else done(); };
      requestAnimationFrame(step);
      if (day && opening) day.animate([{ transform: 'translateY(60vh)', opacity: .6 }, { transform: 'none', opacity: 1 }], { duration: ms, easing: EASE });
      if (day && day.classList.contains('leaving')) day.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(60vh)', opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => day.remove();
      win.addEventListener('scroll', () => { if (!cal.calOpen) cal.calTop = win.scrollTop; }, { passive: true });
    });
  };
  function bindSwipe(render) {
    const win = document.querySelector('.cal-win'), grid = win && win.querySelector('.month2'); if (!grid) return;
    if (cal.slideIn && !still()) grid.animate([{ transform: `translateX(${cal.slideIn === 'next' ? 60 : -60}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 320, easing: EASE });
    cal.slideIn = '';
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
      if (x0 === null) return; x0 = null; if (!horiz) return; cal.swipeAt = Date.now();
      const W = win.offsetWidth, go = Math.abs(dx) > W * .2 || (Math.abs(v) > .4 && Math.abs(dx) > 24), dir = dx < 0 ? 'next' : 'prev';
      const a = grid.animate([{ transform: `translateX(${dx}px)`, opacity: Number(grid.style.opacity || 1) }, go ? { transform: `translateX(${dx < 0 ? -W : W}px)`, opacity: 0 } : { transform: 'none', opacity: 1 }],
        { duration: still() ? 1 : go ? 200 : 240, easing: go ? 'cubic-bezier(.4, 0, 1, 1)' : EASE, fill: 'forwards' });
      let finished = false;
      const fin = () => {
        if (finished) return; finished = true;
        if (!go) { grid.style.transform = ''; grid.style.opacity = ''; a.cancel(); return; }
        cal.month = addMonths(cal.month, dir === 'next' ? 1 : -1); cal.sel = cal.month + '-01';
        cal.calOpen = true; cal.wasOpen = true; cal.calH = null; cal.calTop = null; cal.slideIn = dir; change(); render();
      };
      a.onfinish = fin; setTimeout(fin, (still() ? 1 : go ? 200 : 240) + 150);
    };
    win.onpointerup = end; win.onpointercancel = end;
  }
  function bindDrag(render) {
    const hd = document.querySelector('.cal-handle'), win = document.querySelector('.cal-win'), day = document.querySelector('.sch-day');
    if (!hd || !win || !day || cal.calOpen || !phone()) return;
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
        if (close) { cal.calOpen = true; cal.wasOpen = true; cal.calH = full; cal.calTop = 0; render(); } else { day.style.opacity = ''; }
      };
      requestAnimationFrame(step);
    };
    hd.onpointerup = end; hd.onpointercancel = end;
  }
  return cal;
}
