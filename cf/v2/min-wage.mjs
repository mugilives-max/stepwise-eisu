// 埼玉県最低賃金（時間額）。授業の準備・記録の時間を払う時給に使う（2026-10-07 本人「そこは最低賃金で」）
// 埼玉県「埼玉県の最低賃金・最低工賃」 https://www.pref.saitama.lg.jp/a0809/rodo/912-2009-1204-137.html
// 毎年10月ごろに変わる。改定が決まったら、発効日と額をここに足す（足すまで、前の改定から1年たった日以降の明細は確定できない）
export const MIN_WAGES = [
  { from: '2025-11-01', hourly: 1141 },
  { from: '2026-10-01', hourly: 1196 },
];

// その日の最低賃金。{ hourly } か、決められないとき { error }
export function minWageOn(date) {
  const w = MIN_WAGES.filter(m => m.from <= date).sort((a, b) => b.from.localeCompare(a.from))[0];
  if (!w) return { error: `${date} の埼玉県の最低賃金がシステムに入っていません` };
  const latest = MIN_WAGES[MIN_WAGES.length - 1];
  const nextYear = String(Number(latest.from.slice(0, 4)) + 1) + latest.from.slice(4);
  if (w === latest && date >= nextYear) return { error: `埼玉県の最低賃金が ${nextYear.slice(0, 4)}年に改定されていないか確かめて、cf/v2/min-wage.mjs に足してください` };
  return { hourly: w.hourly };
}
