-- 承認待ちの授業計画に「承認のお願い」を送った時刻（同じ日に何度も送らないように）
ALTER TABLE planLines ADD COLUMN remindedAt TEXT NOT NULL DEFAULT '';
