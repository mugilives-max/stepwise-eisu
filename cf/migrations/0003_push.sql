-- プッシュ通知の宛先。
--
-- endpoint は配信サービス（Google / Apple / Mozilla）が端末ごとに発行する URL で、
-- これを知っていればその端末に通知を送れてしまう。p256dh / auth は本文を暗号化する鍵。
-- どれも本人に結びつく値なので、D1 の外には出さない（応答にも書き出さない）。
--
-- owner は誰の端末か。生徒は students.id、保護者は familyAccounts.id を入れ、
-- ownerKind でどちらかを区別する。ひとりが複数の端末を登録できる。
-- 配信サービスが 404 / 410 を返したらその登録は消えているので、行ごと削除する。

CREATE TABLE pushSubs (
  endpoint   TEXT PRIMARY KEY,
  ownerKind  TEXT NOT NULL,              -- student | family
  owner      TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  lastOkAt   TEXT NOT NULL DEFAULT '',
  failures   INTEGER NOT NULL DEFAULT 0,
  lastError  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX pushSubs_owner ON pushSubs (ownerKind, owner);
