-- ステップワイズ D1 初期スキーマ（GAS + スプレッドシート台帳からの移行、段階 A）。
--
-- 方針
--  * 表名・列名はシートの見出しをそのまま使う。GAS の readRows_ / ledgerRows_ が返す
--    オブジェクトのキーと 1 対 1 になるので、移行中の突合（並走テスト）が機械的にできる。
--    塾管理台帳の 5 シートは日本語のままにしてある（同じ理由）。
--  * 日付は TEXT 'YYYY-MM-DD'、時刻は TEXT 'HH:MM'、年月は TEXT 'YYYY-MM'。
--  * 真偽は INTEGER 0/1 に寄せる。シート側は TRUE/FALSE・'true'/'false'・'1'/'0' の
--    3 通りが混在しているので、取り込み時に正規化する（scripts/ledger-to-d1.mjs）。
--  * 金額・分数・回数は INTEGER（円・分・回）。
--  * 数値列はすべて NULL 可にしてある。台帳には「空欄」のセルがあり、GAS 側に
--    `rate30 !== ''` のような判定が残っているので、0 と空欄を潰すと分岐が変わる。
--    空欄は NULL で持ち、シートの形に戻すとき '' にする（cf/lib/sheet-view.mjs）。
--    GAS を引退させたあとに NOT NULL へ締め直してよい。
--  * どの表にも取り込み用の _syncedAt（最後に台帳から入れた時刻）と _sheetRow
--    （シート上の行番号。突合と部分更新に使う）を足す。業務列の updatedAt とは別物。
--
-- 外部キーは宣言しない。台帳には参照先が消えた行（取消済みの授業など）が残ることがあり、
-- 取り込みで落とすと突合できなくなるため。整合は取り込み後の検査で報告する。

/* ================= 生徒・設定 ================= */

CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);

CREATE TABLE students (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  active       INTEGER,
  email        TEXT NOT NULL DEFAULT '',
  code         TEXT NOT NULL DEFAULT '',   -- 生徒の専用リンクの鍵。応答に出さない
  rate30       INTEGER, -- 30分あたりの円
  monthly      INTEGER, -- 旧・定額月謝（証跡として保持）
  parentToken  TEXT NOT NULL DEFAULT '',   -- 旧保護者認証の名残。現在は未使用
  parentExp    INTEGER,
  deliveryMode TEXT NOT NULL DEFAULT '',   -- '' | in_person | online
  _syncedAt    TEXT NOT NULL DEFAULT '',
  _sheetRow    INTEGER
);
CREATE INDEX students_active ON students (active, name);

CREATE TABLE lessonKinds (
  name         TEXT PRIMARY KEY,           -- slots.kind / plans.kind / planLines.kind から名前で参照される
  standardMin  INTEGER,                    -- 未設定は NULL（0 と区別する）
  standardFee  INTEGER,
  active       INTEGER,
  sortOrder    INTEGER,
  updatedAt    TEXT NOT NULL DEFAULT '',
  _syncedAt    TEXT NOT NULL DEFAULT '',
  _sheetRow    INTEGER
);

/* ================= 予定 ================= */

CREATE TABLE slots (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL DEFAULT '',
  start        TEXT NOT NULL DEFAULT '',
  min          INTEGER,
  status       TEXT NOT NULL DEFAULT '',   -- open | offered | booked
  studentId    TEXT NOT NULL DEFAULT '',
  done         INTEGER, -- 実施済み。請求の対象になる
  eventId      TEXT NOT NULL DEFAULT '',
  meetUrl      TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  req          TEXT NOT NULL DEFAULT '',   -- 取消依頼の JSON。'' は依頼なし
  deliveryMode TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT '',   -- '' は「通常」
  _syncedAt    TEXT NOT NULL DEFAULT '',
  _sheetRow    INTEGER
);
CREATE INDEX slots_student_date ON slots (studentId, date);
CREATE INDEX slots_date ON slots (date, start);
CREATE INDEX slots_status ON slots (status, date);

CREATE TABLE blocked (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  start      TEXT NOT NULL DEFAULT '',     -- '' は終日
  end        TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX blocked_student_date ON blocked (studentId, date);

CREATE TABLE teacherOff (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',     -- 生徒には出さない
  start      TEXT NOT NULL DEFAULT '',
  end        TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX teacherOff_date ON teacherOff (date);

CREATE TABLE wishes (
  id           TEXT PRIMARY KEY,
  studentId    TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL DEFAULT '',
  start        TEXT NOT NULL DEFAULT '',
  end          TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT '',   -- want（その時間）| それ以外は ok（範囲内ならどこでも）
  deliveryMode TEXT NOT NULL DEFAULT '',
  duration     INTEGER,
  availability TEXT NOT NULL DEFAULT '',   -- 申請時に生徒へ見せた空き状況
  _syncedAt    TEXT NOT NULL DEFAULT '',
  _sheetRow    INTEGER
);
CREATE INDEX wishes_student_date ON wishes (studentId, date);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL DEFAULT '',
  dateTo     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT '',     -- event | test
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX events_student_dateTo ON events (studentId, dateTo);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  studentId      TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT '', -- 宿題 | 持ち物 | メモ
  title          TEXT NOT NULL DEFAULT '',
  due            TEXT NOT NULL DEFAULT '',
  createdAt      TEXT NOT NULL DEFAULT '',
  createdBy      TEXT NOT NULL DEFAULT '', -- student | teacher
  doneAt         TEXT NOT NULL DEFAULT '', -- '' は未完了
  sourceRecordId TEXT NOT NULL DEFAULT '',
  sourceItemId   TEXT NOT NULL DEFAULT '',
  sourceRevision INTEGER,
  withdrawnAt    TEXT NOT NULL DEFAULT '', -- 取り下げ（履歴は残す）
  dueMode        TEXT NOT NULL DEFAULT '', -- date | nextLesson | none
  dueSubject     TEXT NOT NULL DEFAULT '',
  dueAfter       TEXT NOT NULL DEFAULT '', -- 'YYYY-MM-DDTHH:MM'（日本時間、ゾーン無し）
  dueTime        TEXT NOT NULL DEFAULT '',
  _syncedAt      TEXT NOT NULL DEFAULT '',
  _sheetRow      INTEGER
);
CREATE INDEX tasks_student_due ON tasks (studentId, due);
CREATE INDEX tasks_source ON tasks (sourceRecordId);

/* ================= 授業計画（旧 plans と現行 planLines） ================= */

CREATE TABLE plans (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',
  ym         TEXT NOT NULL DEFAULT '',     -- 'YYYY-MM' か 'default'
  subject    TEXT NOT NULL DEFAULT '',
  count      INTEGER,
  status     TEXT NOT NULL DEFAULT '',     -- draft | proposed | approved | declined（'' は draft）
  proposedAt TEXT NOT NULL DEFAULT '',
  approvedAt TEXT NOT NULL DEFAULT '',
  approvedVia TEXT NOT NULL DEFAULT '',
  memo       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX plans_student_ym ON plans (studentId, ym);

CREATE TABLE planComments (
  studentId  TEXT NOT NULL,
  ym         TEXT NOT NULL,
  comment    TEXT NOT NULL DEFAULT '',
  updatedAt  TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER,
  PRIMARY KEY (studentId, ym)
);

CREATE TABLE planLines (
  id            TEXT PRIMARY KEY,
  studentId     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT '',
  count         INTEGER,
  startDate     TEXT NOT NULL DEFAULT '',
  endDate       TEXT NOT NULL DEFAULT '',
  lessonMin     INTEGER,
  rate30        INTEGER,
  comment       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',  -- draft | proposed | approved | declined
  revision      INTEGER,
  proposedAt    TEXT NOT NULL DEFAULT '',
  approvedAt    TEXT NOT NULL DEFAULT '',
  approvedVia   TEXT NOT NULL DEFAULT '',  -- '保護者ページ' なら保護者本人の承認。それ以外は先生の記録
  consentDate   TEXT NOT NULL DEFAULT '',
  memo          TEXT NOT NULL DEFAULT '',
  approvedCount INTEGER,                   -- NULL は未設定（0 と区別する）
  createdAt     TEXT NOT NULL DEFAULT '',
  updatedAt     TEXT NOT NULL DEFAULT '',
  parentId      TEXT NOT NULL DEFAULT '',
  parentAck     TEXT NOT NULL DEFAULT '',  -- '' | confirmed | inquiry
  parentAckAt   TEXT NOT NULL DEFAULT '',
  parentAckMemo TEXT NOT NULL DEFAULT '',
  _syncedAt     TEXT NOT NULL DEFAULT '',
  _sheetRow     INTEGER
);
CREATE INDEX planLines_student_status ON planLines (studentId, status);
CREATE INDEX planLines_student_span ON planLines (studentId, startDate, endDate);

/* ================= 請求・承認 ================= */

CREATE TABLE monthAgreements (
  id               TEXT PRIMARY KEY,
  studentId        TEXT NOT NULL DEFAULT '',
  ym               TEXT NOT NULL DEFAULT '',
  revision         INTEGER,
  status           TEXT NOT NULL DEFAULT '',
  planJson         TEXT NOT NULL DEFAULT '',
  rate30           INTEGER,
  monthly          INTEGER,
  proposedAt       TEXT NOT NULL DEFAULT '',
  approvedAt       TEXT NOT NULL DEFAULT '',
  approvedVia      TEXT NOT NULL DEFAULT '',
  consentDate      TEXT NOT NULL DEFAULT '',
  memo             TEXT NOT NULL DEFAULT '',
  updatedAt        TEXT NOT NULL DEFAULT '',
  lessonMin        INTEGER,
  approvedPlanJson TEXT NOT NULL DEFAULT '',
  _syncedAt        TEXT NOT NULL DEFAULT '',
  _sheetRow        INTEGER
);
CREATE INDEX monthAgreements_student_ym ON monthAgreements (studentId, ym);

-- 追記専用の監査記録。id は lineId:revision:event なので再送しても増えない
CREATE TABLE approvalEvents (
  id           TEXT PRIMARY KEY,
  studentId    TEXT NOT NULL DEFAULT '',
  ym           TEXT NOT NULL DEFAULT '',   -- 月契約は 'YYYY-MM'、計画行は '開始~終了'
  revision     INTEGER,
  event        TEXT NOT NULL DEFAULT '',
  recordedAt   TEXT NOT NULL DEFAULT '',
  consentDate  TEXT NOT NULL DEFAULT '',
  via          TEXT NOT NULL DEFAULT '',
  memo         TEXT NOT NULL DEFAULT '',
  snapshotJson TEXT NOT NULL DEFAULT '',
  _syncedAt    TEXT NOT NULL DEFAULT '',
  _sheetRow    INTEGER
);
CREATE INDEX approvalEvents_student ON approvalEvents (studentId, recordedAt);

/* ================= 案内・確定・取消の記録 ================= */

CREATE TABLE acceptWrites (
  id                TEXT PRIMARY KEY,
  studentId         TEXT NOT NULL DEFAULT '',
  requestId         TEXT NOT NULL DEFAULT '',
  slotsJson         TEXT NOT NULL DEFAULT '',
  completedJson     TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT '', -- pending | done
  notificationState TEXT NOT NULL DEFAULT '',
  createdAt         TEXT NOT NULL DEFAULT '',
  updatedAt         TEXT NOT NULL DEFAULT '',
  lastError         TEXT NOT NULL DEFAULT '',
  _syncedAt         TEXT NOT NULL DEFAULT '',
  _sheetRow         INTEGER
);
CREATE UNIQUE INDEX acceptWrites_requestId ON acceptWrites (requestId);

CREATE TABLE offerEdits (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',
  slotId     TEXT NOT NULL DEFAULT '',
  requestId  TEXT NOT NULL DEFAULT '',
  beforeJson TEXT NOT NULL DEFAULT '',
  afterJson  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',     -- done でない行は移動先の時間を予約している
  createdAt  TEXT NOT NULL DEFAULT '',
  updatedAt  TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE UNIQUE INDEX offerEdits_requestId ON offerEdits (requestId);
CREATE INDEX offerEdits_slot ON offerEdits (slotId);

CREATE TABLE slotChangeNotices (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',
  slotId     TEXT NOT NULL DEFAULT '',     -- 授業の行が消えた後も残る（この表の目的）
  operation  TEXT NOT NULL DEFAULT '',     -- resolveCancel | cancelDeclined
  beforeJson TEXT NOT NULL DEFAULT '',
  afterJson  TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL DEFAULT '',
  updatedAt  TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX slotChangeNotices_slot ON slotChangeNotices (slotId);

/* ================= 授業記録 ================= */

CREATE TABLE lessonRecords (
  id              TEXT PRIMARY KEY,
  studentId       TEXT NOT NULL DEFAULT '',
  slotId          TEXT NOT NULL DEFAULT '',
  lessonDate      TEXT NOT NULL DEFAULT '',
  lessonStart     TEXT NOT NULL DEFAULT '',
  lessonMin       INTEGER,
  subject         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  progress        TEXT NOT NULL DEFAULT '',
  nextFocus       TEXT NOT NULL DEFAULT '',
  homeworkJson    TEXT NOT NULL DEFAULT '',
  revision        INTEGER,
  status          TEXT NOT NULL DEFAULT '', -- active | void
  createdBy       TEXT NOT NULL DEFAULT '',
  updatedBy       TEXT NOT NULL DEFAULT '',
  createdAt       TEXT NOT NULL DEFAULT '',
  updatedAt       TEXT NOT NULL DEFAULT '',
  voidReason      TEXT NOT NULL DEFAULT '',
  lastRequestId   TEXT NOT NULL DEFAULT '',
  lastRequestHash TEXT NOT NULL DEFAULT '',
  reportJson      TEXT NOT NULL DEFAULT '',
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE INDEX lessonRecords_slot ON lessonRecords (slotId);
CREATE INDEX lessonRecords_student_date ON lessonRecords (studentId, lessonDate);

CREATE TABLE lessonPreparations (
  id          TEXT PRIMARY KEY,
  slotId      TEXT NOT NULL DEFAULT '',
  studentId   TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',     -- 先生だけが見る
  revision    INTEGER,
  updatedAt   TEXT NOT NULL DEFAULT '',
  lessonDate  TEXT NOT NULL DEFAULT '',
  lessonStart TEXT NOT NULL DEFAULT '',
  lessonMin   INTEGER,
  subject     TEXT NOT NULL DEFAULT '',
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);
CREATE INDEX lessonPreparations_slot ON lessonPreparations (slotId);

CREATE TABLE lessonPrivateNotes (
  recordId    TEXT PRIMARY KEY,
  teacherNote TEXT NOT NULL DEFAULT '',     -- どの経路でも公開しない
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);

CREATE TABLE lessonReportDrafts (
  recordId       TEXT PRIMARY KEY,
  body           TEXT NOT NULL DEFAULT '',
  sourceRevision INTEGER,
  revision       INTEGER,
  updatedAt      TEXT NOT NULL DEFAULT '',
  _syncedAt      TEXT NOT NULL DEFAULT '',
  _sheetRow      INTEGER
);

CREATE TABLE lessonWrites (
  requestId   TEXT PRIMARY KEY,
  operation   TEXT NOT NULL DEFAULT '',
  payloadHash TEXT NOT NULL DEFAULT '',
  payloadJson TEXT NOT NULL DEFAULT '',     -- 先生の私的メモを含む。公開しない
  status      TEXT NOT NULL DEFAULT '',     -- pending | applied | failed
  resultJson  TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL DEFAULT '',
  updatedAt   TEXT NOT NULL DEFAULT '',
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);

-- 生徒・保護者に見せてよい唯一の授業内容。sourceRequestId の記録が applied のときだけ見せる
CREATE TABLE lessonPublicSnapshots (
  id              TEXT PRIMARY KEY,         -- recordId:revision
  recordId        TEXT NOT NULL DEFAULT '',
  studentId       TEXT NOT NULL DEFAULT '',
  slotId          TEXT NOT NULL DEFAULT '',
  revision        INTEGER,
  lessonDate      TEXT NOT NULL DEFAULT '',
  lessonStart     TEXT NOT NULL DEFAULT '',
  lessonMin       INTEGER,
  subject         TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  progress        TEXT NOT NULL DEFAULT '',
  nextFocus       TEXT NOT NULL DEFAULT '',
  homeworkJson    TEXT NOT NULL DEFAULT '',
  publishedAt     TEXT NOT NULL DEFAULT '',
  sourceRequestId TEXT NOT NULL DEFAULT '',
  reportJson      TEXT NOT NULL DEFAULT '',
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE INDEX lessonPublicSnapshots_record ON lessonPublicSnapshots (recordId, revision);
CREATE INDEX lessonPublicSnapshots_student ON lessonPublicSnapshots (studentId, lessonDate);

CREATE TABLE lessonReadReceipts (
  id        TEXT PRIMARY KEY,               -- JSON.stringify([readerId, studentId, recordId])
  studentId TEXT NOT NULL DEFAULT '',
  readerId  TEXT NOT NULL DEFAULT '',       -- 保護者アカウントのみ。生徒の閲覧は記録しない
  recordId  TEXT NOT NULL DEFAULT '',
  revision  INTEGER,
  readAt    TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX lessonReadReceipts_record ON lessonReadReceipts (recordId);

CREATE TABLE examReports (
  id          TEXT PRIMARY KEY,
  studentId   TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',     -- mock | school
  title       TEXT NOT NULL DEFAULT '',
  reflection  TEXT NOT NULL DEFAULT '',
  analysis    TEXT NOT NULL DEFAULT '',
  nextSteps   TEXT NOT NULL DEFAULT '',
  teacherNote TEXT NOT NULL DEFAULT '',     -- 先生だけが見る
  fileId      TEXT NOT NULL DEFAULT '',     -- Drive のファイル id
  fileName    TEXT NOT NULL DEFAULT '',
  fileHash    TEXT NOT NULL DEFAULT '',
  revision    INTEGER,
  requestId   TEXT NOT NULL DEFAULT '',
  payloadHash TEXT NOT NULL DEFAULT '',
  updatedAt   TEXT NOT NULL DEFAULT '',
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);
CREATE INDEX examReports_student_date ON examReports (studentId, date);

/* ================= 連絡・取消依頼・MCP ================= */

CREATE TABLE contactMessages (
  id         TEXT PRIMARY KEY,
  studentId  TEXT NOT NULL DEFAULT '',     -- 送信時に確定。本文では変えられない
  senderRole TEXT NOT NULL DEFAULT '',     -- student | parent
  senderId   TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  category   TEXT NOT NULL DEFAULT '',
  replyTo    TEXT NOT NULL DEFAULT '',
  receivedAt TEXT NOT NULL DEFAULT '',     -- サーバーの受信時刻。端末の時計は使わない
  status     TEXT NOT NULL DEFAULT '',
  reply      TEXT NOT NULL DEFAULT '',
  revision   INTEGER,
  updatedAt  TEXT NOT NULL DEFAULT '',
  _syncedAt  TEXT NOT NULL DEFAULT '',
  _sheetRow  INTEGER
);
CREATE INDEX contactMessages_student ON contactMessages (studentId, receivedAt);
CREATE INDEX contactMessages_status ON contactMessages (status);

CREATE TABLE cancellationRequests (
  id          TEXT PRIMARY KEY,
  studentId   TEXT NOT NULL DEFAULT '',
  slotId      TEXT NOT NULL DEFAULT '',
  receivedAt  TEXT NOT NULL DEFAULT '',
  deadlineAt  TEXT NOT NULL DEFAULT '',
  requestType TEXT NOT NULL DEFAULT '',    -- normal | exception
  reason      TEXT NOT NULL DEFAULT '',
  senderRole  TEXT NOT NULL DEFAULT '',
  senderId    TEXT NOT NULL DEFAULT '',
  slotJson    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  decidedAt   TEXT NOT NULL DEFAULT '',
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);
CREATE INDEX cancellationRequests_slot ON cancellationRequests (slotId);

CREATE TABLE contactProcessing (
  id              TEXT PRIMARY KEY,
  messageId       TEXT NOT NULL DEFAULT '',
  studentId       TEXT NOT NULL DEFAULT '',
  processId       TEXT NOT NULL DEFAULT '',
  client          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  claimedRevision INTEGER,
  claimedAt       TEXT NOT NULL DEFAULT '',
  expiresAt       TEXT NOT NULL DEFAULT '',
  itemsJson       TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  updatedAt       TEXT NOT NULL DEFAULT '',
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE INDEX contactProcessing_message ON contactProcessing (messageId);

/* ================= 保護者・生徒の認証と通知 =================
   passHash / passSalt / tokenHash / secretHash / inviteHash は秘密。
   どの応答にも出さない（GAS と同じ扱い）。 */

CREATE TABLE parents (                      -- 旧・生徒ごとの保護者認証。現在は familyAccounts が正
  studentId       TEXT PRIMARY KEY,
  passSalt        TEXT NOT NULL DEFAULT '',
  passHash        TEXT NOT NULL DEFAULT '',
  setAt           TEXT NOT NULL DEFAULT '',
  lastLogin       TEXT NOT NULL DEFAULT '',
  failCount       INTEGER,
  lockUntil       INTEGER,
  setupHash       TEXT NOT NULL DEFAULT '',
  setupExpiresAt  INTEGER,
  setupFailCount  INTEGER,
  tokenHash       TEXT NOT NULL DEFAULT '',
  tokenExpiresAt  INTEGER,
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);

CREATE TABLE familyAccounts (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '', -- pending | active | disabled
  email            TEXT NOT NULL DEFAULT '',
  verifiedAt       TEXT NOT NULL DEFAULT '',
  passSalt         TEXT NOT NULL DEFAULT '',
  passHash         TEXT NOT NULL DEFAULT '',
  createdAt        TEXT NOT NULL DEFAULT '',
  updatedAt        TEXT NOT NULL DEFAULT '',
  lastLogin        TEXT NOT NULL DEFAULT '',
  failCount        INTEGER,
  lockUntil        INTEGER,
  tokenHash        TEXT NOT NULL DEFAULT '', -- [{hash,expiresAt},…] の JSON（複数端末）
  tokenExpiresAt   INTEGER,
  securityVersion  INTEGER,
  inviteHash       TEXT NOT NULL DEFAULT '',
  inviteExpiresAt  INTEGER,
  inviteFailCount  INTEGER,
  testOnly         INTEGER,
  _syncedAt        TEXT NOT NULL DEFAULT '',
  _sheetRow        INTEGER
);
CREATE UNIQUE INDEX familyAccounts_email ON familyAccounts (email) WHERE email <> '';

CREATE TABLE familyLinks (
  id        TEXT PRIMARY KEY,
  familyId  TEXT NOT NULL DEFAULT '',
  studentId TEXT NOT NULL DEFAULT '',
  active    INTEGER,
  linkedAt  TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX familyLinks_family ON familyLinks (familyId);
CREATE INDEX familyLinks_student ON familyLinks (studentId);
CREATE UNIQUE INDEX familyLinks_active_pair ON familyLinks (familyId, studentId) WHERE active = 1;

CREATE TABLE familyChallenges (
  id              TEXT PRIMARY KEY,
  familyId        TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT '', -- verify | reset
  email           TEXT NOT NULL DEFAULT '',
  secretHash      TEXT NOT NULL DEFAULT '',
  expiresAt       INTEGER,                  -- 通常 30 分、先生が出した案内は 24 時間
  usedAt          TEXT NOT NULL DEFAULT '',
  createdAt       TEXT NOT NULL DEFAULT '',
  failCount       INTEGER,
  securityVersion INTEGER,
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE INDEX familyChallenges_family ON familyChallenges (familyId, kind);

CREATE TABLE familyOutbox (
  id        TEXT PRIMARY KEY,
  eventKey  TEXT NOT NULL DEFAULT '',
  familyId  TEXT NOT NULL DEFAULT '',
  studentId TEXT NOT NULL DEFAULT '',
  kind      TEXT NOT NULL DEFAULT '',
  ym        TEXT NOT NULL DEFAULT '',
  revision  INTEGER,
  email     TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT '',       -- uncertain は自動再送しない（二重送信を避ける）
  createdAt TEXT NOT NULL DEFAULT '',
  sentAt    TEXT NOT NULL DEFAULT '',
  attempts  INTEGER,
  error     TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE UNIQUE INDEX familyOutbox_event ON familyOutbox (familyId, eventKey);

CREATE TABLE familyNoticeReads (
  id        TEXT PRIMARY KEY,
  familyId  TEXT NOT NULL DEFAULT '',
  noticeId  TEXT NOT NULL DEFAULT '',
  readAt    TEXT NOT NULL DEFAULT '',
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX familyNoticeReads_family ON familyNoticeReads (familyId);

CREATE TABLE familyEmailPrefs (
  familyId       TEXT PRIMARY KEY,
  planProposed   INTEGER, -- 行が無いときは全部 on
  invoiceCreated INTEGER,
  invoiceVoided  INTEGER,
  updatedAt      TEXT NOT NULL DEFAULT '',
  _syncedAt      TEXT NOT NULL DEFAULT '',
  _sheetRow      INTEGER
);

CREATE TABLE studentEmails (
  studentId            TEXT PRIMARY KEY,
  email                TEXT NOT NULL DEFAULT '', -- students.email と一致して初めて確認済み扱い
  verifiedAt           TEXT NOT NULL DEFAULT '',
  pendingEmail         TEXT NOT NULL DEFAULT '',
  challengeId          TEXT NOT NULL DEFAULT '',
  challengeHash        TEXT NOT NULL DEFAULT '',
  challengeExpiresAt   INTEGER,
  challengeFailCount   INTEGER,
  challengeLinkHash    TEXT NOT NULL DEFAULT '',
  challengeUsedAt      TEXT NOT NULL DEFAULT '',
  requestedAt          TEXT NOT NULL DEFAULT '',
  lastMailStatus       TEXT NOT NULL DEFAULT '',
  revision             INTEGER,
  updatedAt            TEXT NOT NULL DEFAULT '',
  _syncedAt            TEXT NOT NULL DEFAULT '',
  _sheetRow            INTEGER
);

CREATE TABLE studentEmailOutbox (
  id              TEXT PRIMARY KEY,
  studentId       TEXT NOT NULL DEFAULT '',
  eventKey        TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  contactRevision INTEGER,
  snapshotJson    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT '',
  createdAt       TEXT NOT NULL DEFAULT '',
  sentAt          TEXT NOT NULL DEFAULT '',
  attempts        INTEGER,
  error           TEXT NOT NULL DEFAULT '',
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE UNIQUE INDEX studentEmailOutbox_event ON studentEmailOutbox (eventKey) WHERE eventKey <> '';

CREATE TABLE studentEmailPrefs (
  studentId      TEXT PRIMARY KEY,
  offered        INTEGER,
  changed        INTEGER,
  cancelled      INTEGER,
  cancelDeclined INTEGER,
  updatedAt      TEXT NOT NULL DEFAULT '',
  _syncedAt      TEXT NOT NULL DEFAULT '',
  _sheetRow      INTEGER
);

/* ================= 記録（追記のみ） ================= */

-- log と mcpLog には id が無い。シート上の行順を保つために rowid を使う
CREATE TABLE log (
  rowid_    INTEGER PRIMARY KEY AUTOINCREMENT,
  time      TEXT NOT NULL DEFAULT '',
  message   TEXT NOT NULL DEFAULT '',       -- 生徒名を含む。外へ出す資料には使わない
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX log_time ON log (time);

CREATE TABLE mcpLog (
  rowid_    INTEGER PRIMARY KEY AUTOINCREMENT,
  time      TEXT NOT NULL DEFAULT '',
  requestId TEXT NOT NULL DEFAULT '',
  client    TEXT NOT NULL DEFAULT '',
  op        TEXT NOT NULL DEFAULT '',
  target    TEXT NOT NULL DEFAULT '',
  params    TEXT NOT NULL DEFAULT '',
  result    TEXT NOT NULL DEFAULT '',
  ms        INTEGER,
  _syncedAt TEXT NOT NULL DEFAULT '',
  _sheetRow INTEGER
);
CREATE INDEX mcpLog_time ON mcpLog (time);

/* ================= 塾管理台帳（2冊目のスプレッドシート） =================
   GAS の ledgerRows_ は日本語の見出しをそのままキーにして読む。突合を機械的にするため
   表名・列名も日本語のままにしてある。ローマ字の別名は docs/D1_MIGRATION.md に載せる。 */

CREATE TABLE "入金管理" (
  "年月"          TEXT NOT NULL DEFAULT '',
  "生徒ID"        TEXT NOT NULL DEFAULT '',
  "氏名"          TEXT NOT NULL DEFAULT '',
  "請求額"        INTEGER,
  "請求日"        TEXT NOT NULL DEFAULT '',
  "入金日"        TEXT NOT NULL DEFAULT '',
  "入金方法"      TEXT NOT NULL DEFAULT '',
  "状態"          TEXT NOT NULL DEFAULT '', -- '取消' は取り消し済み
  "備考"          TEXT NOT NULL DEFAULT '',
  "請求ID"        TEXT NOT NULL,
  "承認版"        INTEGER,
  "料金方式"      TEXT NOT NULL DEFAULT '',
  "確定単価(30分)" INTEGER,
  "確定月謝"      INTEGER,
  "実施分数"      INTEGER,
  "実施回数"      INTEGER,
  "実績JSON"      TEXT NOT NULL DEFAULT '', -- 請求した授業の配列。空配列は旧方式の月まるごと
  "取消日時"      TEXT NOT NULL DEFAULT '',
  "取消理由"      TEXT NOT NULL DEFAULT '',
  "処理ID"        TEXT NOT NULL DEFAULT '',
  "入金版"        INTEGER,
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER,
  PRIMARY KEY ("請求ID")
);
CREATE INDEX "入金管理_生徒年月" ON "入金管理" ("生徒ID", "年月");

CREATE TABLE "生徒台帳" (
  "生徒ID"      TEXT PRIMARY KEY,
  "氏名"        TEXT NOT NULL DEFAULT '',
  "ふりがな"    TEXT NOT NULL DEFAULT '',
  "学年"        TEXT NOT NULL DEFAULT '',
  "学校"        TEXT NOT NULL DEFAULT '',
  "保護者名"    TEXT NOT NULL DEFAULT '',
  "保護者連絡先" TEXT NOT NULL DEFAULT '',
  "メール"      TEXT NOT NULL DEFAULT '',
  "入塾日"      TEXT NOT NULL DEFAULT '',
  "状態"        TEXT NOT NULL DEFAULT '',
  "科目"        TEXT NOT NULL DEFAULT '',
  "単価(30分)"  INTEGER,
  "月謝"        INTEGER,
  "備考"        TEXT NOT NULL DEFAULT '',
  _syncedAt     TEXT NOT NULL DEFAULT '',
  _sheetRow     INTEGER
);

CREATE TABLE "成績推移" (
  rowid_      INTEGER PRIMARY KEY AUTOINCREMENT,
  "日付"      TEXT NOT NULL DEFAULT '',
  "生徒ID"    TEXT NOT NULL DEFAULT '',
  "氏名"      TEXT NOT NULL DEFAULT '',
  "テスト名"  TEXT NOT NULL DEFAULT '',
  "科目"      TEXT NOT NULL DEFAULT '',
  "点数"      INTEGER,
  "満点"      INTEGER,
  "偏差値"    TEXT NOT NULL DEFAULT '',
  "順位"      TEXT NOT NULL DEFAULT '',
  "備考"      TEXT NOT NULL DEFAULT '',
  _syncedAt   TEXT NOT NULL DEFAULT '',
  _sheetRow   INTEGER
);
CREATE INDEX "成績推移_生徒" ON "成績推移" ("生徒ID", "日付");

CREATE TABLE "模試" (
  rowid_        INTEGER PRIMARY KEY AUTOINCREMENT,
  "日付"        TEXT NOT NULL DEFAULT '',
  "生徒ID"      TEXT NOT NULL DEFAULT '',
  "氏名"        TEXT NOT NULL DEFAULT '',
  "模試名"      TEXT NOT NULL DEFAULT '',
  "回"          TEXT NOT NULL DEFAULT '',
  "学年"        TEXT NOT NULL DEFAULT '',
  "国語"        TEXT NOT NULL DEFAULT '',
  "国語偏差値"  TEXT NOT NULL DEFAULT '',
  "数学"        TEXT NOT NULL DEFAULT '',
  "数学偏差値"  TEXT NOT NULL DEFAULT '',
  "社会"        TEXT NOT NULL DEFAULT '',
  "社会偏差値"  TEXT NOT NULL DEFAULT '',
  "理科"        TEXT NOT NULL DEFAULT '',
  "理科偏差値"  TEXT NOT NULL DEFAULT '',
  "英語"        TEXT NOT NULL DEFAULT '',
  "英語偏差値"  TEXT NOT NULL DEFAULT '',
  "3教科"       TEXT NOT NULL DEFAULT '',
  "3教科偏差値" TEXT NOT NULL DEFAULT '',
  "5教科"       TEXT NOT NULL DEFAULT '',
  "5教科偏差値" TEXT NOT NULL DEFAULT '',
  "3教科順位"   TEXT NOT NULL DEFAULT '',
  "5教科順位"   TEXT NOT NULL DEFAULT '',
  "受験者数"    TEXT NOT NULL DEFAULT '',
  "志望校判定"  TEXT NOT NULL DEFAULT '',
  "資料URL"     TEXT NOT NULL DEFAULT '',
  "備考"        TEXT NOT NULL DEFAULT '',
  _syncedAt     TEXT NOT NULL DEFAULT '',
  _sheetRow     INTEGER
);
CREATE INDEX "模試_生徒" ON "模試" ("生徒ID", "日付");

CREATE TABLE "面談記録" (
  rowid_          INTEGER PRIMARY KEY AUTOINCREMENT,
  "日付"          TEXT NOT NULL DEFAULT '',
  "生徒ID"        TEXT NOT NULL DEFAULT '',
  "氏名"          TEXT NOT NULL DEFAULT '',
  "相手"          TEXT NOT NULL DEFAULT '',
  "方法"          TEXT NOT NULL DEFAULT '',
  "内容"          TEXT NOT NULL DEFAULT '',
  "次のアクション" TEXT NOT NULL DEFAULT '',
  _syncedAt       TEXT NOT NULL DEFAULT '',
  _sheetRow       INTEGER
);
CREATE INDEX "面談記録_生徒" ON "面談記録" ("生徒ID", "日付");

/* ================= 取り込みの記録 ================= */

-- 台帳から取り込むたびに 1 行。件数が合っているかの突合に使う
CREATE TABLE _importRuns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  startedAt  TEXT NOT NULL,
  finishedAt TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',     -- 取り込み元（fixture / export ファイル名など）
  summary    TEXT NOT NULL DEFAULT ''      -- {表名: 件数} と不一致の JSON
);
