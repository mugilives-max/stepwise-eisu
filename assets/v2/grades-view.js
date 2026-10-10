// 成績の見せ方（保護者・生徒・スタッフで共通）。推移のグラフ・試験ごとのカード・成績票を送る・開く。
// グラフは得点率（点数 ÷ 満点）と偏差値を別々に描く（1つのグラフに目盛りを2つ置かない）。
import { esc, API } from '/assets/v2/api.js';

const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
export const jst = t => new Date(Date.parse(t) + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); // 保存した時刻（UTC）を日本時間で
const n1 = v => v === null || v === undefined ? '' : String(Math.round(v * 10) / 10);
const ORDER = ['英語', '数学', '国語', '理科', '社会'];
function subjectsOf(exams) {
  const set = []; for (const e of exams) for (const s of e.scores) if (!set.includes(s.subject)) set.push(s.subject);
  return set.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}
// 目盛り: 値の最小〜最大に少し余白を足して step の倍数に丸め、少なくとも minSteps 段は確保する（floor〜ceil の中で）。
// 偏差値を 30〜80 で固定すると、50 前後の数点の動きが読めない（本人 2026-10-11）
function fitTicks(values, step, pad, floor, ceil, minSteps) {
  if (!values.length) return [floor, ceil];
  let lo = Math.max(floor, Math.floor((Math.min(...values) - pad) / step) * step), hi = Math.min(ceil, Math.ceil((Math.max(...values) + pad) / step) * step);
  while (hi - lo < step * minSteps) { if (lo - step >= floor) lo -= step; else if (hi + step <= ceil) hi += step; else break; }
  const t = []; for (let v = lo; v <= hi + 1e-9; v += step) t.push(v);
  return t;
}
// 画面の中の選択（生徒ごと）: グラフの種類と科目、開いている試験。スタッフ・保護者・生徒の画面で共通。
// 1 画面に全科目の線を重ねず、科目の帯で切り替えて 1 本を大きく見せる（本人 2026-10-11「グラフが小さすぎて見えない。バーで表示科目を変えられるとか」）
const SEL = {};
export function gradeSel(studentId) { return SEL[studentId] || (SEL[studentId] = { series: '', subject: '合計', exam: '' }); }
// 試験の階層: 何の試験か（定期テスト・北辰テスト・東部地区テスト・英検 …）→ その中の回。定期テストを先に、あとは新しい順
export const SERIES_FIRST = ['定期テスト', '北辰テスト', '東部地区テスト', '英検'];
export function seriesOf(exams) {
  const last = {}; for (const e of exams) if (!last[e.series] || last[e.series] < e.date) last[e.series] = e.date;
  return Object.keys(last).sort((a, b) => (SERIES_FIRST.indexOf(a) + 1 || 99) - (SERIES_FIRST.indexOf(b) + 1 || 99) || last[b].localeCompare(last[a]));
}
// 帯（何の試験か）と、選んだものの試験。1 種類しかなければ帯は出さない
export function seriesPick(exams, studentId) {
  const all = seriesOf(exams), sel = gradeSel(studentId);
  if (!all.includes(sel.series)) sel.series = all[0] || '';
  const list = exams.filter(e => e.series === sel.series);
  const bar = all.length > 1 ? `<div class="gchips series">${all.map(x => chip('gv-series', studentId, `data-s="${esc(x)}"`, x, x === sel.series)).join('')}</div>` : '';
  return { bar, list, series: sel.series };
}
export function gradesClickShared(a, b) {
  if (a !== 'gv-subject' && a !== 'gv-series' && a !== 'gv-exam') return false;
  const sel = gradeSel(b.dataset.sid);
  if (a === 'gv-subject') sel.subject = b.dataset.s;
  else if (a === 'gv-series') { sel.series = b.dataset.s; sel.subject = '合計'; sel.exam = ''; }
  else sel.exam = b.dataset.id;
  return true;
}
const chip = (action, sid, attrs, label, on) => `<button type="button" class="gchip${on ? ' on' : ''}" data-action="${action}" data-sid="${esc(sid)}" ${attrs}${on ? ' aria-pressed="true"' : ''}>${esc(label)}</button>`;

// 推移のグラフ（1 本を大きく）。渡された試験（同じ種類）で、模試は偏差値、定期テストは得点率。上の帯で科目を選ぶ。目盛りは値に合わせる
export function gradeCharts(exams, studentId = '') {
  const cur = exams.filter(e => e.scores.length).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (cur.length < 2) return '';
  const sel = gradeSel(studentId);
  const useDev = cur.some(e => e.kind === 'mock') && cur.some(e => e.scores.some(x => x.deviation !== null && x.deviation !== undefined) || (e.total.deviation !== null && e.total.deviation !== undefined));
  const find = (e, s) => e.scores.find(x => x.subject === s);
  const value = (e, s) => s === '合計' ? (useDev ? (e.total.deviation ?? null) : (e.total.score !== null && e.total.score !== undefined && e.total.max ? e.total.score / e.total.max * 100 : null))
    : (() => { const x = find(e, s); if (!x) return null; return useDev ? (x.deviation ?? null) : (x.score !== null && x.max ? x.score / x.max * 100 : null); })();
  const subjects = ['合計', ...subjectsOf(cur)].filter(s => cur.filter(e => value(e, s) !== null).length >= 2);
  if (!subjects.length) return '';
  if (!subjects.includes(sel.subject)) sel.subject = subjects[0];
  const pts = cur.map((e, i) => ({ i, v: value(e, sel.subject), e })).filter(p => p.v !== null);
  const allVals = subjects.flatMap(s => cur.map(e => value(e, s))).filter(v => v !== null); // 目盛りは科目を切り替えても同じ（見比べられるように）
  const ticks = useDev ? fitTicks(allVals, 5, 2, 20, 90, 3) : fitTicks(allVals, 10, 5, 0, 100, 3);
  const min = ticks[0], max = ticks[ticks.length - 1], n = cur.length, unit = useDev ? '' : '%';
  const W = 640, H = 250, L = 38, R = 20, T = 26, B = 44;
  const x = i => n === 1 ? W / 2 : L + i * (W - L - R) / (n - 1), y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(v)}</text>`).join('');
  const short = s => { const t = String(s).replace(/テスト/g, '').replace(/[（(].*?[）)]/g, m => m.slice(1, -1)); return t.length > 7 ? t.slice(0, 7) + '…' : t; };
  const labels = cur.map((e, i) => `<text x="${x(i)}" y="${H - 26}" text-anchor="middle" font-size="11" fill="var(--ink)">${esc(short(e.name))}</text><text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(md(e.date))}</text>`).join('');
  const line = pts.length >= 2 ? `<polyline fill="none" stroke="var(--primary)" stroke-width="2.5" points="${pts.map(p => x(p.i) + ',' + y(p.v)).join(' ')}"/>` : '';
  const dots = pts.map(p => `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="5" fill="var(--primary)" stroke="var(--white)" stroke-width="2"><title>${esc(p.e.name)}（${esc(md(p.e.date))}）: ${n1(p.v)}${unit}</title></circle><text x="${x(p.i)}" y="${y(p.v) - 10}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--ink)">${n1(p.v)}</text>`).join('');
  const last = pts[pts.length - 1], prev = pts[pts.length - 2], d = last && prev ? last.v - prev.v : null;
  const delta = d === null ? '' : Math.abs(d) < 0.05 ? '<span class="muted">前回と同じ</span>' : `<span class="${d > 0 ? 'up' : 'down'}">前回から ${d > 0 ? '▲' : '▼'} ${n1(Math.abs(d))}${unit}</span>`;
  let h = '<div class="gchart">';
  h += `<div class="gchips">${subjects.map(s => chip('gv-subject', studentId, `data-s="${esc(s)}"`, s, s === sel.subject)).join('')}</div>`;
  h += `<div class="gchart-head"><strong>${esc(sel.subject)}</strong><span class="small muted">${useDev ? '偏差値' : '得点率（%）'}の推移</span><span class="small" style="margin-left:auto">${delta}</span></div>`;
  h += `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sel.subject)}の${useDev ? '偏差値' : '得点率'}の推移">${grid}${labels}${line}${dots}</svg></div>`;
  return h;
}

// 試験を 1 つずつ見る（‹ 北辰 3年3回 ›）。card(e) がその試験のカードを返す（本人 2026-10-11「カレンダーっぽく移動できるように」）
export function examPager(exams, studentId, card) {
  const list = exams.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)); // 新しい順
  if (!list.length) return '';
  const sel = gradeSel(studentId);
  let i = list.findIndex(e => e.id === sel.exam); if (i < 0) i = 0;
  const e = list[i], newer = list[i - 1], older = list[i + 1];
  const btn = (t, label, arrow) => t ? `<button type="button" class="icon" data-action="gv-exam" data-sid="${esc(studentId)}" data-id="${esc(t.id)}" aria-label="${label}">${arrow}</button>` : '<span class="icon-ph"></span>';
  const bar = list.length > 1 ? `<div class="gpager">${btn(older, '前の試験', '‹')}<div class="gpager-t"><strong>${esc(e.series ? e.series + ' ' : '')}${esc(e.name)}</strong><small>${esc(md(e.date))}・${list.length - i} / ${list.length}</small></div>${btn(newer, '次の試験', '›')}</div>` : '';
  return bar + card(e);
}

const KIND = { regular: '定期テスト', mock: '模試' };
const has = (rows, k) => rows.some(s => s[k] !== null && s[k] !== undefined);
// 科目ごとの表。列は、どれかの科目に値がある項目だけ（点数・平均・順位・偏差値）。数字は右寄せで、縦にそろえて読めるように
export function scoreTable(scores) {
  if (!scores.length) return '';
  const cols = [['score', '点数'], ['average', '平均'], ['rank', '順位'], ['deviation', '偏差値']].filter(([k]) => has(scores, k));
  const cell = (s, k) => k === 'score' ? (s.score !== null ? `<strong>${n1(s.score)}</strong>${s.max !== null && s.max !== 100 ? `<small>/${n1(s.max)}</small>` : ''}` : '')
    : k === 'rank' ? (s.rank !== null ? `${s.rank}位${s.rankOf ? `<small>/${s.rankOf}</small>` : ''}` : '') : n1(s[k]);
  return `<div class="gwrap"><table class="gtable"><thead><tr><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${scores.map(s => `<tr><th>${esc(s.subject)}</th>${cols.map(([k]) => `<td>${cell(s, k)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
// 試験をまたいだ一覧（行: 科目と合計、列: 試験）。模試は偏差値、定期テストは点数で、種類ごとに別の表。その種類の試験が 2 つ以上あるときだけ
function oneSummary(list, useDev, caption) {
  if (list.length < 2) return '';
  const subjects = subjectsOf(list);
  const val = (e, s) => { const x = e.scores.find(r => r.subject === s); return x ? n1(useDev ? x.deviation : x.score) : ''; };
  const tot = e => n1(useDev ? e.total.deviation : e.total.score);
  const head = e => `<th><span class="nm">${esc(e.name)}</span><small>${esc(md(e.date))}</small></th>`;
  return `<figure class="gsum"><figcaption class="small muted">${caption}</figcaption><div class="gwrap"><table class="gtable"><thead><tr><th></th>${list.map(head).join('')}</tr></thead><tbody>${subjects.map(s => `<tr><th>${esc(s)}</th>${list.map(e => `<td>${val(e, s)}</td>`).join('')}</tr>`).join('')}${list.some(e => tot(e)) ? `<tr class="tot"><th>合計</th>${list.map(e => `<td>${tot(e)}</td>`).join('')}</tr>` : ''}</tbody></table></div></figure>`;
}
export function summaryTable(exams) {
  const list = exams.filter(e => e.scores.length).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return '';
  const useDev = list.some(e => e.kind === 'mock') && list.some(e => e.scores.some(s => s.deviation !== null && s.deviation !== undefined));
  return oneSummary(list, useDev, `${esc(list[0].series)}の${useDev ? '偏差値' : '点数'}`);
}
// 試験のカード。opts.lessons は保護者向けの「その期間の授業」
export function examCard(e, { lessons = null, actions = '', sheets = [] } = {}) {
  const t = e.total, tparts = [t.score !== null && t.score !== undefined ? `合計 <strong>${n1(t.score)}</strong>${t.max ? ' / ' + n1(t.max) : ''}` : '', t.rank ? `${t.rank}位${t.rankOf ? ' / ' + t.rankOf + '人' : ''}` : '', t.deviation !== null && t.deviation !== undefined ? `偏差値 <strong>${n1(t.deviation)}</strong>` : ''].filter(Boolean);
  let h = `<div class="sheet stack gcard"><div class="ghead"><div><strong>${esc(e.name)}</strong> <span class="tag gray">${esc(e.series || KIND[e.kind] || '')}</span></div><span class="small muted">${esc(md(e.date))}${e.grade ? '・' + esc(e.grade) : ''}</span></div>`;
  if (tparts.length) h += `<div>${tparts.join('　')}</div>`;
  if (e.scores.length) h += scoreTable(e.scores);
  if (sheets.length) h += `<div class="small">成績票: ${sheets.map(f => `<button type="button" class="linkish" data-action="gr-open" data-id="${esc(f.id)}">${esc(f.name)}</button>`).join('　')}</div>`;
  if (e.otherSubjects && e.otherSubjects.length) h += `<div class="small muted">ほかの科目（${e.otherSubjects.map(esc).join('・')}）は合計に入っています</div>`;
  const r = e.review;
  if (r && (r.good || r.issues || r.nextSteps)) h += `<div class="small">${r.good ? `<div><strong>良かった点</strong> ${esc(r.good)}</div>` : ''}${r.issues ? `<div><strong>課題</strong> ${esc(r.issues)}</div>` : ''}${r.nextSteps ? `<div><strong>次の対策</strong> ${esc(r.nextSteps)}</div>` : ''}</div>`;
  if (lessons && Object.keys(lessons.counts).length) h += `<div class="small muted">この試験までの授業（${esc(md(lessons.from))}〜）: ${Object.entries(lessons.counts).map(([s, c]) => `${esc(s)} ${c}回`).join('・')}</div>`;
  return h + actions + '</div>';
}
const STATUS = { new: ['確かめ待ち', 'warn'], imported: ['取り込み済み', 'ok'], dismissed: ['確認済み', 'gray'] };
export function fileList(files, action) {
  if (!files.length) return '';
  return '<div class="list">' + files.map(f => `<div><div>${esc(f.name)} <span class="tag ${(STATUS[f.status] || ['', 'gray'])[1]}">${(STATUS[f.status] || [f.status])[0]}</span><div class="small muted">${esc(jst(f.createdAt).slice(0, 10))}${f.note ? '・' + esc(f.note) : ''}</div></div><div><button data-action="${action}" data-id="${esc(f.id)}">開く</button></div></div>`).join('') + '</div>';
}
export const uploadForm = (dis, extra = '') => `<form class="stack" data-form="gr-upload">${extra}<label>成績票の写真か PDF<input type="file" name="file" accept="image/*,application/pdf" required></label>
  <label>一言（任意）<input name="note" maxlength="200" placeholder="例: 2学期中間テストの個票"></label><button class="primary"${dis}>送る</button><p class="small muted">写真は読みやすい大きさに縮めて送ります。20MB まで。</p></form>`;

// 保護者・生徒の画面: 次のテスト・推移・試験のカード・成績票
export function gradesView(st, { who, dis = '' }) {
  let h = '';
  if (st.nextTest) h += `<p class="notice">${esc(st.nextTest.title || 'テスト')}まで あと <strong>${st.nextTest.days}日</strong>（${esc(md(st.nextTest.date))}）</p>`;
  if (!st.exams.length) h += '<p class="muted">まだ成績の記録はありません。成績票が返ってきたら、写真を送ってください。</p>';
  const pk = seriesPick(st.exams, st.id);
  h += pk.bar + summaryTable(pk.list) + gradeCharts(pk.list, st.id) + examPager(pk.list, st.id, e => examCard(e, { lessons: who === 'family' && st.lessons ? st.lessons.find(x => x.examId === e.id) : null }));
  h += `<h2>成績票を送る</h2>${uploadForm(dis, who === 'family' ? `<input type="hidden" name="studentId" value="${esc(st.id)}">` : '')}`;
  if (st.files.length) h += `<h3>送った成績票</h3>${fileList(st.files, 'gr-open')}`;
  return h;
}

// ---- 送る・開く ----
// 写真は長い辺 2000px の JPEG に縮める（読めないときはそのまま）。PDF はそのまま
async function shrink(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file), scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
// 送る: start(meta) で送る鍵をもらい（領域の操作。route と認証は呼ぶ側で付ける）、中身をそのまま送る。
// 中身は種類を付けずに送る（ブラウザの事前確認を起こさないため。種類はサーバーが中身から確かめる）
export async function uploadFile(rawFile, note, start) {
  const file = await shrink(rawFile);
  if (file.size > 20 * 1024 * 1024) return { ok: false, error: { message: 'ファイルは20MBまでにしてください' } };
  const mime = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  const r = await start({ name: file.name, mime, size: file.size, note });
  if (!r.ok) return r;
  try {
    const res = await fetch(API + r.uploadUrl, { method: 'POST', body: new Blob([file]) });
    return await res.json().catch(() => ({ ok: false, error: { message: '送れませんでした。もう一度お試しください' } }));
  } catch { return { ok: false, error: { message: '通信できませんでした。電波の良いところでもう一度お試しください' } }; }
}
// 開く: link() で開く鍵（5分）をもらい、先に開いておいた新しいタブ（win）に出す。タブが開けなければこの画面で開く
export async function openFile(link, win) {
  const r = await link();
  if (!r.ok) { if (win) win.close(); return r; }
  if (win && !win.closed) win.location.href = API + r.url; else location.href = API + r.url;
  return { ok: true };
}
