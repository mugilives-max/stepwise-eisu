-- スタッフが保護者ページ・生徒ページを、その人の目で見る（プレビュー）。表示だけで、書き込みはすべて断る（cf/v2/preview.mjs）
-- 鍵（pv2.…）は1時間。鍵そのものは持たず、ハッシュだけ
CREATE TABLE previewSessions (
  tokenHash TEXT PRIMARY KEY,
  staffId TEXT NOT NULL REFERENCES staff(id),
  kind TEXT NOT NULL CHECK (kind IN ('family', 'student')),
  subjectId TEXT NOT NULL,                       -- 家族か生徒の id
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX previewSessions_expires ON previewSessions(expiresAt);
