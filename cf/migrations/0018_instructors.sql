-- 講師アカウント（雇用する講師）と授業の担当講師。gas/Instructors.gs
CREATE TABLE instructors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  passSalt TEXT NOT NULL DEFAULT '',
  passHash TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  lastLogin TEXT NOT NULL DEFAULT '',
  failCount TEXT NOT NULL DEFAULT '',
  lockUntil TEXT NOT NULL DEFAULT '',
  tokenHash TEXT NOT NULL DEFAULT '',
  tokenExpiresAt TEXT NOT NULL DEFAULT '',
  securityVersion TEXT NOT NULL DEFAULT '',
  inviteHash TEXT NOT NULL DEFAULT '',
  inviteExpiresAt TEXT NOT NULL DEFAULT '',
  inviteFailCount TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE UNIQUE INDEX instructors_email ON instructors(email) WHERE email <> '';
-- 空 = 先生本人
ALTER TABLE slots ADD COLUMN instructorId TEXT NOT NULL DEFAULT '';
CREATE INDEX slots_instructor_date ON slots(instructorId, date);
