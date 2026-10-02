// スタッフの画面: 予定（3段目）。月の予定表・選んだ日の授業・連絡への対応・仮予定を作る・休み・面談。
// 教室管理者はすべて、講師は自分の担当の授業と自分の休みだけ。
import { STATUS, REQUEST, EVENT_KIND, mdw, endOf, statusTag, requestTags } from '/assets/v2/schedule-view.js?v=20261002-stage5c';

let month = null, data = null, sel = null, panel = '', editing = null, families = null, loadedFor = '';
const ymOf = d => d.slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const daysIn = ym => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0)).getUTCDate();
const gridStart = ym => { const first = new Date(ym + '-01T00:00:00Z'); return new Date(first - first.getUTCDay() * 86400e3).toISOString().slice(0, 10); };
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
export function resetSchedule() { data = null; loadedFor = ''; }

async function load(ctx) {
  const from = gridStart(month), to = addDays(from, 41);
  loadedFor = month;
  const r = await ctx.call('schedule/staff/range', { from, to });
  if (!r.ok) { if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); data = { lessons: [], openRequests: [], events: [], unavailability: [], meetings: [], students: [], staff: [], kinds: ['通常'], today: '', error: true }; }
  else { data = r; if (!sel) sel = r.today; }
  ctx.render();
}

export function schedulePage(ctx, me) {
  const { esc } = ctx, manager = me.roles.includes('manager');
  if (!month) month = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
  if (!data || loadedFor !== month) { if (loadedFor !== month) load(ctx); return '<h1>予定</h1><p class="muted">読み込んでいます…</p>'; }
  const nameOf = Object.fromEntries(data.students.map(s => [s.id, s.name])), staffOf = Object.fromEntries(data.staff.map(s => [s.id, s.name]));
  let h = `<h1>予定</h1>${data.live ? '' : '<p class="notice small">切り替え前のため、ここでの操作では Google カレンダーへの登録と保護者へのメールは行いません（今の仕組みのデータとは別です）。</p>'}${ctx.notice()}`;
  // 連絡への対応
  if (manager && data.openRequests.length) {
    h += `<h2>生徒・保護者からの連絡（${data.openRequests.length}件）</h2><div class="list">` + data.openRequests.map(r => `<div><div><span class="tag ${r.kind === 'cancel' ? 'danger' : 'warn'}">${REQUEST[r.kind]}</span> <strong>${esc(r.studentName)}</strong> ${mdw(r.date)} ${r.start} ${esc(r.subject)}
      <div class="small">${esc(r.note || '')}<span class="muted">（${r.fromKind === 'family' ? '保護者' : r.fromKind === 'student' ? '生徒' : 'スタッフ'}・${esc(r.receivedAt.slice(5, 16).replace('T', ' '))}）</span></div>
      <div class="small muted">${r.kind === 'move' ? '授業の日を開いて「直す」で日時を変えると、済みになります。' : r.kind === 'late' ? '応じるときは「直す」で開始時刻を変えてください（料金は変わりません）。' : r.kind === 'cancel' ? 'キャンセル料は請求の段階（5段目）で決めます。' : ''}</div></div>
      <div class="row"><button data-action="sch-goto" data-date="${r.date}">授業の日を開く</button><button data-action="sch-resolve" data-id="${esc(r.id)}"${ctx.dis()}>済みにする</button></div></div>`).join('') + '</div>';
  }
  // 予定表にまとめてある未送信
  const held = {};
  data.lessons.filter(l => l.status === 'held').forEach(l => { held[l.studentId] = (held[l.studentId] || 0) + 1; });
  if (manager && Object.keys(held).length) h += `<h2>未送信の仮予定</h2><div class="list">` + Object.entries(held).map(([sid, n]) => `<div><div><strong>${esc(nameOf[sid] || '')}</strong> ${n}件（この月の表示範囲）</div><div><button class="primary" data-action="sch-send" data-sid="${esc(sid)}"${ctx.dis()}>予定表を送る</button></div></div>`).join('') + '</div>';
  // 月の予定表
  h += `<div class="row" style="margin-top:16px"><button data-action="sch-month" data-n="-1">‹ 前の月</button><strong style="font-size:17px">${Number(month.slice(0, 4))}年${Number(month.slice(5))}月</strong><button data-action="sch-month" data-n="1">次の月 ›</button>
    <span style="flex:1"></span>${manager ? `<button data-action="sch-panel" data-p="create"${panel === 'create' ? ' class="primary"' : ''}>仮予定を作る</button>` : ''}<button data-action="sch-panel" data-p="off"${panel === 'off' ? ' class="primary"' : ''}>休みを登録</button>${manager ? `<button data-action="sch-panel" data-p="meeting"${panel === 'meeting' ? ' class="primary"' : ''}>面談</button>` : ''}</div>`;
  if (panel === 'create') h += createForm(ctx, me);
  if (panel === 'off') h += offForm(ctx, me, manager);
  if (panel === 'meeting') h += meetingForm(ctx);
  h += '<div class="month">' + ['日', '月', '火', '水', '木', '金', '土'].map(w => `<div class="wd">${w}</div>`).join('');
  const start = gridStart(month);
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i), ls = data.lessons.filter(l => l.date === d), offs = data.unavailability.filter(o => o.date === d);
    h += `<div class="${ymOf(d) !== month ? 'out' : ''} ${d === sel ? 'sel' : ''} ${d === data.today ? 'today' : ''}"><button class="d" data-action="sch-day" data-date="${d}"><span class="num">${Number(d.slice(8))}</span>`
      + offs.map(() => '<span class="chip off">休み</span>').join('')
      + ls.map(l => `<span class="chip ${l.status}">${l.start} ${esc((nameOf[l.studentId] || '').split(' ').pop())}</span>`).join('') + '</button></div>';
  }
  h += '</div>';
  h += dayPanel(ctx, me, manager, nameOf, staffOf);
  return h;
}

function dayPanel(ctx, me, manager, nameOf, staffOf) {
  const { esc } = ctx, d = sel;
  const ls = data.lessons.filter(l => l.date === d), offs = data.unavailability.filter(o => o.date === d), evs = data.events.filter(e => e.date <= d && d <= e.dateTo), mts = data.meetings.filter(m => m.date === d);
  let h = `<h2>${mdw(d)}</h2>`;
  if (!ls.length && !offs.length && !evs.length && !mts.length) return h + '<p class="muted">この日の予定はありません。</p>';
  h += '<div class="list">';
  offs.forEach(o => { h += `<div><div><span class="tag gray">休み</span> ${o.start ? o.start + '〜' + o.end : '終日'} ${esc(o.staffId ? staffOf[o.staffId] || '' : '教室全体')} <span class="small muted">${esc(o.note)}</span></div><div>${manager || o.staffId === me.id ? `<button data-action="sch-off-del" data-id="${esc(o.id)}"${ctx.dis()}>消す</button>` : ''}</div></div>`; });
  evs.forEach(e => { h += `<div><div><span class="tag ${e.kind === 'test' ? 'warn' : 'gray'}">${EVENT_KIND[e.kind]}</span> ${esc(e.studentName)} ${esc(e.title)}${e.start ? ' ' + e.start + '〜' + e.end : ''}</div><div>${manager ? `<button data-action="sch-ev-del" data-id="${esc(e.id)}"${ctx.dis()}>消す</button>` : ''}</div></div>`; });
  mts.forEach(m => { h += `<div><div><span class="tag">面談</span> ${m.start}〜${endOf(m.start, m.minutes)} ${esc(m.title)} ${m.deliveryMode === 'online' ? '<span class="tag gray">オンライン</span>' : ''}</div><div><button data-action="sch-mt-cancel" data-id="${esc(m.id)}"${ctx.dis()}>取りやめる</button></div></div>`; });
  ls.forEach(l => {
    const past = l.date <= data.today;
    h += `<div><div><strong>${l.start}〜${endOf(l.start, l.minutes)}</strong> ${esc(nameOf[l.studentId] || '')} ${esc(l.subject)}${l.kind !== '通常' ? '（' + esc(l.kind) + '）' : ''} ${l.deliveryMode === 'online' ? '<span class="tag gray">オンライン</span>' : ''}
      <div>${statusTag(l)}${requestTags(l)}${l.lateStart ? '<span class="tag gray">当日の時間変更</span>' : ''}</div>
      <div class="small muted">担当 ${esc(staffOf[l.staffId] || '未定')}${l.note ? '・' + esc(l.note) : ''}${l.meetUrl ? ` ・<a href="${esc(l.meetUrl)}" target="_blank" rel="noopener">Meet</a>` : ''}</div></div>
      <div class="row">${manager && ['held', 'proposed'].includes(l.status) ? `<button class="primary" data-action="sch-decide" data-id="${esc(l.id)}"${ctx.dis()}>決定する</button>` : ''}
      ${l.status === 'decided' && past && (manager || l.staffId === me.id) ? `<button class="primary" data-action="sch-done" data-id="${esc(l.id)}"${ctx.dis()}>実施済みにする</button>` : ''}
      ${['decided', 'done'].includes(l.status) && past && (manager || l.staffId === me.id) ? `<a href="#record=${encodeURIComponent(l.id)}">記録</a>` : ''}
      ${manager && ['held', 'proposed', 'decided'].includes(l.status) ? `<button data-action="sch-edit" data-id="${esc(l.id)}"${ctx.dis()}>直す</button>` : ''}
      ${manager && ['proposed', 'decided'].includes(l.status) ? `<button data-action="sch-rest" data-id="${esc(l.id)}"${ctx.dis()}>お休みにする</button>` : ''}
      ${manager && l.status === 'decided' ? `<button class="danger" data-action="sch-cancel" data-id="${esc(l.id)}"${ctx.dis()}>キャンセルにする</button>` : ''}
      ${manager && l.status !== 'done' ? `<button class="danger" data-action="sch-delete" data-id="${esc(l.id)}"${ctx.dis()}>削除</button>` : ''}</div>
      ${editing === l.id ? editForm(ctx, l) : ''}</div>`;
  });
  return h + '</div>';
}

const minutesOptions = v => [30, 45, 60, 90, 120, 150, 180].map(m => `<option value="${m}"${m === Number(v) ? ' selected' : ''}>${m}分</option>`).join('');
const staffOptions = (ctx, v) => '<option value="">未定</option>' + data.staff.filter(s => s.teacher).map(s => `<option value="${ctx.esc(s.id)}"${s.id === v ? ' selected' : ''}>${ctx.esc(s.name)}</option>`).join('');
const kindOptions = (ctx, v) => data.kinds.map(k => `<option${k === v ? ' selected' : ''}>${ctx.esc(k)}</option>`).join('');
function createForm(ctx, me) {
  const { esc } = ctx;
  return `<form class="stack sheet" data-form="sch-create"><strong>仮予定を作る</strong>
    <label>生徒<select name="studentId" required>${data.students.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始<input type="time" name="start" value="17:00" step="300" required></label><label style="flex:1">長さ<select name="minutes">${minutesOptions(90)}</select></label></div>
    <div class="row"><label style="flex:1">科目<input name="subject" maxlength="30" required placeholder="数学"></label><label style="flex:1">種類<select name="kind">${kindOptions(ctx, '通常')}</select></label>
      <label style="flex:1">形式<select name="deliveryMode"><option value="in_person">対面</option><option value="online">オンライン</option></select></label></div>
    <div class="row"><label style="flex:1">担当<select name="staffId">${staffOptions(ctx, me.id)}</select></label><label style="flex:1">くり返し<select name="repeat">${[1, 2, 3, 4, 5, 8, 12].map(n => `<option value="${n}">${n === 1 ? 'この日だけ' : '毎週×' + n + '回'}</option>`).join('')}</select></label></div>
    <label>送り方<select name="send"><option value="now">今すぐ送る（締め切りまでに連絡がなければ決定）</option><option value="hold">予定表にまとめて、あとで送る</option></select></label>
    <p class="small muted">締め切りは、送った日の3日後（翌月分だけなら今月25日）。授業の2日前を超えません。明日までの授業は締め切りを置かないので「決定する」で決めてください。</p>
    <div class="row"><button class="primary"${ctx.dis()}>作る</button><button type="button" data-action="sch-panel" data-p="">やめる</button></div></form>`;
}
function editForm(ctx, l) {
  const after = Date.now() > Date.parse(l.date + 'T23:00:00+09:00') - 86400e3;
  return `<form class="stack sheet" data-form="sch-update" data-id="${ctx.esc(l.id)}" data-version="${l.version}" style="grid-column:1/-1">
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${l.date}"></label><label style="flex:1">開始<input type="time" name="start" value="${l.start}" step="300"></label><label style="flex:1">長さ<select name="minutes">${minutesOptions(l.minutes)}</select></label></div>
    <div class="row"><label style="flex:1">科目<input name="subject" maxlength="30" value="${ctx.esc(l.subject)}"></label><label style="flex:1">種類<select name="kind">${kindOptions(ctx, l.kind)}</select></label>
      <label style="flex:1">形式<select name="deliveryMode"><option value="in_person"${l.deliveryMode === 'in_person' ? ' selected' : ''}>対面</option><option value="online"${l.deliveryMode === 'online' ? ' selected' : ''}>オンライン</option></select></label></div>
    <label>担当<select name="staffId">${staffOptions(ctx, l.staffId)}</select></label>
    <label>メモ（スタッフだけ）<input name="note" maxlength="1000" value="${ctx.esc(l.note || '')}"></label>
    ${l.status === 'decided' && after ? '<label class="checks"><label><input type="checkbox" name="lateStart"> 当日の開始時刻の変更として記録する（生徒の申し出・料金は変えない）</label></label>' : ''}
    <div class="row"><button class="primary"${ctx.dis()}>保存</button><button type="button" data-action="sch-edit-cancel">やめる</button></div></form>`;
}
function offForm(ctx, me, manager) {
  return `<form class="stack sheet" data-form="sch-off"><strong>休みを登録</strong>${manager ? `<label>だれの休み<select name="staffId"><option value="">教室全体</option>${data.staff.map(s => `<option value="${ctx.esc(s.id)}"${s.id === me.id ? ' selected' : ''}>${ctx.esc(s.name)}</option>`).join('')}</select></label>` : ''}
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始（終日なら空）<input type="time" name="start"></label><label style="flex:1">終了<input type="time" name="end"></label></div>
    <label>メモ（生徒には見せない）<input name="note" maxlength="100"></label><div class="row"><button class="primary"${ctx.dis()}>登録する</button><button type="button" data-action="sch-panel" data-p="">やめる</button></div></form>`;
}
function meetingForm(ctx) {
  if (!families) { ctx.call('admin/families/list').then(r => { families = r.ok ? r.families : []; ctx.render(); }); return '<p class="muted">読み込んでいます…</p>'; }
  return `<form class="stack sheet" data-form="sch-meeting"><strong>面談を登録</strong><label>家族<select name="familyId">${families.map(f => `<option value="${ctx.esc(f.id)}">${ctx.esc(f.name)}</option>`).join('')}</select></label>
    <div class="row"><label style="flex:1">日付<input type="date" name="date" value="${sel || ''}" required></label><label style="flex:1">開始<input type="time" name="start" value="19:00" step="300" required></label><label style="flex:1">長さ<select name="minutes">${[15, 20, 30, 45, 60].map(m => `<option value="${m}"${m === 30 ? ' selected' : ''}>${m}分</option>`).join('')}</select></label></div>
    <div class="row"><label style="flex:1">形式<select name="deliveryMode"><option value="in_person">対面</option><option value="online">オンライン（Meet）</option></select></label><label style="flex:2">題名<input name="title" value="面談" maxlength="60"></label></div>
    <div class="row"><button class="primary"${ctx.dis()}>登録する</button><button type="button" data-action="sch-panel" data-p="">やめる</button></div></form>`;
}

const lessonById = id => (data && data.lessons ? data.lessons.find(l => l.id === id) : null); // ほかの画面のボタン（data-id つき）でも落ちないように
const values = el => Object.fromEntries(new FormData(el).entries());
async function after(ctx, r, okMessage) {
  if (r.ok) { data = null; loadedFor = ''; editing = null; if (okMessage) ctx.say(okMessage, 'ok'); return true; }
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
    if (r.ok) { panel = ''; sel = v.date; ctx.say(r.held ? `${r.created}件を予定表に入れました（まだ送っていません）` : `${r.created}件の仮予定を送りました${r.confirmBy ? '（締め切り ' + Number(r.confirmBy.slice(5, 7)) + '/' + Number(r.confirmBy.slice(8)) + '）' : ''}`, 'ok'); data = null; loadedFor = ''; }
    return true;
  }
  if (kind === 'sch-update') {
    const body = { id: el.dataset.id, version: Number(el.dataset.version), date: v.date, start: v.start, minutes: Number(v.minutes), subject: v.subject, kind: v.kind, deliveryMode: v.deliveryMode, staffId: v.staffId, note: v.note, lateStart: v.lateStart === 'on' };
    let r = await ctx.call('schedule/lessons/update', body);
    if ((await after(ctx, r, '保存しました')) === 'force') { r = await ctx.call('schedule/lessons/update', { ...body, force: true }); await after(ctx, r, '保存しました'); }
    if (r.ok) sel = v.date;
    return true;
  }
  if (kind === 'sch-off') { await after(ctx, await ctx.call('schedule/unavailability/add', v), '休みを登録しました'); panel = ''; return true; }
  if (kind === 'sch-meeting') { await after(ctx, await ctx.call('schedule/meetings/create', { ...v, minutes: Number(v.minutes) }), '面談を登録しました'); panel = ''; return true; }
  return false;
}

export async function scheduleClick(ctx, a, b) {
  const id = b.dataset.id, l = id ? lessonById(id) : null;
  if (a === 'sch-month') { month = addMonths(month, Number(b.dataset.n)); sel = month + '-01'; data = null; return true; }
  if (a === 'sch-day') { sel = b.dataset.date; editing = null; return true; }
  if (a === 'sch-goto') { sel = b.dataset.date; if (ymOf(sel) !== month) { month = ymOf(sel); data = null; } return true; }
  if (a === 'sch-panel') { panel = panel === b.dataset.p ? '' : b.dataset.p; return true; }
  if (a === 'sch-edit') { editing = id; return true; }
  if (a === 'sch-edit-cancel') { editing = null; return true; }
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
