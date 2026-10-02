-- 6段目: 成績（1から作り直す。今の仕組みの成績は写さない）。docs/REQUIREMENTS.md 5-2
-- 定期テストと模試を1つの形で持つ。科目ごとの行と、試験全体の合計・順位・偏差値・志望校判定。

-- 試験。kind: regular（定期テスト）/ mock（模試）。status: recorded（記録）/ skipped（「結果なし」にしたテストの予定）
-- eventId は、生徒・保護者が共有したテストの予定（sharedEvents）から作ったとき
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL REFERENCES students(id),
  kind TEXT NOT NULL CHECK (kind IN ('regular', 'mock')),
  name TEXT NOT NULL,                            -- 例: 2学期中間テスト、第2回 全県模試
  date TEXT NOT NULL,                            -- 実施日（YYYY-MM-DD）
  grade TEXT NOT NULL DEFAULT '',                -- そのときの学年
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'skipped')),
  eventId TEXT NOT NULL DEFAULT '',
  totalScore REAL,                               -- 全体（空なら科目の合計を見せる）
  totalMax REAL,
  totalRank INTEGER,
  totalRankOf INTEGER,                           -- 順位の母数（◯人中）
  totalDeviation REAL,
  judgments TEXT NOT NULL DEFAULT '[]',          -- 模試の志望校判定 [{ school, result }]。講師には見せない
  createdBy TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX exams_student ON exams(studentId, date);
CREATE INDEX exams_event ON exams(eventId);

-- 科目ごと。ある項目だけ入れる（定期テストは平均点・順位、模試は偏差値など）
CREATE TABLE examScores (
  id TEXT PRIMARY KEY,
  examId TEXT NOT NULL REFERENCES exams(id),
  subject TEXT NOT NULL,
  score REAL,
  max REAL,
  average REAL,
  rank INTEGER,
  rankOf INTEGER,
  deviation REAL,
  enteredBy TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX examScores_subject ON examScores(examId, subject);

-- 振り返り（試験に1つ）。良かった点・課題・次の対策
CREATE TABLE examReviews (
  examId TEXT PRIMARY KEY REFERENCES exams(id),
  good TEXT NOT NULL DEFAULT '',
  issues TEXT NOT NULL DEFAULT '',
  nextSteps TEXT NOT NULL DEFAULT '',
  updatedBy TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- 成績票（写真・PDF）。生徒・保護者・スタッフが送る。中身は examFileChunks に分けて持つ（1つの行が大きくなりすぎないように）
-- status: uploading（送っている途中）/ new（取り込み待ち）/ imported（点数を取り込んだ）/ dismissed（取り込まない）
CREATE TABLE examFiles (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL REFERENCES students(id),
  examId TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',                 -- 送った人の一言（例: 2学期中間の個票）
  uploadedByKind TEXT NOT NULL CHECK (uploadedByKind IN ('student', 'family', 'staff')),
  uploadedById TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'new', 'imported', 'dismissed')),
  resolvedBy TEXT NOT NULL DEFAULT '',
  resolvedAt TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX examFiles_student ON examFiles(studentId, createdAt);
CREATE INDEX examFiles_status ON examFiles(status);
CREATE TABLE examFileChunks (
  fileId TEXT NOT NULL REFERENCES examFiles(id),
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,                            -- base64
  PRIMARY KEY (fileId, idx)
);
