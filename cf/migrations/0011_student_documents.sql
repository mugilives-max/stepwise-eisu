-- Private document metadata; file bytes remain in the owner-only Drive folder.
CREATE TABLE IF NOT EXISTS _studentDocuments (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL,
  name TEXT NOT NULL,
  fileId TEXT NOT NULL,
  fileHash TEXT NOT NULL,
  size INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  removedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS student_documents_owner ON _studentDocuments(studentId, removedAt);
