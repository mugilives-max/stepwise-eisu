-- ファイルの置き場所を1つにする（成績票・請求書・領収書・講師の支払明細・契約書など、すべて）。docs/REBUILD_DESIGN.md「ファイルの置き場所」
-- 中身は Cloudflare R2（バケット stepwise-files、binding FILES）に、鍵 'f/<id>' で置く。名前や家族は鍵に入れない。
-- 「フォルダ」は持たない。家族ごと・生徒ごと・種類ごと・月ごとの一覧は、この表から作る。
-- 誰が開けるかは種類（category）で決まる（cf/v2/files.mjs の canRead）。

-- 6段目で作った成績票の置き方（D1 に分けて持つ）はやめる。本番にはまだ1件もないので、そのまま作り直す
DROP TABLE examFileChunks;
DROP TABLE examFiles;

-- category: scoreSheet（成績票）/ invoice（請求書）/ receipt（領収書）/ payStatement（講師の支払明細）/ contract（契約書・規約の同意）/ other
-- status: pending（送る前。送る鍵を渡しただけ）/ ready（置いた）/ deleted（消した）
-- retainUntil: この日までは消せない（お金の書類は7年。電子帳簿保存法）。空なら決まりなし
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('scoreSheet', 'invoice', 'receipt', 'payStatement', 'contract', 'other')),
  familyId TEXT NOT NULL DEFAULT '',
  studentId TEXT NOT NULL DEFAULT '',
  staffId TEXT NOT NULL DEFAULT '',
  refType TEXT NOT NULL DEFAULT '',              -- exam / invoice / payrollMonth など。つながる先の表
  refId TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  uploadedByKind TEXT NOT NULL CHECK (uploadedByKind IN ('student', 'family', 'staff', 'system')),
  uploadedById TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'deleted')),
  retainUntil TEXT NOT NULL DEFAULT '',
  deletedAt TEXT NOT NULL DEFAULT '',
  deletedBy TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX files_family ON files(familyId, category, createdAt);
CREATE INDEX files_student ON files(studentId, category, createdAt);
CREATE INDEX files_staff ON files(staffId, category, createdAt);
CREATE INDEX files_ref ON files(refType, refId);
CREATE INDEX files_status ON files(status, createdAt);

-- 送る・開くための短い鍵（送るのは1回だけ・10分、開くのは5分）。鍵そのものは持たず、ハッシュだけ
CREATE TABLE fileTokens (
  tokenHash TEXT PRIMARY KEY,
  fileId TEXT NOT NULL REFERENCES files(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('put', 'get')),
  expiresAt TEXT NOT NULL,
  usedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX fileTokens_expires ON fileTokens(expiresAt);

-- 成績票の取り込み（成績の領域だけの状態）。中身と送った人は files に
-- status: new（取り込み待ち）/ imported（点数を取り込んだ）/ dismissed（取り込まない）
CREATE TABLE examFiles (
  fileId TEXT PRIMARY KEY REFERENCES files(id),
  studentId TEXT NOT NULL REFERENCES students(id),
  examId TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'imported', 'dismissed')),
  resolvedBy TEXT NOT NULL DEFAULT '',
  resolvedAt TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
);
CREATE INDEX examFiles_status ON examFiles(status, createdAt);
CREATE INDEX examFiles_student ON examFiles(studentId);
