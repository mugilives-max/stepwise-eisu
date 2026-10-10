-- 成績の階層（2026-10-11 本人「成績でいきなり北辰になってる。英検とか東部地区テストとか、定期テストの置き場が存在しない」）
-- 試験を「何の試験か」（series: 定期テスト・北辰テスト・東部地区テスト・英検 …）でまとめ、name はその中の回（3年4回、2学期中間 …）にする。
ALTER TABLE exams ADD COLUMN series TEXT NOT NULL DEFAULT '';
-- 今ある記録: 「北辰 3年4回」のように名前に入れていたものを分ける。定期テストは種類から
UPDATE exams SET series = '北辰テスト', name = trim(substr(name, 3)) WHERE series = '' AND name LIKE '北辰 %';
UPDATE exams SET series = '北辰テスト', name = trim(substr(name, 6)) WHERE series = '' AND name LIKE '北辰テスト %';
UPDATE exams SET series = '定期テスト' WHERE series = '' AND kind = 'regular';
UPDATE exams SET series = '模試' WHERE series = '' AND kind = 'mock';
