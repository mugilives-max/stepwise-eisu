-- 作り直し（v2）: 宿題ごとのチェック（次の授業の記録で、やってきた・一部・やってこなかった を付ける）
-- checkResult: '' / done（やってきた → 確認済み）/ partial（一部）/ notDone（やってこなかった）。一部・やってこなかったは未完了のまま次へ持ち越す
-- checkedRecordId: チェックを付けた授業記録（その記録を直すときに付け直せる）
ALTER TABLE homework ADD COLUMN checkResult TEXT NOT NULL DEFAULT '';
ALTER TABLE homework ADD COLUMN checkedAt TEXT NOT NULL DEFAULT '';
ALTER TABLE homework ADD COLUMN checkedRecordId TEXT NOT NULL DEFAULT '';
