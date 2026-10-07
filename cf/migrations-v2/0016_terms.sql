-- 受講規約の版と同意の記録（統合3 D07: 規約の版・対象・承認者・日時・経路を残す）。
-- 今の版は settings（termsVersion・termsTitle・termsUrl・termsFrom・termsNote）。家族の同意は families.termsVersion / termsAcceptedAt（1段目から）に加え、履歴をここに残す。
CREATE TABLE termsConsents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  familyId TEXT NOT NULL REFERENCES families(id),
  version TEXT NOT NULL,
  acceptedAt TEXT NOT NULL,                  -- 同意した日時（保護者ページなら操作の時刻、書面なら記録した日）
  via TEXT NOT NULL DEFAULT '',              -- 保護者ページ / 書面 / LINE など
  actorKind TEXT NOT NULL,                   -- family（本人が保護者ページで）/ staff（教室管理者が記録）
  actorId TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX termsConsents_family ON termsConsents(familyId, id);
-- 計画の承認のときに、どの版の規約のもとで承認したか
ALTER TABLE planLines ADD COLUMN termsVersion TEXT NOT NULL DEFAULT '';
