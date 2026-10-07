-- 講師の契約を業務委託から雇用（アルバイト）に変える（2026-10-07 本人決定。docs/REQUIREMENTS.md 5-1）
-- staff.contractType: 'contractor'（業務委託）→ 'employee'（雇用）。CHECK を変えるため、列を作り直す
--   （staff は多くの表から参照されるので表ごと作り直さない。列を足して → 古い列を消して → 名前を変える）
-- 源泉徴収は「する・しない」（staff.withholding、10.21%）をやめ、給与所得の源泉徴収税額表（月額表）の甲欄・乙欄で計算する
--   taxColumn: kou（甲欄。扶養控除等申告書を出している）/ otsu（乙欄。出していない）。dependents: 扶養親族等の数（甲欄、0〜7）
ALTER TABLE staff ADD COLUMN employment TEXT NOT NULL DEFAULT 'employee' CHECK (employment IN ('owner', 'employee'));
UPDATE staff SET employment = CASE contractType WHEN 'owner' THEN 'owner' ELSE 'employee' END;
ALTER TABLE staff DROP COLUMN contractType;
ALTER TABLE staff RENAME COLUMN employment TO contractType;
ALTER TABLE staff DROP COLUMN withholding;
ALTER TABLE staff ADD COLUMN taxColumn TEXT NOT NULL DEFAULT 'otsu' CHECK (taxColumn IN ('kou', 'otsu'));
ALTER TABLE staff ADD COLUMN dependents INTEGER NOT NULL DEFAULT 0 CHECK (dependents BETWEEN 0 AND 7);
-- 確定した明細に、計算に使った欄と人数を残す（'' = 業務委託として 10.21% で計算した前の明細）
ALTER TABLE payrollMonths ADD COLUMN taxColumn TEXT NOT NULL DEFAULT '';
ALTER TABLE payrollMonths ADD COLUMN dependents INTEGER NOT NULL DEFAULT 0;
