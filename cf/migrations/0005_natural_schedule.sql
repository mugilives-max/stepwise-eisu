-- Request counts only. User text and Claude responses are never stored.
CREATE TABLE _nl_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX _nl_usage_scope_created ON _nl_usage (scope, createdAt);
