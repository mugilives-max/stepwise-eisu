-- Additive; no row means existing operations remain allowed.
CREATE TABLE studentPermissions (
 studentId TEXT PRIMARY KEY,
 booking TEXT NOT NULL DEFAULT '1',
 reschedule TEXT NOT NULL DEFAULT '1',
 request TEXT NOT NULL DEFAULT '1',
 availability TEXT NOT NULL DEFAULT '1',
 events TEXT NOT NULL DEFAULT '1',
 email TEXT NOT NULL DEFAULT '1',
 revision TEXT NOT NULL DEFAULT '0',
 _syncedAt TEXT NOT NULL DEFAULT '',
 _sheetRow INTEGER
);
