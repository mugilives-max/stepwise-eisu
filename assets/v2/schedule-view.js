// 作り直し（v2）の予定の部品。スタッフ・保護者・生徒の画面で共通に使う（言葉と色をそろえる）。
import { esc } from '/assets/v2/api.js';
import { cancelRate, cancelAmount, ratePct } from '/assets/v2/cancel-rate.js?v=20261008-launch1';

export const STATUS = {
  held: ['gray', '未送信'], proposed: ['warn', '仮予定'], decided: ['', '決定'], done: ['ok', '実施済み'], rested: ['gray', 'お休み'], cancelled: ['danger', 'キャンセル'],
};
export const REQUEST = { move: '日時の変更のお願い', rest: 'お休みの連絡', late: '開始を遅らせたい', cancel: 'キャンセル' };
export const CHOICE = {
  move: ['日時の変更をお願いする', '無料', '先生が別の日時を相談します。決まるまでは今の日時のままです。', '希望の日時など（必須）'],
  rest: ['お休みにする', '無料', '前日23時までの連絡なので、料金はかかりません。', '理由（必須）'],
  late: ['開始を遅らせたい', '先生に相談', '先生の都合がつくときだけ応じます。応じた場合も料金は予定どおりで、追加はありません。', '何分ほど遅らせたいか（必須）'],
  cancel: ['キャンセルする', '1,000円', '前日23時を過ぎているため、キャンセル料（1回1,000円）がかかります。授業の開始後は授業料相当額です。急病などの事情があれば理由に書いてください。先生が確認し、減額・免除することがあります。', '理由（必須）'],
};
// 新しい決まりの授業（feeBase がある）: 今この時点で連絡した場合の金額を出す（規約案 第4〜6条）
const yen = n => Number(n).toLocaleString('ja-JP') + '円';
function rateChoice(l, c) {
  const rate = cancelRate(l.date, l.start, Date.now());
  if (c === 'cancel') { const amount = cancelAmount(l.feeBase, l.minutes, l.minutes, rate);
    return [CHOICE.cancel[0], yen(amount), `今キャンセルすると、キャンセル料は ${yen(amount)}（授業料の ${ratePct(rate)}%）です。キャンセル料は、連絡を受けた時刻で決まります（前日23時〜開始3時間前は25%、そこから開始時刻の100%まで上がります）。急な病気で受診した・電車の運休や15分以上の遅れなどで、分かってから30分以内のご連絡なら、資料を添えて免除を申請できます。`, CHOICE.cancel[3]]; }
  if (c === 'late') { const half = Math.min(30, l.minutes - 1), amount = cancelAmount(l.feeBase, l.minutes, half, rate);
    return [CHOICE.late[0], '先生に相談', `先生の都合がつくときだけ応じます。応じた場合は、遅らせた分の取消料がかかります（今の連絡で${half}分遅らせると ${yen(amount)}）。応じられない場合は、元の時刻に来られなければ、今の時刻でのキャンセルまたは遅刻として扱います。`, CHOICE.late[3]]; }
  return CHOICE[c];
}
const choiceOf = (l, c) => l.feeBase !== undefined && (c === 'cancel' || c === 'late') ? rateChoice(l, c) : CHOICE[c];
export const EVENT_KIND = { test: 'テスト', event: '行事', unavailable: '授業ができない日' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export const mdw = d => { const t = new Date(d + 'T00:00:00Z'); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + '(' + WD[t.getUTCDay()] + ')'; };
export const endOf = (start, minutes) => { const m = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + Number(minutes); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
export const statusTag = l => { const [cls, label] = STATUS[l.status] || ['gray', l.status]; return `<span class="tag ${cls}">${label}${l.status === 'proposed' && l.confirmBy ? ' ' + Number(l.confirmBy.slice(5, 7)) + '/' + Number(l.confirmBy.slice(8)) + 'まで' : ''}</span>`; };
export const requestTags = l => (l.requests || []).filter(r => r.status === 'open').map(r => `<span class="tag ${r.kind === 'cancel' ? 'danger' : 'warn'}">${REQUEST[r.kind]}</span>`).join('');

// 保護者・生徒の予定の一覧（日付ごと）。choices があれば「変更・お休みの連絡」のボタンを出す
export function familyLessonList(data, { names = {}, canRequest = true } = {}) {
  const lessons = data.lessons.filter(l => l.date >= data.today || l.status === 'proposed');
  if (!lessons.length) return '<p class="muted">これからの授業はありません。</p>';
  const kari = lessons.filter(l => l.status === 'proposed' && l.confirmBy);
  let h = kari.length ? `<p class="notice">仮予定が${kari.length}件あります。締め切りまでに連絡がなければ、この日時で決定します。都合の悪い授業だけ「変更・お休みの連絡」を押してください。</p>` : '';
  let last = '';
  h += '<div class="list">' + lessons.map(l => {
    const open = (l.requests || []).find(r => r.status === 'open' || (r.kind === 'rest' && l.status === 'rested'));
    const row = `${l.date !== last ? `<div class="day-head">${mdw(l.date)}</div>` : ''}<div><div><strong>${l.start}〜${endOf(l.start, l.minutes)}</strong> ${esc(names[l.studentId] || '')} ${esc(l.subject)}${l.kind && l.kind !== '通常' ? '（' + esc(l.kind) + '）' : ''} ${l.deliveryMode === 'online' ? '<span class="tag gray">オンライン</span>' : ''}
      <div>${statusTag(l)}${requestTags(l)}</div>${l.meetUrl && ['decided'].includes(l.status) ? `<div class="small"><a href="${esc(l.meetUrl)}" target="_blank" rel="noopener">Meet に参加</a></div>` : ''}</div>
      <div class="row">${open && ['move', 'late', 'cancel', 'rest'].includes(open.kind) && canRequest ? `<button data-action="withdraw" data-id="${esc(open.id)}">連絡を取り下げる</button>` : (l.choices || []).length && canRequest ? `<button data-action="change" data-id="${esc(l.id)}">変更・お休みの連絡</button>` : ''}</div></div>`;
    last = l.date; return row;
  }).join('') + '</div>';
  return h;
}

// 「変更・お休みの連絡」の選ぶ画面
export function changeDialog(l, pick, note, busy) {
  let h = `<div class="sheet" role="dialog" aria-label="変更・お休みの連絡"><p><strong>${mdw(l.date)} ${l.start}〜${endOf(l.start, l.minutes)}</strong> ${esc(l.subject)}${l.status === 'proposed' ? '（仮予定）' : ''}</p>`;
  if (!(l.choices || []).length) h += '<p>授業が始まっているため、ここからは連絡できません。先生に直接お知らせください。</p>';
  else {
    h += '<p>どうしますか？</p><div class="row">' + l.choices.map(c => `<button type="button" class="${pick === c ? 'primary' : ''}" aria-pressed="${pick === c}" data-action="pick" data-c="${c}">${choiceOf(l, c)[0]}（${choiceOf(l, c)[1]}）</button>`).join('') + '</div>';
    if (pick) {
      const offerRest = pick === 'rest' && l.status === 'proposed';
      h += `<p class="small muted">${offerRest ? 'この仮予定をお休みにします。料金はかかりません。' : choiceOf(l, pick)[2]}</p>`;
      if (!offerRest) h += `<input id="change-note" maxlength="500" value="${esc(note || '')}" placeholder="${choiceOf(l, pick)[3]}">`;
    }
  }
  h += `<div class="row" style="margin-top:10px">${pick ? `<button class="${pick === 'cancel' ? 'danger' : 'primary'}" data-action="send-change"${busy ? ' disabled' : ''}>${busy ? '送っています…' : '連絡する'}</button>` : ''}<button data-action="close-change">やめる</button></div></div>`;
  return h;
}

export function eventList(events, { names = {}, canDelete = () => false } = {}) {
  if (!events.length) return '<p class="muted">共有した予定はありません。</p>';
  return '<div class="list">' + events.map(e => `<div><div><span class="tag ${e.kind === 'unavailable' ? 'gray' : e.kind === 'test' ? 'warn' : ''}">${EVENT_KIND[e.kind]}</span> ${mdw(e.date)}${e.dateTo !== e.date ? '〜' + mdw(e.dateTo) : ''}${e.start ? ' ' + e.start + '〜' + e.end : ''} ${esc(names[e.studentId] || '')} ${esc(e.title)}</div>
    <div>${canDelete(e) ? `<button data-action="del-event" data-id="${esc(e.id)}">消す</button>` : ''}</div></div>`).join('') + '</div>';
}
export function eventForm(students) {
  return `<form class="stack" data-form="event">${students.length > 1 ? `<label>だれの予定<select name="studentId">${students.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>` : `<input type="hidden" name="studentId" value="${esc(students[0] ? students[0].id : '')}">`}
    <label>種類<select name="kind"><option value="test">テスト</option><option value="event">行事</option><option value="unavailable">授業ができない日</option></select></label>
    <div class="row"><label style="flex:1">日付<input type="date" name="date" required></label><label style="flex:1">終わりの日（同じ日なら空）<input type="date" name="dateTo"></label></div>
    <div class="row"><label style="flex:1">時間（任意）<input type="time" name="start"></label><label style="flex:1">〜<input type="time" name="end"></label></div>
    <label>内容（例: 2学期中間テスト）<input name="title" maxlength="60"></label><button class="primary">共有する</button></form>`;
}
