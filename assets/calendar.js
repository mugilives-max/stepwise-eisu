/* 予定表(月カレンダー)の共通部品。生徒マイページ・保護者ページ・管理画面の生徒カルテで同じ見た目・同じ判定を使う。
   buildInfo: 授業・予定・授業不可・登録不可(先生の休み)・授業可(希望)を日付ごとの情報にまとめる
   render:    その情報から月のカレンダー(HTML)を作る。日付のボタンは data-action="calday" data-date、前後の月は calprev / calnext
   見た目のCSSは assets/calendar.css。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StepwiseCalendar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // HOLIDAYS_START
  // Source: https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv (updated 2026-09-23)
  var HOLIDAYS = {
    "2020-01-01": "元日",
    "2020-01-13": "成人の日",
    "2020-02-11": "建国記念の日",
    "2020-02-23": "天皇誕生日",
    "2020-02-24": "振替休日",
    "2020-03-20": "春分の日",
    "2020-04-29": "昭和の日",
    "2020-05-03": "憲法記念日",
    "2020-05-04": "みどりの日",
    "2020-05-05": "こどもの日",
    "2020-05-06": "振替休日",
    "2020-07-23": "海の日",
    "2020-07-24": "スポーツの日",
    "2020-08-10": "山の日",
    "2020-09-21": "敬老の日",
    "2020-09-22": "秋分の日",
    "2020-11-03": "文化の日",
    "2020-11-23": "勤労感謝の日",
    "2021-01-01": "元日",
    "2021-01-11": "成人の日",
    "2021-02-11": "建国記念の日",
    "2021-02-23": "天皇誕生日",
    "2021-03-20": "春分の日",
    "2021-04-29": "昭和の日",
    "2021-05-03": "憲法記念日",
    "2021-05-04": "みどりの日",
    "2021-05-05": "こどもの日",
    "2021-07-22": "海の日",
    "2021-07-23": "スポーツの日",
    "2021-08-08": "山の日",
    "2021-08-09": "振替休日",
    "2021-09-20": "敬老の日",
    "2021-09-23": "秋分の日",
    "2021-11-03": "文化の日",
    "2021-11-23": "勤労感謝の日",
    "2022-01-01": "元日",
    "2022-01-10": "成人の日",
    "2022-02-11": "建国記念の日",
    "2022-02-23": "天皇誕生日",
    "2022-03-21": "春分の日",
    "2022-04-29": "昭和の日",
    "2022-05-03": "憲法記念日",
    "2022-05-04": "みどりの日",
    "2022-05-05": "こどもの日",
    "2022-07-18": "海の日",
    "2022-08-11": "山の日",
    "2022-09-19": "敬老の日",
    "2022-09-23": "秋分の日",
    "2022-10-10": "スポーツの日",
    "2022-11-03": "文化の日",
    "2022-11-23": "勤労感謝の日",
    "2023-01-01": "元日",
    "2023-01-02": "振替休日",
    "2023-01-09": "成人の日",
    "2023-02-11": "建国記念の日",
    "2023-02-23": "天皇誕生日",
    "2023-03-21": "春分の日",
    "2023-04-29": "昭和の日",
    "2023-05-03": "憲法記念日",
    "2023-05-04": "みどりの日",
    "2023-05-05": "こどもの日",
    "2023-07-17": "海の日",
    "2023-08-11": "山の日",
    "2023-09-18": "敬老の日",
    "2023-09-23": "秋分の日",
    "2023-10-09": "スポーツの日",
    "2023-11-03": "文化の日",
    "2023-11-23": "勤労感謝の日",
    "2024-01-01": "元日",
    "2024-01-08": "成人の日",
    "2024-02-11": "建国記念の日",
    "2024-02-12": "振替休日",
    "2024-02-23": "天皇誕生日",
    "2024-03-20": "春分の日",
    "2024-04-29": "昭和の日",
    "2024-05-03": "憲法記念日",
    "2024-05-04": "みどりの日",
    "2024-05-05": "こどもの日",
    "2024-05-06": "振替休日",
    "2024-07-15": "海の日",
    "2024-08-11": "山の日",
    "2024-08-12": "振替休日",
    "2024-09-16": "敬老の日",
    "2024-09-22": "秋分の日",
    "2024-09-23": "振替休日",
    "2024-10-14": "スポーツの日",
    "2024-11-03": "文化の日",
    "2024-11-04": "振替休日",
    "2024-11-23": "勤労感謝の日",
    "2025-01-01": "元日",
    "2025-01-13": "成人の日",
    "2025-02-11": "建国記念の日",
    "2025-02-23": "天皇誕生日",
    "2025-02-24": "振替休日",
    "2025-03-20": "春分の日",
    "2025-04-29": "昭和の日",
    "2025-05-03": "憲法記念日",
    "2025-05-04": "みどりの日",
    "2025-05-05": "こどもの日",
    "2025-05-06": "振替休日",
    "2025-07-21": "海の日",
    "2025-08-11": "山の日",
    "2025-09-15": "敬老の日",
    "2025-09-23": "秋分の日",
    "2025-10-13": "スポーツの日",
    "2025-11-03": "文化の日",
    "2025-11-23": "勤労感謝の日",
    "2025-11-24": "振替休日",
    "2026-01-01": "元日",
    "2026-01-12": "成人の日",
    "2026-02-11": "建国記念の日",
    "2026-02-23": "天皇誕生日",
    "2026-03-20": "春分の日",
    "2026-04-29": "昭和の日",
    "2026-05-03": "憲法記念日",
    "2026-05-04": "みどりの日",
    "2026-05-05": "こどもの日",
    "2026-05-06": "振替休日",
    "2026-07-20": "海の日",
    "2026-08-11": "山の日",
    "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日",
    "2026-09-23": "秋分の日",
    "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日",
    "2026-11-23": "勤労感謝の日",
    "2027-01-01": "元日",
    "2027-01-11": "成人の日",
    "2027-02-11": "建国記念の日",
    "2027-02-23": "天皇誕生日",
    "2027-03-21": "春分の日",
    "2027-03-22": "振替休日",
    "2027-04-29": "昭和の日",
    "2027-05-03": "憲法記念日",
    "2027-05-04": "みどりの日",
    "2027-05-05": "こどもの日",
    "2027-07-19": "海の日",
    "2027-08-11": "山の日",
    "2027-09-20": "敬老の日",
    "2027-09-23": "秋分の日",
    "2027-10-11": "スポーツの日",
    "2027-11-03": "文化の日",
    "2027-11-23": "勤労感謝の日"
  };
  var HOLIDAY_LAST_YEAR = 2027;
  // HOLIDAYS_END
  function holidayName(date) { return HOLIDAYS[date] || ""; }
  var WD = ["日", "月", "火", "水", "木", "金", "土"];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function cT(t) { return String(t || "").replace(/^0/, "").replace(/:00$/, ""); }
  function endTime(start, min) { var p = String(start || "0:0").split(":"); var t = (+p[0]) * 60 + (+p[1]) + (+min || 0); return pad(Math.floor(t / 60) % 24) + ":" + pad(t % 60); }
  function addDaysStr(ds, n) { var p = ds.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2] + n); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function byStart(a, b) { return String(a.start) < String(b.start) ? -1 : 1; }
  // Only the administrator main calendar opts into compact overlap lanes.
  function overlapGroups(items) {
    var groups = [], minutes = function(t) { var p=String(t).split(':'); return +p[0]*60 + +p[1]; };
    items.slice().sort(byStart).forEach(function(item) {
      var start=minutes(item.start), end=minutes(item.end), g=groups[groups.length-1];
      if (!Number.isFinite(end) || end<=start) end=start+1;
      if (!g || start>=g.end) { g={start:start,end:end,items:[],lanes:[]}; groups.push(g); }
      var lane=g.lanes.findIndex(function(e){return e<=start;});
      if(lane<0)lane=g.lanes.length;
      g.lanes[lane]=end;g.end=Math.max(g.end,end);
      g.items.push({item:item,start:start,end:end,lane:lane});
    });
    return groups;
  }
  function overlapMarkup(items) {
    return overlapGroups(items).map(function(g) {
      // Restrictions remain in chronological order; crowded groups use the normal list.
      if(g.items.length<2 || g.lanes.length>2 || g.items.some(function(x){return !x.item.lesson;})) return g.items.map(function(x){return x.item.html;}).join('');
      var scale=Math.max.apply(null,[0.9].concat(g.items.map(function(x){return 56/(x.end-x.start);}))); 
      return '<span class="cal-overlap" style="--overlap-height:'+((g.end-g.start)*scale)+'px">'+g.items.map(function(x){
        return '<span class="cal-overlap-item" style="--overlap-top:'+((x.start-g.start)*scale)+'px;--overlap-size:'+((x.end-x.start)*scale-2)+'px;--overlap-lane:'+x.lane+'">'+x.item.html+'</span>';
      }).join('')+'</span>';
    }).join('');
  }
  function unavailableBox(item, label, kind) {
    return '<span class="calbox unavailable '+kind+'"><span class="t">'+esc(item.start)+(item.end?'-<wbr>'+esc(item.end):'')+'</span><span class="s">'+esc(label)+'</span></span>';
  }
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
      // cls: 管理画面の全体予定表で使う追加クラス(rq=取消依頼中 / dn=実施済み)
      it.labels.push({ text: label(s) || "授業", st: s.st, start: s.start, end: s.start && s.min ? endTime(s.start, s.min) : "", kind: s.kind, cls: s.cls || "" });
    });
    (src.events || []).forEach(function (e) {
      var d = e.date, to = e.dateTo || e.date;
      for (var i = 0; i < 61 && d && d <= to; i++) { var it = it0(d); it.ev++; it.labels.push({ text: e.title || "予定", st: "event", start: "99:99", end: "", kind: e.kind }); d = addDaysStr(d, 1); }
    });
    (src.blocked || []).forEach(function (b) { var it = it0(b.date); it.ng++; if (b.start) (it.ngT = it.ngT || []).push(b); else it.ngAll = 1; });
    (src.teacherOff || []).forEach(function (o) { var it = it0(o.date); if (o.start) (it.toffT = it.toffT || []).push(o); else it.toff = 1; });
    // wishes: {date, label?} label があれば(全体予定表: 生徒名と時間帯)箱で出し、なければ「授業可」の印だけ
    (src.wishes || []).forEach(function (w) { var it = it0(w.date); it.wish = (it.wish || 0) + 1; if (w.label) (it.wishL = it.wishL || []).push(String(w.label)); });
    return info;
  }

  // opts: {year, month(0始まり), today, selDate, selMode, selDays, showToff, minIdx, maxIdx, toffText, toffLegend}
  //   toffText / toffLegend: 先生の休みの表示名(生徒・保護者には「登録不可」、管理画面には「休み」)
  function render(info, opts) {
    opts = opts || {}; info = info || {};
    var toffText = opts.toffText || "登録不可", toffLegend = opts.toffLegend || "先生の休み（登録できません）";
    var now = new Date(), calY = opts.year != null ? opts.year : now.getFullYear(), calM = opts.month != null ? opts.month : now.getMonth();
    var today = opts.today || "", selDate = opts.selDate || null, selMode = opts.selMode || "", selDays = opts.selDays || {}, showToff = opts.showToff !== false;
    // 既定で12か月前まで戻れる(過去の予定を見返せるように)。先は3か月
    var minIdx = opts.minIdx != null ? opts.minIdx : now.getFullYear() * 12 + now.getMonth() - 12, curIdx = calY * 12 + calM, maxIdx = opts.maxIdx != null ? opts.maxIdx : now.getFullYear() * 12 + now.getMonth() + 3;
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
      var holiday = holidayName(ds);
      var it = info[ds], wd = (startWd + d - 1) % 7, cls = "calday", past = ds < today;
      if (holiday) cls += " holiday";
      if (wd === 0) cls += " sun"; if (wd === 6) cls += " sat";
      if (ds === today) cls += " today"; if (ds === selDate) cls += " sel";
      var hasItems = !!(it && it.labels && it.labels.length);
      // 過去の日も授業不可・休みの印は残す(予定の見返し用)。授業可(希望)は返事待ちの意味なので過去は出さない
      if (showToff && it && it.toff) cls += " toff";
      if (it && it.ngAll) cls += " ngday";
      var marks = '<span class="calmarks">';
      if (it && !past && it.mine) cls += " mine";
      if (selMode && selDays[ds] && !past) { cls += " selday " + selMode; if (selMode === "ng" && !(it && it.ng)) marks += '<span class="callbl to" style="color:var(--danger)">授業不可</span>'; }
      marks += "</span>";
      if (it && it.ngAll) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">授業不可</span>';
      var timed = [];
      if (it && it.ngT) it.ngT.forEach(function (b) { timed.push({start:b.start, end:b.end, html:unavailableBox(b, '授業不可', 'ng')}); });
      if (it && it.wish && !past) { if (it.wishL) it.wishL.slice(0, 3).forEach(function (t) { marks += '<span class="calbox wi">' + esc(t) + '</span>'; }); else marks += '<span class="callbl wi">授業可</span>'; }
      if (showToff && it && it.toff) marks += '<span class="callbl to" style="white-space:normal;overflow-wrap:anywhere">' + esc(toffText) + '</span>';
      if (showToff && it && it.toffT) it.toffT.forEach(function (o) { timed.push({start:o.start, end:o.end, html:unavailableBox(o, toffText, 'toff')}); });
      if (hasItems) {
        var lb = it.labels;
        // 授業1つ＝1つの箱(Googleカレンダー風)。確定・実施済みは青、案内は黄、重要な予定は赤系
        lb.forEach(function (l) {
          if (l.st === "event") { marks += '<span class="calbox ev">' + esc(l.text) + "</span>"; return; }
          var lc = (l.st === "offer" ? " of" : "") + (l.cls ? " " + l.cls : "");
          timed.push({start:l.start, end:l.end, lesson:true, html:'<span class="calbox' + lc + '"><span class="t">' + esc(l.start) + (l.end ? '-<wbr>' + esc(l.end) : '') + '</span><span class="s">' + esc(l.text) + '</span></span>'});
        });
      }
      if(opts.overlapLanes) marks += overlapMarkup(timed);
      else timed.sort(byStart).forEach(function(item) { marks += item.html; });
      if (holiday) marks = '<span class="calholiday">' + esc(holiday) + '</span>' + marks;
      var hasMarks = !!holiday || hasItems || !!(it && (it.ngAll || it.ngT || (showToff && (it.toff || it.toffT))));
      var clickable = !past || hasMarks; // 今日以降はどの日もタップ可(その日の操作ボタンが出る)。過去は何かある日だけ
      if (!clickable) h += '<span class="' + cls + " off" + '">' + d + marks + "</span>";
      else h += '<button class="' + cls + '" data-action="calday" data-date="' + ds + '">' + d + marks + "</button>";
    }
    h += '</div><div class="callegend">';
    h += '<span><span class="callbl" style="display:inline">授業</span></span>';
    if (opts.adminHealth) h += '<span><span class="callbl rq" style="display:inline">要対応</span> 実施未登録・記録なし・取消依頼</span>';
    else h += '<span><span class="callbl of" style="display:inline">授業（未承認）</span></span>';
    h += '<span><span class="callbl ev" style="display:inline">予定</span> 重要な予定（テスト・行事など）</span>';
    h += '<span><span class="callbl wi" style="display:inline">授業可</span> 授業できる時間帯（返事待ち）</span>';
    h += '<span><span class="callbl to ngswatch" style="display:inline">授業不可</span> 授業できない日</span>';
    if (showToff) h += '<span><span class="callbl to toffswatch" style="display:inline">' + esc(toffText) + '</span> ' + esc(toffLegend) + '</span>';
    if (opts.legendReq) h += '<span><span class="callbl rq" style="display:inline">取消依頼</span> 生徒から取消の依頼あり</span>';
    h += "</div>";
    if (calY > HOLIDAY_LAST_YEAR) h += '<p class="note">この年の祝日情報はまだ掲載していません。</p>';
    h += "</div>";
    return h;
  }

  return { overlapGroups: overlapGroups, holidayName: holidayName, buildInfo: buildInfo, render: render, endTime: endTime, addDaysStr: addDaysStr };
});
