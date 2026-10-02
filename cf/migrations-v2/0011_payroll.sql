-- 7段目: 講師の報酬（業務委託）。docs/REQUIREMENTS.md 5-1
-- 月末締め・翌月25日払い。時給は講師ごと（staffRates、変えた月から）。面談は別の時給。交通費・準備は数えない。
-- 確定した明細は変えない。直すときは取り消して（理由を残して）確定し直す。

-- 月の明細。講師ごと・月ごと（取消を除いて1つ）。status: confirmed（確定・支払い待ち）/ paid（支払い済み）/ void（取消）
-- 金額は行ごとに「分 × 時給 ÷ 60」の1円未満を切り捨てて足す
CREATE TABLE payrollMonths (
  id TEXT PRIMARY KEY,
  staffId TEXT NOT NULL REFERENCES staff(id),
  month TEXT NOT NULL,                           -- YYYY-MM（その月の勤務）
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'paid', 'void')),
  lessonMinutes INTEGER NOT NULL DEFAULT 0,
  meetingMinutes INTEGER NOT NULL DEFAULT 0,
  lessonAmount INTEGER NOT NULL DEFAULT 0,
  meetingAmount INTEGER NOT NULL DEFAULT 0,
  adjustAmount INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL,                        -- 総支給額
  withholding INTEGER NOT NULL DEFAULT 0,        -- 源泉徴収（講師ごとに する・しない）
  net INTEGER NOT NULL,                          -- 差引支給額
  payOn TEXT NOT NULL,                           -- 支払予定日（翌月25日）
  paidOn TEXT NOT NULL DEFAULT '',
  confirmedAt TEXT NOT NULL,
  confirmedBy TEXT NOT NULL DEFAULT '',
  voidedAt TEXT NOT NULL DEFAULT '',
  voidReason TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX payrollMonths_staff_month ON payrollMonths(staffId, month) WHERE status <> 'void';

-- 明細の行。kind: lesson（授業）/ meeting（面談）/ adjust（調整。理由つき、マイナスもある）
CREATE TABLE payrollItems (
  id TEXT PRIMARY KEY,
  payrollId TEXT NOT NULL REFERENCES payrollMonths(id),
  kind TEXT NOT NULL CHECK (kind IN ('lesson', 'meeting', 'adjust')),
  lessonId TEXT NOT NULL DEFAULT '',
  meetingId TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  start TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',                -- 例: 数学（架空 一郎さん）・面談・調整の理由
  rate INTEGER NOT NULL DEFAULT 0,               -- 時給
  amount INTEGER NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX payrollItems_payroll ON payrollItems(payrollId);

-- 確定の前に足しておく調整（例: 研修の時間、立て替え）。確定すると明細の行になる
CREATE TABLE payrollAdjustments (
  id TEXT PRIMARY KEY,
  staffId TEXT NOT NULL REFERENCES staff(id),
  month TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payrollId TEXT NOT NULL DEFAULT '',            -- 確定した明細
  createdBy TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX payrollAdjustments_staff ON payrollAdjustments(staffId, month);

-- 明細に入った授業・面談（取消で空に戻す）。確定のあとで実施済みになった前の月の分は、次の明細に入る
ALTER TABLE lessons ADD COLUMN payrollId TEXT NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN payrollId TEXT NOT NULL DEFAULT '';
