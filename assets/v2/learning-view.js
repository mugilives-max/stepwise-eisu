// 作り直し（v2）の「学習」の部品（保護者・生徒で共通）。公開した授業記録と宿題。
import { esc } from '/assets/v2/api.js';
import { mdw } from '/assets/v2/schedule-view.js?v=20261002-ux10';

const HW_STATUS = { open: ['warn', '未完了'], reported: ['', 'できたと報告（先生の確認待ち）'], confirmed: ['ok', '先生が確認'] };
// 宿題の1行: 「教材 範囲」（例: Keywork p.10-12）。科目は授業の科目、期限は次のその科目の授業（docs/REQUIREMENTS.md 宿題）
export const hwText = w => [w.material, w.title].filter(Boolean).join(' ');
export const hwSubject = w => w.kind === 'item' ? '持ち物' : w.dueSubject || '';
// 授業で先生がチェックした結果（一部・やってこなかった は持ち越し中）
const CHECK_TEXT = { done: ['ok', 'やってきた'], partial: ['warn', '一部だけ'], notDone: ['danger', 'やってこなかった'] };
export const checkTag = w => w.checkResult && CHECK_TEXT[w.checkResult] && w.checkResult !== 'done' && w.status === 'open' ? ` <span class="tag ${CHECK_TEXT[w.checkResult][0]}">前の授業で${CHECK_TEXT[w.checkResult][1]}</span>` : '';
const dueText = h => h.dueMode === 'none' ? '期限なし' : h.due ? mdw(h.due) + 'まで' : h.dueMode === 'nextLesson' ? '次の授業まで' : '';

function checkedIn(data, r) {
  const list = data.homework.filter(w => w.checkedRecordId === r.id && CHECK_TEXT[w.checkResult]);
  return list.length ? `<div class="small"><span class="muted">宿題のチェック</span> ${list.map(w => `${esc(hwText(w))} <span class="tag ${CHECK_TEXT[w.checkResult][0]}">${CHECK_TEXT[w.checkResult][1]}</span>`).join(' ')}</div>` : '';
}
export function learningView(data, { names = {} } = {}) {
  const open = data.homework.filter(h => h.status !== 'confirmed');
  let h = `<h2>宿題（${open.length}件）</h2>`;
  h += open.length ? '<div class="list">' + open.map(w => `<div><div>${names[w.studentId] ? '<span class="small muted">' + esc(names[w.studentId]) + '</span> ' : ''}${hwSubject(w) ? '<span class="small muted">' + esc(hwSubject(w)) + '</span> ' : ''}<strong>${esc(hwText(w))}</strong>
      <div class="small"><span class="tag ${HW_STATUS[w.status][0]}">${HW_STATUS[w.status][1]}</span>${checkTag(w)} ${dueText(w)}${w.reviewNote && w.status === 'open' ? ` <span class="muted">先生から: ${esc(w.reviewNote)}</span>` : ''}</div></div>
      <div>${w.status === 'open' ? `<button class="primary" data-action="hw-done" data-id="${esc(w.id)}">できた</button>` : w.status === 'reported' ? `<button data-action="hw-undo" data-id="${esc(w.id)}">取り消す</button>` : ''}</div></div>`).join('') + '</div>' : '<p class="muted">未完了の宿題はありません。</p>';
  h += `<h2>授業の記録</h2>`;
  h += data.records.length ? '<div class="list">' + data.records.map(r => `<div><div><strong>${mdw(r.date)} ${esc(r.subject)}</strong>${r.kind && r.kind !== '通常' ? '（' + esc(r.kind) + '）' : ''} ${names[r.studentId] ? '<span class="small muted">' + esc(names[r.studentId]) + '</span>' : ''}
      ${r.range ? `<div class="small"><span class="muted">扱った範囲</span> ${esc(r.range)}</div>` : ''}<div style="white-space:pre-wrap">${esc(r.comment)}</div>${r.parentMessage ? `<div class="small" style="white-space:pre-wrap"><span class="muted">保護者の方へ</span> ${esc(r.parentMessage)}</div>` : ''}${checkedIn(data, r)}</div><div></div></div>`).join('') + '</div>' : '<p class="muted">公開された授業の記録はまだありません。</p>';
  return h;
}
