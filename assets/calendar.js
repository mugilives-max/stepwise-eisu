/* 予定表(月カレンダー)の共通部品。生徒マイページ・保護者ページ・管理画面の生徒カルテで同じ見た目・同じ判定を使う。
   buildInfo: 授業・予定・授業不可・登録不可(先生の休み)・授業可(希望)を日付ごとの情報にまとめる
   render:    その情報から月のカレンダー(HTML)を作る。日付のボタンは data-action="calday" data-date、前後の月は calprev / calnext
   見た目のCSSは assets/calendar.css。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StepwiseCalendar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var WD = ["日", "月", "火", "水", "木", "金", "土"];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function cT(t) { return String(t || "").replace(/^0/, "").replace(/:00$/, ""); }
  function endTime(start, min) { var p = String(start || "0:0").split(":"); var t = (+p[0]) * 60 + (+p[1]) + (+min || 0); return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60); }
  function addDaysStr(ds, n) { var p = ds.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function defaultLabel(s) { var k = String(s.kind || ""); return String(s.subject || "") + (k && k !== "通常" ? "（" + k + "）" : ""); }

  // lessons: {date, start, min, subject, kind, st}  st = mine(確定) | offer(案内) | done(実施済み) | past(過去・未実施)
  // events: {date, dateTo, title, kind}  blocked/teacherOff: {date, start?, end?}  wishes: {date}
  function buildInfo(src) {
    src = src || {};
    var label = src.lessonLabel || defaultLabel, info = {};
    function it0(d) { return info[d] || (info[d] = { offer: 0, mine: 0, ng: 0, past: 0, ev: 0, labels: [] }); }
    (src.lessons || []).forEach(function (s) {
      var it = it0(s.date);
      if (s.st === "done" || s.st === "past") it.past++; else if (s.st === "offer") it.offer++; else it.mine++;
      it.labels.push({ text: label(s) || "授業", st: s.st, start: s.start, end: s.start && s.min ? endTime(s.start, s.min) : "", kind: s.kind });
    });
    (src.events || []).forEach(function (e) {
      var d = e.date, to = e.dateTo || e.date;
      for (var i = 0; i < 61 && d && d <= to; i++) { var it = it0(d); it.ev++; it.labels.push({ text: e.title || "予定", st: "event", start: "99:99", end: "", kind: e.kind }); d = addDaysStr(d, 1); }
    });
    (src.blocked || []).forEach(function (b) { var it = it0(b.date); it.ng++; if (b.start) (it.ngT = it.ngT || []).push(b); else it.ngAll = 1; });
    (src.teacherOff || []).forEach(function (o) { var it = it0(o.date); if (o.start) (it.toffT = it.toffT || []).push(o); else it.toff = 1; });
    (src.wishes || []).forEach(function (w) { var it = it0(w.date); it.wish = (it.wish || 0) + 1; });
    return info;
  }

  // opts: {year, month(0始まり), today, selDate, selMode, selDays, showToff, minIdx, maxIdx}
  function render(info, opts) {
    opts = opts || {}; info = info || {};
    var now = new Date(), calY = opts.year != null ? opts.year : now.getFullYear(), calM = opts.month != null ? opts.month : now.getMonth();
    var today = opts.today || "", selDate = opts.selDate || null, selMode = opts.selMode || "", selDays = opts.selDays || {}, showToff = opts.showToff !== false;
    var minIdx = opts.minIdx != null ? opts.minIdx : now.getFullYear() * 12 + now.getMonth() - 2, curIdx = calY * 12 + calM, maxIdx = opts.maxIdx != null ? opts.maxIdx : minIdx + 5;
    var h = '<div class="card cal"><div class="calhead">';
    h += '<button class="btn-quiet btn-sm" data-action="calprev"' + (curIdx <= minIdx ? " disabled" : "") + ' aria-label="前の月">◀</button>';
    h += '<span class="callabel">' + calY + "年" + (calM + 1) + "月</span>";
    h += '<button class="btn-quiet btn-sm" data-action="calnext"' + (curIdx >= maxIdx ? " disabled" : "") + ' aria-label="次の月">▶</button>';
    h += '</div><div class="calgrid">';
    WD.forEach(function (w, i) { h += '<span class="calwd' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + w + "</span>"; });
    var startWd = new Date(calY, calM, 1).getDay();
    for (var i = 0; i < startWd; i++) h += "<span></span>";
    var days = new Date(calY, calM + 1, 0).getDate();
    for (var d = 1; d <= days; d++) {
      var ds = calY + "-" + pad(calM + 1) + "-" + pad(d);
      var it = info[ds], wd = (startWd + d - 1) % 7, cls = "calday", past = ds < today;
      if (wd === 0) cls += " sun"; if (wd === 6) cls += " sat";
      if (ds === today) cls += " today"; if (ds === selDate) cls += " sel";
      var hasItems = !!(it && it.labels && it.labels.length);
      if (showToff && it && it.toff && !past) cls += " toff";
      if (it && it.ngAll && !past) cls += " ngday";
      var marks = '<span class="calmarks">';
      if (it && !past && it.mine) cls += " mine";
      if (selMode && selDays[ds] && !past) { cls += " selday " + selMode; if (selMode === "ng" && !(it && it.ng)) marks += '<span class="callbl to" style="color:var(--danger)">授業不可</span>'; }
      marks += "</span>";
      if (it && it.ngAll && !past) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">授業不可</span>';
      if (it && it.ngT && !past) it.ngT.slice(0, 2).forEach(function (b) { marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">授業不可' + cT(b.start) + '-' + cT(b.end) + '</span>'; });
      if (it && it.wish && !past) marks += '<span class="callbl wi">授業可</span>';
      if (showToff && it && it.toff && !past) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">登録不可</span>';
      if (showToff && it && it.toffT && !past) it.toffT.slice(0, 2).forEach(function (o) { marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">登録不可' + cT(o.start) + '-' + cT(o.end) + '</span>'; });
      if (hasItems) {
        var lb = it.labels.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; });
        // 授業1つ＝1つの箱(Googleカレンダー風)。確定・実施済みは青、案内は黄、重要な予定は赤系
        lb.forEach(function (l) {
          if (l.st === "event") { marks += '<span class="calbox ev">' + esc(l.text) + "</span>"; return; }
          var lc = l.st === "offer" ? " of" : "";
          marks += '<span class="calbox' + lc + '"><span class="t">' + esc(l.start) + (l.end ? '-<wbr>' + esc(l.end) : '') + '</span><span class="s">' + esc(l.text) + '</span></span>';
        });
      }
      var clickable = !past || hasItems; // 今日以降はどの日もタップ可(その日の操作ボタンが出る)
      if (!clickable) h += '<span class="' + cls + (past && hasItems ? "" : " off") + '">' + d + marks + "</span>";
      else h += '<button class="' + cls + '" data-action="calday" data-date="' + ds + '">' + d + marks + "</button>";
    }
    h += '</div><div class="callegend">';
    h += '<span><span class="callbl" style="display:inline">授業</span></span>';
    h += '<span><span class="callbl of" style="display:inline">授業（未承認）</span></span>';
    h += '<span><span class="callbl ev" style="display:inline">予定</span> 重要な予定（テスト・行事など）</span>';
    h += '<span><span class="callbl wi" style="display:inline">授業可</span> 授業できる時間帯（返事待ち）</span>';
    h += '<span><span class="callbl to ngswatch" style="display:inline">授業不可</span> 授業できない日</span>';
    if (showToff) h += '<span><span class="callbl to toffswatch" style="display:inline">登録不可</span> 先生の休み（登録できません）</span>';
    h += "</div></div>";
    return h;
  }

  return { buildInfo: buildInfo, render: render, endTime: endTime, addDaysStr: addDaysStr };
});
