-- 3段目: 予定。授業は行を消さずに状態で表す。docs/REBUILD_DESIGN.md 3-2、docs/SCHEDULING_FLOW_DESIGN.md

-- 授業の種類（通常・演習・講習など）。標準の時間と料金は計画の初期値（5段目で使う）
CREATE TABLE lessonKinds (
  name TEXT PRIMARY KEY,
  standardMinutes INTEGER NOT NULL DEFAULT 0,
  standardFee INTEGER NOT NULL DEFAULT 0,        -- 1回の標準料金（円）。0 = 生徒の基本単価で計算
  active INTEGER NOT NULL DEFAULT 1,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

-- 授業。status:
--   held      未送信（予定表にまとめていて、まだ送っていない。生徒・保護者には見せない）
--   proposed  仮予定（confirmBy の日まで。過ぎたら毎日0時10分に decided へ。空なら自動では決定しない）
--   decided   決定
--   done      実施済み
--   rested    お休み（前日23時までの連絡。料金なし）
--   cancelled キャンセル（前日23時を過ぎた連絡・連絡のない欠席。キャンセル料は5段目で決める）
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL REFERENCES students(id),
  staffId TEXT NOT NULL DEFAULT '',              -- 担当の講師。空 = まだ決めていない
  date TEXT NOT NULL,                            -- YYYY-MM-DD（日本時間）
  start TEXT NOT NULL,                           -- HH:MM
  minutes INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '通常',
  deliveryMode TEXT NOT NULL DEFAULT 'in_person' CHECK (deliveryMode IN ('in_person', 'online')),
  status TEXT NOT NULL CHECK (status IN ('held', 'proposed', 'decided', 'done', 'rested', 'cancelled')),
  confirmBy TEXT NOT NULL DEFAULT '',            -- 仮予定の締め切り（YYYY-MM-DD）
  decidedAt TEXT NOT NULL DEFAULT '',
  decidedBy TEXT NOT NULL DEFAULT '',            -- staff:<id> / system:auto / student / family
  calendarEventId TEXT NOT NULL DEFAULT '',      -- Google カレンダーの予定（作る前は仮の目印）
  meetUrl TEXT NOT NULL DEFAULT '',
  lateStart INTEGER NOT NULL DEFAULT 0,          -- 当日の開始時刻の変更として記録した（料金は変えない）
  note TEXT NOT NULL DEFAULT '',                 -- スタッフだけが見るメモ
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX lessons_date ON lessons(date, start);
CREATE INDEX lessons_student ON lessons(studentId, date);
CREATE INDEX lessons_staff ON lessons(staffId, date);
CREATE INDEX lessons_confirm ON lessons(status, confirmBy);

-- 生徒・保護者からの連絡（変更・お休みの連絡）。kind:
--   move   日時の変更のお願い（仮予定・決定〜前日23時）
--   rest   お休み（前日23時まで。受け付けた時点で授業は rested）
--   late   開始を遅らせたい（前日23時〜開始前）
--   cancel キャンセル（前日23時〜。受け付けた時点で授業は cancelled。キャンセル料は5段目）
-- status: open（スタッフの対応待ち）/ done（対応済み）/ withdrawn（本人が取り下げ）
CREATE TABLE lessonRequests (
  id TEXT PRIMARY KEY,
  lessonId TEXT NOT NULL REFERENCES lessons(id),
  studentId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'rest', 'late', 'cancel')),
  note TEXT NOT NULL DEFAULT '',
  fromKind TEXT NOT NULL CHECK (fromKind IN ('student', 'family', 'staff')),
  fromId TEXT NOT NULL DEFAULT '',
  receivedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'withdrawn')),
  resolvedAt TEXT NOT NULL DEFAULT '',
  resolvedBy TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX lessonRequests_lesson ON lessonRequests(lessonId);
CREATE INDEX lessonRequests_open ON lessonRequests(status, receivedAt);

-- 生徒・保護者が共有する予定。kind: test（テスト）/ event（行事）/ unavailable（授業ができない日）
CREATE TABLE sharedEvents (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL REFERENCES students(id),
  kind TEXT NOT NULL CHECK (kind IN ('test', 'event', 'unavailable')),
  date TEXT NOT NULL,
  dateTo TEXT NOT NULL,
  start TEXT NOT NULL DEFAULT '',                -- 空 = 終日
  end TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  createdByKind TEXT NOT NULL DEFAULT 'staff',
  createdById TEXT NOT NULL DEFAULT '',
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX sharedEvents_student ON sharedEvents(studentId, date);

-- 講師の休み（授業できない日時）。staffId が空 = 教室全体の休み
CREATE TABLE staffUnavailability (
  id TEXT PRIMARY KEY,
  staffId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start TEXT NOT NULL DEFAULT '',
  end TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX staffUnavailability_date ON staffUnavailability(date);

-- 面談（保護者・生徒と）。担当の講師の報酬（面談の時給）にも数える（7段目）
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES families(id),
  studentId TEXT NOT NULL DEFAULT '',
  staffId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  deliveryMode TEXT NOT NULL DEFAULT 'in_person' CHECK (deliveryMode IN ('in_person', 'online')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  title TEXT NOT NULL DEFAULT '',
  calendarEventId TEXT NOT NULL DEFAULT '',
  meetUrl TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX meetings_date ON meetings(date);
