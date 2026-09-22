-- Additive only: existing records, plan approval and billing remain unchanged.
CREATE TABLE planOutlines (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  itemsJson TEXT NOT NULL DEFAULT '',
  publishedJson TEXT NOT NULL DEFAULT '',
  publishedRevision INTEGER NOT NULL DEFAULT 0,
  publishedAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  lastRequestId TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE TABLE lessonOutlineLinks (
  recordId TEXT PRIMARY KEY,
  studentId TEXT NOT NULL,
  slotId TEXT NOT NULL,
  lineId TEXT NOT NULL DEFAULT '',
  itemId TEXT NOT NULL DEFAULT '',
  sourceRevision INTEGER NOT NULL DEFAULT 0,
  teacherJson TEXT NOT NULL DEFAULT '',
  publicJson TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE TABLE lessonOutlineSnapshots (
  id TEXT PRIMARY KEY,
  recordId TEXT NOT NULL,
  studentId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  bodyJson TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
