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
// 科目ごとに小さなグラフを並べる（1 つのグラフに全科目の線を重ねると読めない。本人 2026-10-11）。
// 目盛りは全部の小さなグラフで同じにして、科目どうしを見比べられるようにする。各グラフに最新の値と前回からの差を添える
function miniCharts(list, caption, value, totalValue, fit, unit) {
  if (list.length < 2) return '';
  const n = list.length, mk = f => list.map((e, i) => ({ i, v: f(e), e })).filter(p => p.v !== null && p.v !== undefined && !Number.isNaN(p.v));
  const series = [{ name: '合計', pts: mk(totalValue) }, ...subjectsOf(list).map(s => ({ name: s, pts: mk(e => value(e, s)) }))].filter(x => x.pts.length >= 2);
  if (!series.length) return '';
  const ticks = fitTicks(series.flatMap(x => x.pts.map(p => p.v)), fit.step, fit.pad, fit.floor, fit.ceil, fit.minSteps);
  const min = ticks[0], max = ticks[ticks.length - 1];
  const W = 220, H = 110, L = 26, R = 10, T = 8, B = 18;
  const x = i => L + i * (W - L - R) / (n - 1), y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${Math.round(v)}</text>`).join('');
  const dates = [0, n - 1].map(i => `<text x="${x(i)}" y="${H - 5}" text-anchor="${i ? 'end' : 'start'}" font-size="9" fill="var(--muted)">${esc(md(list[i].date))}</text>`).join('');
  const one = ({ name, pts }) => {
    const last = pts[pts.length - 1], prev = pts[pts.length - 2], d = last.v - prev.v;
    const delta = Math.abs(d) < 0.05 ? '<span class="muted">→ 変わらず</span>' : `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${n1(Math.abs(d))}</span>`;
    const dots = pts.map(p => `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="3.5" fill="var(--primary)" stroke="var(--white)" stroke-width="1.5"><title>${esc(p.e.name)}（${esc(md(p.e.date))}）: ${n1(p.v)}${unit}</title></circle>`).join('');
    return `<figure class="gmini-one"><figcaption><strong>${esc(name)}</strong><span class="val">${n1(last.v)}${unit}</span>${delta}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)}の推移">${grid}${dates}<polyline fill="none" stroke="var(--primary)" stroke-width="2" points="${pts.map(p => x(p.i) + ',' + y(p.v)).join(' ')}"/>${dots}</svg></figure>`;
  };
  return `<div class="gmini"><div class="small muted">${caption}（最新と、前回からの差）</div><div class="gmini-grid">${series.map(one).join('')}</div></div>`;
}
// 推移: 模試は偏差値、定期テストは得点率（点数 ÷ 満点）。その種類の試験が 2 つ以上あるときだけ
export function gradeCharts(exams) {
  const list = exams.filter(e => e.scores.length).slice().sort((a, b) => a.date.localeCompare(b.date));
  const mock = list.filter(e => e.kind === 'mock'), regular = list.filter(e => e.kind !== 'mock');
  const find = (e, s) => e.scores.find(x => x.subject === s);
  const rate = (e, s) => { const x = find(e, s); return x && x.score !== null && x.max ? x.score / x.max * 100 : null; };
  const dev = (e, s) => { const x = find(e, s); return x && x.deviation !== null ? x.deviation : null; };
  const totalRate = e => e.total.score !== null && e.total.score !== undefined && e.total.max ? e.total.score / e.total.max * 100 : null;
  const totalDev = e => e.total.deviation !== null && e.total.deviation !== undefined ? e.total.deviation : null;
  return miniCharts(mock, '模試の偏差値の推移', dev, totalDev, { step: 5, pad: 2, floor: 20, ceil: 90, minSteps: 3 }, '')
    + miniCharts(regular, '定期テストの得点率の推移（%）', rate, totalRate, { step: 10, pad: 5, floor: 0, ceil: 100, minSteps: 3 }, '%');
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
  const mock = list.filter(e => e.kind === 'mock'), regular = list.filter(e => e.kind !== 'mock');
  const mockDev = mock.some(e => e.scores.some(s => s.deviation !== null && s.deviation !== undefined));
  return oneSummary(mock, mockDev, mockDev ? '模試の偏差値' : '模試の点数') + oneSummary(regular, false, '定期テストの点数');
}
// 試験のカード。opts.lessons は保護者向けの「その期間の授業」
export function examCard(e, { lessons = null, actions = '', sheets = [] } = {}) {
  const t = e.total, tparts = [t.score !== null && t.score !== undefined ? `合計 <strong>${n1(t.score)}</strong>${t.max ? ' / ' + n1(t.max) : ''}` : '', t.rank ? `${t.rank}位${t.rankOf ? ' / ' + t.rankOf + '人' : ''}` : '', t.deviation !== null && t.deviation !== undefined ? `偏差値 <strong>${n1(t.deviation)}</strong>` : ''].filter(Boolean);
  let h = `<div class="sheet stack gcard"><div class="ghead"><div><strong>${esc(e.name)}</strong> <span class="tag gray">${KIND[e.kind] || ''}</span></div><span class="small muted">${esc(md(e.date))}${e.grade ? '・' + esc(e.grade) : ''}</span></div>`;
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
  h += summaryTable(st.exams) + gradeCharts(st.exams);
  const list = st.exams.slice().reverse();
  h += list.map(e => examCard(e, { lessons: who === 'family' && st.lessons ? st.lessons.find(x => x.examId === e.id) : null })).join('');
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
