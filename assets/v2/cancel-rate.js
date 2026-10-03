// 取消料の計算（規約案 第4条。docs/CANCELLATION_POLICY_DESIGN.md 4）。サーバー（cf/v2/plan-calc.mjs）と画面の両方で使うので、ほかを import しない。
// 取消料 = 1回の授業料 ×（行わなかった分数 ÷ 予定の分数）× 率。10円未満は切り捨て。
// 率は 1/720 を単位にした整数で持つ（25% = 180、100% = 720。開始3時間前から開始までは 1分ごとに 3 ずつ上がる）。
// - 前日23時まで: 0（日時の変更・お休み）
// - 前日23時〜開始3時間前: 25%
// - 開始3時間前〜開始: 100% − 75% × 残りの分数 ÷ 180
// - 開始以降・連絡なし: 100%
export const RATE_FULL = 720;
export const RATE_EARLY = 180;
const DAY = 86400000;
export const startAt = (date, start) => Date.parse(date + 'T' + start + ':00+09:00');
export const freeUntil = date => Date.parse(date + 'T23:00:00+09:00') - DAY; // 前日23時

// receivedMs: 連絡を受けた時刻（ミリ秒）。null・NaN は連絡なし
export function cancelRate(date, start, receivedMs) {
  if (receivedMs === null || receivedMs === undefined || Number.isNaN(receivedMs)) return RATE_FULL;
  if (receivedMs <= freeUntil(date)) return 0;
  const s = startAt(date, start);
  if (receivedMs >= s) return RATE_FULL;
  const left = Math.floor((s - receivedMs) / 60000);
  return left >= 180 ? RATE_EARLY : RATE_FULL - 3 * left;
}
// 取消料（円）。整数だけで計算する
export function cancelAmount(baseFee, plannedMinutes, minutes, rate) {
  if (!(plannedMinutes > 0) || !(minutes > 0) || !(rate > 0)) return 0;
  return Math.floor(baseFee * minutes * rate / (plannedMinutes * RATE_FULL * 10)) * 10;
}
// 表示用の率（%、小数1けた）
export const ratePct = rate => Math.round(rate * 100 / 72) / 10;

// 取消の内訳の説明（請求・キャンセル料の一覧で使う）。lessonDate と違う日の連絡は日付も出す
export const PART_NAME = { cancel: 'キャンセル', delay: '開始を遅らせた分', tardy: '遅刻' };
const jst = t => new Date(Date.parse(t) + 9 * 3600e3).toISOString();
export function partText(p, lessonDate) {
  const t = p.receivedAt ? jst(p.receivedAt) : '';
  const when = !t ? '連絡なし' : (t.slice(0, 10) === lessonDate ? '' : Number(t.slice(5, 7)) + '/' + Number(t.slice(8, 10)) + ' ') + t.slice(11, 16) + ' に連絡';
  return `${PART_NAME[p.reason] || p.reason}${p.reason === 'cancel' ? '' : ' ' + p.minutes + '分'}（${when}・率 ${ratePct(p.rate)}%・${Number(p.amount).toLocaleString('ja-JP')}円）`;
}
// 今の時刻の JST の 'YYYY-MM-DDTHH:MM'（input type=datetime-local の初期値）
export const nowLocal = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16);
