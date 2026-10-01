-- 2段目: 家族・生徒の管理と、今の台帳からの写し。docs/REBUILD_DESIGN.md
-- 保護者の名前と電話（今は生徒台帳の「保護者名」「保護者連絡先」にある）
ALTER TABLE families ADD COLUMN guardianName TEXT NOT NULL DEFAULT '';
ALTER TABLE families ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE families ADD COLUMN note TEXT NOT NULL DEFAULT '';
-- 今の台帳のどの行から写したか（写し直しても同じ行に当てるため）。新しく作った行は空
ALTER TABLE families ADD COLUMN legacyId TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN legacyId TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN enrolledOn TEXT NOT NULL DEFAULT '';   -- 入塾日（YYYY-MM-DD）
ALTER TABLE students ADD COLUMN subjects TEXT NOT NULL DEFAULT '';     -- 受講科目（表示用のメモ）
