-- 授業の準備・授業記録の入力の時間（2026-10-07 本人決定。docs/REQUIREMENTS.md 5-1、docs/EMPLOYMENT_CONTRACT_DRAFT.md）
-- 1コマごとに10分を労働時間として足し、埼玉県の最低賃金（cf/v2/min-wage.mjs）で払う。明細には月ごとにまとめた行（kind = prep）を入れる
-- payrollItems.kind の CHECK に prep を足すため、表を作り直す（payrollItems はどこからも参照されていない）
CREATE TABLE payrollItems_new (
  id TEXT PRIMARY KEY,
  payrollId TEXT NOT NULL REFERENCES payrollMonths(id),
  kind TEXT NOT NULL CHECK (kind IN ('lesson', 'meeting', 'prep', 'adjust')),
  lessonId TEXT NOT NULL DEFAULT '',
  meetingId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',                -- 例: 数学（架空 一郎さん）・面談・授業の準備・記録（4コマ × 10分）・調整の理由
  rate INTEGER NOT NULL DEFAULT 0,               -- 時給（準備は最低賃金）
  amount INTEGER NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0
);
INSERT INTO payrollItems_new SELECT id, payrollId, kind, lessonId, meetingId, date, start, minutes, label, rate, amount, sortOrder FROM payrollItems;
DROP TABLE payrollItems;
ALTER TABLE payrollItems_new RENAME TO payrollItems;
CREATE INDEX payrollItems_payroll ON payrollItems(payrollId);
-- 月の明細に、準備の時間と金額（総支給額に入る）
ALTER TABLE payrollMonths ADD COLUMN prepMinutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payrollMonths ADD COLUMN prepAmount INTEGER NOT NULL DEFAULT 0;
