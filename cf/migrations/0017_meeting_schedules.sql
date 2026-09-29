CREATE TABLE meetingSchedules (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '',
  min TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL DEFAULT '',
  deliveryMode TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  eventId TEXT NOT NULL DEFAULT '',
  meetUrl TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX meetingSchedules_date ON meetingSchedules(date);
