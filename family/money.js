// 保護者の画面: 計画・お支払い（5段目）。授業計画の承認、キャンセル料、月ごとの請求と振込の連絡。
import { esc } from '/assets/v2/api.js';
import { partText } from '/assets/v2/cancel-rate.js?v=20261003-ux31';

const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
const monthLabel = m => `${m.slice(0, 4)}年${Number(m.slice(5))}月分`;
const INV = { confirmed: ['お支払い待ち', 'warn'], reported: ['入金確認待ち', ''], paid: ['お支払い完了', 'ok'] };

function lineText(l, multi) {
  const period = l.startDate.slice(8) === '01' && Number(l.endDate.slice(8)) >= 28 && l.startDate.slice(0, 7) === l.endDate.slice(0, 7) ? `${Number(l.startDate.slice(5, 7))}月` : `${md(l.startDate)}〜${md(l.endDate)}`;
  return `${multi ? esc(l.studentName) + 'さん ' : ''}<strong>${esc(l.subject)}</strong>${l.kind !== '通常' ? '（' + esc(l.kind) + '）' : ''}${l.parentId ? ' <span class="tag">追加</span>' : ''} ${period}<div class="small">${l.count}回・1回 ${l.minutes}分・1回 ${yen(l.fee)}（${l.count}回で ${yen(l.fee * l.count)}）</div>${l.comment ? `<div class="small muted">${esc(l.comment)}</div>` : ''}`;
}

export function moneyView(data, { multi, dis }) {
  let h = '';
  // 承認をお願いしている計画
  const asks = data.plans.filter(l => l.status === 'proposed');
  const acks = data.plans.filter(l => l.status === 'approved' && l.approvedBy === 'staff' && !l.familyAck);
  if (asks.length || acks.length) {
    h += '<h2>確かめていただきたいこと</h2><div class="list">';
    h += asks.map(l => `<div><div>${lineText(l, multi)}<form class="row" data-form="plan-decide" data-id="${esc(l.id)}" data-version="${l.version}" style="margin-top:6px">
      <label>回数<select name="count">${Array.from({ length: l.count - l.minCount + 1 }, (_, i) => l.count - i).map(n => `<option value="${n}">${n}回</option>`).join('')}${l.minCount === 0 ? '<option value="0">見送る</option>' : ''}</select></label>
      <button class="primary"${dis}>この回数で承認する</button></form>${l.minCount ? `<div class="small muted">すでに決まっている授業が${l.minCount}回あるため、${l.minCount}回より少なくはできません。</div>` : ''}</div><div></div></div>`).join('');
    h += acks.map(l => `<div><div>${lineText(l, multi)}<div class="small">${esc(l.approvedVia)}で承諾をいただいたと、先生が記録しました（${esc(l.consentDate)}）。${l.approvedCount !== l.count ? `回数は ${l.approvedCount}回です。` : ''}</div>
      <div class="row" style="margin-top:6px"><button class="primary" data-action="plan-ack" data-id="${esc(l.id)}" data-version="${l.version}"${dis}>内容を確認しました</button></div>
      <form class="row" data-form="plan-inquiry" data-id="${esc(l.id)}" data-version="${l.version}"><input name="note" maxlength="500" placeholder="違うところがあれば書いてください" style="flex:1" required><button${dis}>先生に問い合わせる</button></form></div><div></div></div>`).join('');
    h += '</div>';
  }
  // 請求
  h += '<h2>授業料</h2><p class="small muted">実施した授業の分を、翌月3日に確定してお知らせします。キャンセル料も同じ請求に入ります。</p>';
  h += data.invoices.length ? '<div class="list">' + data.invoices.map(v => {
    const [label, cls] = INV[v.status] || [v.status, ''], byStudent = {};
    for (const i of v.items) (byStudent[i.studentName] = byStudent[i.studentName] || []).push(i);
    return `<div><div><strong>${monthLabel(v.month)}</strong> ${yen(v.total)} <span class="tag ${cls}">${label}</span><details><summary class="small">内訳</summary>${Object.entries(byStudent).map(([name, items]) => `${multi ? `<div class="small"><strong>${esc(name)}さん</strong></div>` : ''}<table class="small" style="width:100%">${items.map(i => `<tr><td>${i.date ? md(i.date) : ''}</td><td>${esc(i.subject)}${i.label ? ' ' + esc(i.label) : ''}</td><td>${i.kind === 'lesson' ? i.minutes + '分' : ''}</td><td style="text-align:right">${yen(i.amount)}</td></tr>`).join('')}</table>`).join('')}</details>
      ${v.status === 'reported' ? '<div class="small muted">振込のご連絡ありがとうございます。入金を確かめます。</div>' : v.status === 'paid' ? `<div class="small muted">入金を確認しました（${esc(v.paidOn)}）。</div>` : ''}</div>
      <div>${v.status === 'confirmed' ? `<button class="primary" data-action="inv-report" data-id="${esc(v.id)}" data-version="${v.version}"${dis}>振り込みました</button>` : ''}</div></div>`;
  }).join('') + '</div>' : '<p class="muted">まだ請求はありません。</p>';
  // キャンセル料
  if (data.fees.length) {
    h += '<h2>キャンセル料・取消料</h2><p class="small muted">前日23時を過ぎてからのキャンセル・開始を遅らせた分・遅刻にかかります。金額は連絡を受けた時刻で決まります。やむを得ない事情のときは、減額・免除を申請できます。</p><div class="list">';
    h += data.fees.map(f => `<div><div>${multi ? esc(f.studentName) + 'さん ' : ''}${md(f.date)} ${esc(f.start)} ${esc(f.subject)} <strong>${yen(f.amount)}</strong>${f.invoiceId ? ' <span class="tag gray">請求済み</span>' : ''}
      ${(f.parts || []).length ? `<div class="small muted">${f.parts.map(p => esc(partText(p, f.date))).join('<br>')}</div>` : ''}${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}${f.reliefStatus === 'pending' ? '<div class="small">減額・免除の申請を受け付けました。先生からの回答をお待ちください。</div>' : f.reliefStatus ? `<div class="small">申請への回答: ${esc(f.reliefResponse)}</div>` : ''}
      ${!f.reliefStatus && !f.invoiceId && f.amount > 0 ? `<details><summary class="small">減額・免除を申請する</summary><form class="stack" data-form="fee-relief" data-id="${esc(f.id)}" data-version="${f.version}"><textarea name="reason" maxlength="1000" rows="2" placeholder="事情を書いてください（例: 急に熱が出たため）" required></textarea><button${dis}>申請する</button></form></details>` : ''}</div><div></div></div>`).join('');
    h += '</div>';
  }
  // 計画の一覧
  const others = data.plans.filter(l => !asks.includes(l) && !acks.includes(l));
  if (others.length) h += '<h2>授業計画</h2><div class="list">' + others.map(l => `<div><div>${lineText(l, multi)}<div class="small muted">${l.status === 'approved' ? `承認（${l.approvedCount}回・${esc(l.consentDate)}・${esc(l.approvedVia)}）` : '見送り'}${l.familyAck === 'inquiry' ? '・問い合わせ済み' : ''}</div></div><div></div></div>`).join('') + '</div>';
  return h;
}
