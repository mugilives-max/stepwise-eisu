-- 4段目: 授業記録・宿題・引き継ぎメモ。docs/REBUILD_DESIGN.md 3-3
-- 授業記録は1授業に1つ。下書きを直しても、生徒・保護者に見せるのは公開した版（publishedJson）だけ。
CREATE TABLE lessonRecords (
  id TEXT PRIMARY KEY,
  lessonId TEXT NOT NULL REFERENCES lessons(id),
  studentId TEXT NOT NULL,
  authorId TEXT NOT NULL DEFAULT '',          -- 書いたスタッフ
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'void')),
  range TEXT NOT NULL DEFAULT '',             -- 扱った範囲（公開）
  comment TEXT NOT NULL DEFAULT '',           -- コメント（公開）
  parentMessage TEXT NOT NULL DEFAULT '',     -- 保護者への連絡（公開）
  staffNotes TEXT NOT NULL DEFAULT '{}',      -- 講師用（公開しない）: 予定単元・理解度・進度・前回の宿題の取り組み・正答率・次回の焦点・メモ
  planUnitId TEXT NOT NULL DEFAULT '',        -- 計画の内訳のどこに当たるか（5段目）
  publishedJson TEXT NOT NULL DEFAULT '',     -- 公開した版（range・comment・parentMessage・宿題）
  publishedAt TEXT NOT NULL DEFAULT '',
  voidReason TEXT NOT NULL DEFAULT '',
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX lessonRecords_lesson ON lessonRecords(lessonId);
CREATE INDEX lessonRecords_student ON lessonRecords(studentId, status);

-- 宿題・持ち物。授業記録を公開すると生徒・保護者に見える。
-- status: open（未完了）/ reported（生徒・保護者が「できた」）/ confirmed（スタッフが確認）/ withdrawn（取り下げ）
-- やり直しはスタッフが open に戻し、reviewNote に一言を残す
CREATE TABLE homework (
  id TEXT PRIMARY KEY,
  recordId TEXT NOT NULL DEFAULT '',
  studentId TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'homework' CHECK (kind IN ('homework', 'item')),
  title TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT '',
  dueMode TEXT NOT NULL DEFAULT 'nextLesson' CHECK (dueMode IN ('date', 'nextLesson', 'none')),
  dueDate TEXT NOT NULL DEFAULT '',
  dueSubject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reported', 'confirmed', 'withdrawn')),
  reportedAt TEXT NOT NULL DEFAULT '',
  reportedBy TEXT NOT NULL DEFAULT '',
  reviewedAt TEXT NOT NULL DEFAULT '',
  reviewNote TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX homework_student ON homework(studentId, status);
CREATE INDEX homework_record ON homework(recordId);

-- 引き継ぎメモ（次にその生徒を担当する講師・代講への伝言）。toStaffId が空 = その生徒を担当する全員
CREATE TABLE handoverNotes (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL,
  authorId TEXT NOT NULL,
  toStaffId TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX handoverNotes_student ON handoverNotes(studentId, status);
CREATE TABLE handoverReads (
  noteId TEXT NOT NULL REFERENCES handoverNotes(id),
  staffId TEXT NOT NULL,
  readAt TEXT NOT NULL,
  PRIMARY KEY (noteId, staffId)
);
