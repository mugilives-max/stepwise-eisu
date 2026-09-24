-- Additive name parts; existing full names remain unchanged.
CREATE TABLE studentNames (
  id TEXT PRIMARY KEY,
  familyName TEXT NOT NULL DEFAULT '',
  givenName TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
