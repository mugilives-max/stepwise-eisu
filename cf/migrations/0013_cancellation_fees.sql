CREATE TABLE cancellationFees (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL DEFAULT '',
  slotId TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  decisionJson TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX cancellationFees_student ON cancellationFees (studentId);
