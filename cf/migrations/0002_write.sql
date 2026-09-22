-- 書き込みを Worker が担うための仕組み（D1 を唯一の正本にする）。
--
-- _ledger  … 台帳ぜんぶの版番号。書き込みは「読んだときの版」を持ち込み、変わっていなければ
--            版を +1 して反映する。変わっていたら反映せず、その操作を最初からやり直す
--            （Apps Script の全体ロックの置き換え。読んでから書くまでの割り込みを検出する）。
-- _guard   … 版の食い違いをまとめ書き（batch）の中で失敗させるための表。x=0 しか入らないので、
--            版が違うときに 1 を入れようとすると CHECK で落ち、まとめ書きごと取り消される。
-- _effects … 台帳を書いたあとに Apps Script へ頼む付随処理（メール・カレンダー）の控え。
--            送れたか、失敗したかを残し、失敗分は後から送り直せる。

CREATE TABLE _ledger (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT INTO _ledger (id, version) VALUES (1, 0);

CREATE TABLE _guard (
  x INTEGER NOT NULL CHECK (x = 0)
);

CREATE TABLE _effects (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT NOT NULL,
  kind      TEXT NOT NULL,             -- mail | calendarCreate | calendarDelete
  payload   TEXT NOT NULL,             -- JSON。宛先や本文を含むので外へ出さない
  status    TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts  INTEGER NOT NULL DEFAULT 0,
  error     TEXT NOT NULL DEFAULT '',
  sentAt    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX _effects_status ON _effects (status, id);
