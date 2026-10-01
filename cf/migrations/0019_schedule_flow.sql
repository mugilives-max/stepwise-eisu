-- 日程の決め方（段階1、2026-10-01）: 仮予定の締め切りと「日時の変更のお願い」。gas/ScheduleFlow.gs
-- confirmBy: YYYY-MM-DD（その日まで連絡がなければ決定）/ 'hold'（予定表にまとめてまだ送っていない）/ 空（締め切りなし）
ALTER TABLE slots ADD COLUMN confirmBy TEXT NOT NULL DEFAULT '';
ALTER TABLE slots ADD COLUMN changeReqAt TEXT NOT NULL DEFAULT '';
ALTER TABLE slots ADD COLUMN changeReqBy TEXT NOT NULL DEFAULT '';
ALTER TABLE slots ADD COLUMN changeReqKind TEXT NOT NULL DEFAULT '';
ALTER TABLE slots ADD COLUMN changeReqNote TEXT NOT NULL DEFAULT '';
-- 保護者のメール設定「授業予定表・予定日の決定」（0 = 受け取らない）
ALTER TABLE familyEmailPrefs ADD COLUMN schedule INTEGER NOT NULL DEFAULT 1;
