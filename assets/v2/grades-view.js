// 成績の見せ方（保護者・生徒・スタッフで共通）。推移のグラフ・試験ごとのカード・成績票を送る・開く。
// グラフは得点率（点数 ÷ 満点）と偏差値を別々に描く（1つのグラフに目盛りを2つ置かない）。
import { esc, API } from '/assets/v2/api.js';

const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
export const jst = t => new Date(Date.parse(t) + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); // 保存した時刻（UTC）を日本時間で
const n1 = v => v === null || v === undefined ? '' : String(Math.round(v * 10) / 10);
// 科目の色（色覚の違いでも見分けやすい組み合わせ）。科目の順は固定して、色が入れ替わらないようにする
const COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9'];
const ORDER = ['英語', '数学', '国語', '理科', '社会'];
function subjectsOf(exams) {
  const set = []; for (const e of exams) for (const s of e.scores) if (!set.includes(s.subject)) set.push(s.subject);
  return set.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}

// 1つのグラフ。value(e, subject) が null の点は描かない。どの科目も点が2つ未満なら描かない（推移にならない）
function chart(exams, subjects, value, { title, ticks, unit }) {
  const pts = subjects.map(s => exams.map((e, i) => ({ i, v: value(e, s), e })).filter(p => p.v !== null));
  if (!pts.some(p => p.length >= 2)) return '';
  const min = ticks[0], max = ticks[ticks.length - 1];
  const W = 640, H = 220, L = 36, R = 70, T = 14, B = 34, n = exams.length;
  const x = i => n === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (n - 1), y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(v)}</text>`).join('');
  const labels = exams.map((e, i) => `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(md(e.date))}</text>`).join('');
  // 線の右端の科目名: 縦に14px以上あけて重ならないようにする
  // 途中で終わった線（最後の試験に点がない科目）には付けない（凡例で分かる）
  const ends = pts.map((p, k) => p.length && p[p.length - 1].i === n - 1 ? { k, x: x(p[p.length - 1].i), y: y(p[p.length - 1].v) } : null).filter(Boolean).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const lines = pts.map((p, k) => {
    if (!p.length) return '';
    const c = COLORS[k % COLORS.length];
    return `<polyline fill="none" stroke="${c}" stroke-width="2" points="${p.map(q => x(q.i) + ',' + y(q.v)).join(' ')}"/>`
      + p.map(q => `<circle cx="${x(q.i)}" cy="${y(q.v)}" r="4.5" fill="${c}" stroke="var(--white)" stroke-width="2"><title>${esc(subjects[k])} ${esc(q.e.name)}（${esc(md(q.e.date))}）: ${n1(q.v)}${unit}</title></circle>`).join('');
  }).join('') + ends.map(e => `<text x="${e.x + 8}" y="${e.y + 4}" font-size="12" fill="var(--ink)">${esc(subjects[e.k])}</text>`).join('');
  const legend = subjects.map((s, k) => pts[k].length ? `<span class="small" style="margin-right:10px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${COLORS[k % COLORS.length]};margin-right:4px"></span>${esc(s)}</span>` : '').join('');
  return `<figure style="margin:8px 0"><figcaption class="small muted">${esc(title)}</figcaption><div>${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;max-width:${W}px">${grid}${labels}${lines}</svg></figure>`;
}
// 推移: 得点率（%）と偏差値。試験が2つ以上あるときに描く
export function gradeCharts(exams) {
  const list = exams.filter(e => e.scores.length);
  if (list.length < 2) return '';
  const subjects = subjectsOf(list), find = (e, s) => e.scores.find(x => x.subject === s);
  const rate = (e, s) => { const x = find(e, s); return x && x.score !== null && x.max ? x.score / x.max * 100 : null; };
  const dev = (e, s) => { const x = find(e, s); return x && x.deviation !== null ? x.deviation : null; };
  return chart(list, subjects, rate, { title: '得点率の推移（%）', ticks: [0, 25, 50, 75, 100], unit: '%' }) + chart(list, subjects, dev, { title: '偏差値の推移', ticks: [30, 40, 50, 60, 70, 80], unit: '' });
}

const KIND = { regular: '定期テスト', mock: '模試' };
function scoreRow(s) {
  const parts = [s.score !== null ? `<strong>${n1(s.score)}</strong>${s.max !== null ? ' / ' + n1(s.max) : ''}` : '', s.average !== null ? `平均 ${n1(s.average)}` : '', s.rank !== null ? `${s.rank}位${s.rankOf ? ' / ' + s.rankOf + '人' : ''}` : '', s.deviation !== null ? `偏差値 ${n1(s.deviation)}` : ''].filter(Boolean);
  return `<tr><td>${esc(s.subject)}</td><td>${parts.join('　')}</td></tr>`;
}
// 試験のカード。opts.lessons は保護者向けの「その期間の授業」
export function examCard(e, { lessons = null, actions = '' } = {}) {
  const t = e.total, tparts = [t.score !== null && t.score !== undefined ? `合計 <strong>${n1(t.score)}</strong>${t.max ? ' / ' + n1(t.max) : ''}` : '', t.rank ? `${t.rank}位${t.rankOf ? ' / ' + t.rankOf + '人' : ''}` : '', t.deviation !== null && t.deviation !== undefined ? `偏差値 ${n1(t.deviation)}` : ''].filter(Boolean);
  let h = `<div class="sheet stack"><div><strong>${esc(e.name)}</strong> <span class="tag gray">${KIND[e.kind] || ''}</span> <span class="small muted">${esc(md(e.date))}${e.grade ? '・' + esc(e.grade) : ''}</span></div>`;
  if (tparts.length) h += `<div>${tparts.join('　')}</div>`;
  if (e.scores.length) h += `<table class="small" style="width:100%">${e.scores.map(scoreRow).join('')}</table>`;
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
  h += gradeCharts(st.exams);
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
