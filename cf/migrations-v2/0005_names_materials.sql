-- スタッフの姓と名（name は表示用に「姓 名」をそろえて入れる）。授業記録の「扱った範囲」を作る補助（単元・教材・ページ）
ALTER TABLE staff ADD COLUMN familyName TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN givenName TEXT NOT NULL DEFAULT '';
-- [{ unit: '不定詞', material: 'Keywork', pages: '10-12' }, …]。教材の候補を出すのにも使う
ALTER TABLE lessonRecords ADD COLUMN rangeParts TEXT NOT NULL DEFAULT '[]';
-- 今までの名前は姓の欄に入れる（あとで画面で姓と名に分けて直す）
UPDATE staff SET familyName = name WHERE familyName = '';
