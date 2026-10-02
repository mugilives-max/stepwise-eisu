-- 5段目: 授業計画・キャンセル料・請求。docs/REBUILD_DESIGN.md 3-4、docs/TERMS_DRAFT_2026-10.md 第1・5・8条

-- 授業計画の行。1行 = 1人の生徒の、科目 × 授業の種類 × 期間（ふつうは1か月）。
-- 料金は1回の授業料（fee）で持つ（今の仕組みは30分あたりに直して持つので、1円ずれることがあった）。
-- status: draft（下書き。保護者には見せない）/ proposed（お知らせ済み・承認待ち）/ approved（承認）/ declined（見送り）
-- parentId があれば「追加の計画」（テスト前の追加など）。科目・種類は元の行と同じで、期間は元の行の中。
-- 承認: 保護者ページで承認（approvedBy = 'family'）か、LINE・電話などの承諾を教室管理者が記録（approvedBy = 'staff:<id>'）。
-- approvedCount は承認した回数（回数を減らして承認できる。0 = 見送り）。NULL = まだ。
CREATE TABLE planLines (
  id TEXT PRIMARY KEY,
  studentId TEXT NOT NULL REFERENCES students(id),
  parentId TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '通常',
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  count INTEGER NOT NULL,
  minutes INTEGER NOT NULL,
  fee INTEGER NOT NULL,                          -- 1回の授業料（円）
  comment TEXT NOT NULL DEFAULT '',              -- 保護者に見せる説明
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'approved', 'declined')),
  approvedCount INTEGER,
  proposedAt TEXT NOT NULL DEFAULT '',
  approvedAt TEXT NOT NULL DEFAULT '',
  approvedBy TEXT NOT NULL DEFAULT '',
  approvedVia TEXT NOT NULL DEFAULT '',          -- 保護者ページ / LINE / 電話 / 対面 など
  consentDate TEXT NOT NULL DEFAULT '',          -- 承諾をもらった日
  approvalNote TEXT NOT NULL DEFAULT '',
  familyAck TEXT NOT NULL DEFAULT '' CHECK (familyAck IN ('', 'confirmed', 'inquiry')), -- 先生が記録した承諾を、保護者が確かめた
  familyAckAt TEXT NOT NULL DEFAULT '',
  familyAckNote TEXT NOT NULL DEFAULT '',
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX planLines_student ON planLines(studentId, startDate);

-- キャンセル料。キャンセル（lessons.status = 'cancelled'）1つに1行。
-- type: late（前日23時を過ぎて、開始前の連絡。規定額 1,000円）/ noshow（開始後の連絡・連絡のない欠席。その授業の授業料）
-- decision: pending（教室管理者の判断待ち）/ charge（規定額）/ adjust（減額）/ waive（免除）
-- 保護者からの減額・免除の申請: reliefStatus pending → unchanged / reduced / waived
CREATE TABLE cancellationFees (
  id TEXT PRIMARY KEY,
  lessonId TEXT NOT NULL REFERENCES lessons(id),
  studentId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('late', 'noshow')),
  receivedAt TEXT NOT NULL DEFAULT '',           -- 連絡を受けた時刻（連絡のない欠席は空）
  standardAmount INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'charge', 'adjust', 'waive')),
  note TEXT NOT NULL DEFAULT '',                 -- 減額・免除の理由（保護者に見える）
  decidedAt TEXT NOT NULL DEFAULT '',
  decidedBy TEXT NOT NULL DEFAULT '',
  reliefStatus TEXT NOT NULL DEFAULT '' CHECK (reliefStatus IN ('', 'pending', 'unchanged', 'reduced', 'waived')),
  reliefReason TEXT NOT NULL DEFAULT '',
  reliefRequestedAt TEXT NOT NULL DEFAULT '',
  reliefResponse TEXT NOT NULL DEFAULT '',
  reliefDecidedAt TEXT NOT NULL DEFAULT '',
  invoiceId TEXT NOT NULL DEFAULT '',            -- 請求に入れたら、その請求
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX cancellationFees_lesson ON cancellationFees(lessonId);

-- 請求。家族ごと・月ごと（取消を除いて1つ）。月の分は翌月3日の0時10分に自動で確定する（確かめることがあれば止まる）。
-- status: confirmed（確定・お支払い待ち）/ reported（保護者から振込の連絡あり）/ paid（入金済み）/ void（取消）
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES families(id),
  month TEXT NOT NULL,                           -- YYYY-MM
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'reported', 'paid', 'void')),
  total INTEGER NOT NULL,
  confirmedAt TEXT NOT NULL,
  confirmedBy TEXT NOT NULL DEFAULT '',          -- system:auto / staff:<id> / legacy
  reportedAt TEXT NOT NULL DEFAULT '',
  paidOn TEXT NOT NULL DEFAULT '',
  paidMethod TEXT NOT NULL DEFAULT '',
  voidedAt TEXT NOT NULL DEFAULT '',
  voidReason TEXT NOT NULL DEFAULT '',
  legacyId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX invoices_family_month ON invoices(familyId, month) WHERE status <> 'void';

-- 請求の内訳。kind: lesson（授業）/ cancelFee（キャンセル料）/ legacy（今の仕組みで内訳のない請求）
CREATE TABLE invoiceItems (
  id TEXT PRIMARY KEY,
  invoiceId TEXT NOT NULL REFERENCES invoices(id),
  studentId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lesson', 'cancelFee', 'legacy')),
  lessonId TEXT NOT NULL DEFAULT '',
  feeId TEXT NOT NULL DEFAULT '',
  planLineId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  lessonKind TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoiceItems_invoice ON invoiceItems(invoiceId);
CREATE INDEX invoiceItems_line ON invoiceItems(planLineId);

-- 授業を請求に入れたら、その請求（取消で空に戻す）。請求に入った授業は直せない
ALTER TABLE lessons ADD COLUMN invoiceId TEXT NOT NULL DEFAULT '';
