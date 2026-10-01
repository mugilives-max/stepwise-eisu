-- 作り直し（v2）の土台。docs/REBUILD_DESIGN.md
-- 今の台帳（DB）とは別のデータベース（DB2）。家族が根っこ、スタッフは役割の組み合わせ。
-- すべての表に createdAt / updatedAt（ISO 文字列）と、書き換えのたびに 1 増える version を持つ。

-- 家族（契約者）。保護者のログインは家族に 1 つ（両親で共有）
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',            -- 表示名（例: 山田家）
  email TEXT NOT NULL DEFAULT '',           -- ログインと連絡のメール（小文字）
  passSalt TEXT NOT NULL DEFAULT '',
  passHash TEXT NOT NULL DEFAULT '',        -- pbkdf2-sha256$<回数>$<hex>
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'stopped')),
  failCount INTEGER NOT NULL DEFAULT 0,
  lockUntil TEXT NOT NULL DEFAULT '',
  termsVersion TEXT NOT NULL DEFAULT '',    -- 同意した規約の版
  termsAcceptedAt TEXT NOT NULL DEFAULT '',
  mailPrefs TEXT NOT NULL DEFAULT '{}',     -- メール通知の種類ごとのオン・オフ
  testOnly INTEGER NOT NULL DEFAULT 0,      -- 1 = テスト用（メールを実際には送らない）
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX families_email ON families(email) WHERE email <> '';

-- 生徒。必ず 1 つの家族に属する
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES families(id),
  familyName TEXT NOT NULL DEFAULT '',
  givenName TEXT NOT NULL DEFAULT '',
  familyKana TEXT NOT NULL DEFAULT '',
  givenKana TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  linkCode TEXT NOT NULL,                    -- 生徒の専用リンクの鍵（?k=）
  baseRate30 INTEGER NOT NULL DEFAULT 0,     -- 基本単価（30分あたり）。計画の初期値と規約の既定の授業料
  deliveryMode TEXT NOT NULL DEFAULT '' CHECK (deliveryMode IN ('', 'in_person', 'online')),
  status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'paused', 'left')),
  permissions TEXT NOT NULL DEFAULT '{}',    -- 生徒本人に許す操作（保護者が決める）
  note TEXT NOT NULL DEFAULT '',
  testOnly INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX students_link ON students(linkCode);
CREATE INDEX students_family ON students(familyId);

-- スタッフ。roles は teacher（講師）・manager（教室管理者）・sysadmin（システム管理者）の組み合わせ（カンマ区切り）
CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  passSalt TEXT NOT NULL DEFAULT '',
  passHash TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'stopped')),
  failCount INTEGER NOT NULL DEFAULT 0,
  lockUntil TEXT NOT NULL DEFAULT '',
  contractType TEXT NOT NULL DEFAULT 'contractor' CHECK (contractType IN ('owner', 'contractor')),
  withholding INTEGER NOT NULL DEFAULT 0,    -- 報酬から源泉徴収するか（業務委託の確認後に決める）
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staff_email ON staff(email);

-- 講師の時給の履歴。startsOn（YYYY-MM-01）の月から使う。過去の明細は変えない
CREATE TABLE staffRates (
  id TEXT PRIMARY KEY,
  staffId TEXT NOT NULL REFERENCES staff(id),
  startsOn TEXT NOT NULL,
  lessonHourly INTEGER NOT NULL DEFAULT 0,
  meetingHourly INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staffRates_month ON staffRates(staffId, startsOn);

-- ログイン（端末ごと）。トークンそのものは持たず、SHA-256 だけを持つ
CREATE TABLE sessions (
  tokenHash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('staff', 'family')),
  subjectId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  userAgent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_subject ON sessions(kind, subjectId);

-- 招待・パスワード再設定のリンク。トークンそのものは持たない。使ったら usedAt
CREATE TABLE authChallenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('staffInvite', 'staffReset', 'familyInvite', 'familyReset')),
  subjectId TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  tokenHash TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  usedAt TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX authChallenges_token ON authChallenges(tokenHash);
CREATE INDEX authChallenges_subject ON authChallenges(purpose, subjectId, createdAt);

-- メール・カレンダーの控え。台帳を書いたあとに Apps Script へ頼む（今の _effects と同じ形）
CREATE TABLE effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'dismissed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  sentAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX effects_status ON effects(status, id);

-- 誰がいつ何をしたか。追記だけ
CREATE TABLE auditLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actorKind TEXT NOT NULL,                   -- staff / family / student / system
  actorId TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX auditLog_at ON auditLog(at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
