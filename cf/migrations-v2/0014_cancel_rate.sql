-- 作り直し（v2）: 取消料の自動計算（規約案 第4〜7条。docs/CANCELLATION_POLICY_DESIGN.md 4）
-- 新しい決まりは、授業の日が settings の cancelRuleFrom（YYYY-MM-DD）以降の授業から。それより前の授業は今までどおり（1,000円 / 授業料、教室管理者が判断）。
-- rule: '' = 今までの決まり / 'rate' = 新しい決まり（自動で計算して decision = 'charge'）
-- baseFee: 1回の授業料、plannedMinutes: 予定の分数（計算したときの値）
-- parts: 取消の内訳（JSON の配列）。{ reason: cancel（キャンセル）/ delay（開始を遅らせた）/ tardy（遅刻）, minutes: 行わなかった分数, receivedAt: 連絡を受けた時刻（空 = 連絡なし）, rate: 率（1/720 単位）, amount: 円 }
ALTER TABLE cancellationFees ADD COLUMN rule TEXT NOT NULL DEFAULT '';
ALTER TABLE cancellationFees ADD COLUMN baseFee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cancellationFees ADD COLUMN plannedMinutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cancellationFees ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
-- 遅刻で行わなかった分数（授業の開始時刻・長さは予定のまま。授業料は 長さ − lostMinutes の分）
ALTER TABLE lessons ADD COLUMN lostMinutes INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO settings (key, value, updatedAt) VALUES ('cancelRuleFrom', '2026-11-01', '2026-10-03T00:00:00.000Z');
