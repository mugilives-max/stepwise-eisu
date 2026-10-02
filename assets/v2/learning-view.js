// 作り直し（v2）の「学習」の部品（保護者・生徒で共通）。公開した授業記録と宿題。
import { esc } from '/assets/v2/api.js';
import { mdw } from '/assets/v2/schedule-view.js?v=20261002-stage6b';

const HW_STATUS = { open: ['warn', '未完了'], reported: ['', 'できたと報告（先生の確認待ち）'], confirmed: ['ok', '先生が確認'] };
const dueText = h => h.dueMode === 'none' ? '期限なし' : h.due ? mdw(h.due) + 'まで' : h.dueMode === 'nextLesson' ? '次の授業まで' : '';

export function learningView(data, { names = {} } = {}) {
  const open = data.homework.filter(h => h.status !== 'confirmed');
  let h = `<h2>宿題・持ち物（${open.length}件）</h2>`;
  h += open.length ? '<div class="list">' + open.map(w => `<div><div>${names[w.studentId] ? '<span class="small muted">' + esc(names[w.studentId]) + '</span> ' : ''}<strong>${esc(w.title)}</strong>${w.material ? '（' + esc(w.material) + '）' : ''}${w.kind === 'item' ? ' <span class="tag gray">持ち物</span>' : ''}
      <div class="small"><span class="tag ${HW_STATUS[w.status][0]}">${HW_STATUS[w.status][1]}</span> ${dueText(w)}${w.reviewNote && w.status === 'open' ? ` <span class="muted">先生から: ${esc(w.reviewNote)}</span>` : ''}</div></div>
      <div>${w.status === 'open' ? `<button class="primary" data-action="hw-done" data-id="${esc(w.id)}">できた</button>` : w.status === 'reported' ? `<button data-action="hw-undo" data-id="${esc(w.id)}">取り消す</button>` : ''}</div></div>`).join('') + '</div>' : '<p class="muted">未完了の宿題はありません。</p>';
  h += `<h2>授業の記録</h2>`;
  h += data.records.length ? '<div class="list">' + data.records.map(r => `<div><div><strong>${mdw(r.date)} ${esc(r.subject)}</strong>${r.kind && r.kind !== '通常' ? '（' + esc(r.kind) + '）' : ''} ${names[r.studentId] ? '<span class="small muted">' + esc(names[r.studentId]) + '</span>' : ''}
      ${r.range ? `<div class="small"><span class="muted">扱った範囲</span> ${esc(r.range)}</div>` : ''}<div style="white-space:pre-wrap">${esc(r.comment)}</div>${r.parentMessage ? `<div class="small" style="white-space:pre-wrap"><span class="muted">保護者の方へ</span> ${esc(r.parentMessage)}</div>` : ''}</div><div></div></div>`).join('') + '</div>' : '<p class="muted">公開された授業の記録はまだありません。</p>';
  return h;
}
