-- Additive profile fields, no existing account data is modified.
CREATE TABLE familyProfiles (
 id TEXT PRIMARY KEY,
 familyName TEXT NOT NULL DEFAULT '',
 givenName TEXT NOT NULL DEFAULT '',
 _syncedAt TEXT NOT NULL DEFAULT '',
 _sheetRow INTEGER
);
