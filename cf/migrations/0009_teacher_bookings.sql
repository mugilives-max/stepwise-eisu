-- Additive confirmation receipts for teacher-booked lessons.
CREATE TABLE teacherBookings (
 slotId TEXT PRIMARY KEY,
 studentId TEXT NOT NULL DEFAULT '',
 requestId TEXT NOT NULL DEFAULT '',
 snapshotJson TEXT NOT NULL DEFAULT '',
 createdAt TEXT NOT NULL DEFAULT '',
 response TEXT NOT NULL DEFAULT '',
 responseSnapshotJson TEXT NOT NULL DEFAULT '',
 responseNote TEXT NOT NULL DEFAULT '',
 respondedBy TEXT NOT NULL DEFAULT '',
 updatedAt TEXT NOT NULL DEFAULT '',
 _syncedAt TEXT NOT NULL DEFAULT '',
 _sheetRow INTEGER
);
