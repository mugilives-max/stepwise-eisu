// 作り直し（v2）の画面を、本番に触れずに手元で見るための小さなサーバー。
// 新しい台帳（DB2）と今の台帳（DB）をメモリの SQLite で用意し（test/helpers と同じ）、架空の家族・生徒・授業・記録・計画・請求を入れて、
// 画面（/family/・/student/・/staff/）と API（POST /v2/…）を同じ場所から出す。
//   node scripts/dev-v2-preview.mjs            → http://localhost:8790/family/ （ログイン: parent@example.invalid / family password 1）
//   node scripts/dev-v2-preview.mjs --live     → 切り替えたあとの状態（「準備中」の案内を出さない）
// 生徒のマイページは起動時に出るリンク（/student/?k=…）。スタッフは owner@example.invalid / correct horse battery。
// 本番のデータ・メール・カレンダーには一切つながらない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createV2 } = require(path.join(ROOT, 'test', 'helpers', 'v2-harness.cjs'));
const PORT = Number(process.env.PORT || 8790), LIVE = process.argv.includes('--live');
const at = s => Date.parse(s + '+09:00');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function seed() {
  const h = await createV2();
  const auth = await h.owner();
  const me = (await h.ok('staff/me', { auth })).me;
  h.clock = at('2026-09-01T09:00:00');
  const fam = (await h.ok('admin/families/create', { auth, name: '架空家', guardianName: '架空 花子', email: 'parent@example.invalid', phone: '090-0000-0000' })).family;
  const taro = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '太郎', grade: '中3', baseRate30: 1500, deliveryMode: 'in_person' })).student;
  const hana = (await h.ok('admin/students/create', { auth, familyId: fam.id, familyName: '架空', givenName: '花', grade: '高2', baseRate30: 1500, deliveryMode: 'online' })).student;
  await h.ok('admin/families/invite', { auth, id: fam.id });
  const parent = (await h.ok('family/invite/accept', { token: h.linkFrom(h.mails().at(-1)), password: 'family password 1' })).auth;
  const lesson = async (studentId, date, start, subject, minutes = 90, extra = {}) => {
    await h.ok('schedule/lessons/create', { auth, studentId, date, start, minutes, subject, deliveryMode: studentId === hana.id ? 'online' : 'in_person', staffId: me.id, force: true, ...extra });
    return h.rows('select * from lessons where studentId = ? and date = ? and start = ?', studentId, date, start)[0];
  };
  const decide = async l => { const cur = h.rows('select * from lessons where id = ?', l.id)[0]; await h.ok('schedule/lessons/decide', { auth, id: cur.id, version: cur.version }); };
  const done = async l => { const cur = h.rows('select * from lessons where id = ?', l.id)[0]; await h.ok('schedule/lessons/done', { auth, id: cur.id, version: cur.version }); };
  // 9月の計画（承認済み）と授業（実施済み）→ 9月分の請求（10/3 に確定）
  for (const [sid, subject] of [[taro.id, '数学'], [taro.id, '英語'], [hana.id, '化学']]) {
    const line = (await h.ok('billing/plans/save', { auth, studentId: sid, subject, kind: '通常', startDate: '2026-09-01', endDate: '2026-09-30', count: 4, minutes: 90, fee: 4500 })).line;
    await h.ok('billing/plans/consent', { auth, id: line.id, version: h.rows('select version from planLines where id = ?', line.id)[0].version, consentDate: '2026-08-28', via: 'LINE' });
  }
  const sept = [];
  for (const d of ['2026-09-03', '2026-09-10', '2026-09-17', '2026-09-24']) { sept.push(await lesson(taro.id, d, '18:00', '数学')); sept.push(await lesson(taro.id, d, '19:30', '英語')); }
  for (const d of ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26']) sept.push(await lesson(hana.id, d, '10:00', '化学'));
  for (const l of sept) await decide(l);
  // 授業記録（9月の数学の最後の2回）と宿題
  const rec = async (l, body) => { await h.ok('records/save', { auth, lessonId: l.id, publish: true, ...body }); };
  h.clock = at('2026-09-17T20:00:00'); await done(sept[4]);
  await rec(sept[4], { range: '二次方程式（FS3 p.40-44）', rangeParts: [{ unit: '二次方程式', material: 'FS3', pages: 'p.40-44' }], comment: '解の公式は使えるようになりました。因数分解で解ける形を見分けるのに時間がかかるので、次回も練習します。', parentMessage: '北辰の前日は 20 時までに寝るようにお願いします。', staffNotes: { understanding: '4' }, homework: [{ title: 'p.45-48', material: 'FS3', dueMode: 'nextLesson', dueSubject: '数学' }, { title: '計算ドリル 10 問', material: '', dueMode: 'nextLesson', dueSubject: '数学' }] });
  h.clock = at('2026-09-24T20:00:00'); await done(sept[6]); await done(sept[5]); await done(sept[7]);
  const checks = h.rows("select id from homework where studentId = ? and status = 'open' order by createdAt", taro.id).map((w, i) => ({ id: w.id, result: i === 0 ? 'done' : 'partial' }));
  await rec(sept[6], { range: '二次関数（FS3 p.50-55）', rangeParts: [{ unit: '二次関数', material: 'FS3', pages: 'p.50-55' }], comment: 'グラフの頂点を求めるところまで。平方完成の符号ミスが 3 回あったので、手順を声に出して確かめる練習をしました。', staffNotes: { understanding: '3' }, homeworkChecks: checks, homework: [{ title: 'p.56-58', material: 'FS3', dueMode: 'nextLesson', dueSubject: '数学' }] });
  await rec(sept[7], { range: '不定詞（Keyワーク p.30-33）', rangeParts: [{ unit: '不定詞', material: 'Keyワーク', pages: 'p.30-33' }], comment: '名詞的用法と副詞的用法の見分けは安定してきました。形容詞的用法を次回。', staffNotes: { understanding: '4' }, homework: [{ title: 'p.34-35', material: 'Keyワーク', dueMode: 'nextLesson', dueSubject: '英語' }] });
  h.clock = at('2026-09-30T23:00:00');
  for (const l of [sept[0], sept[1], sept[2], sept[3], sept[8], sept[9], sept[10], sept[11]]) { const cur = h.rows('select status from lessons where id = ?', l.id)[0]; if (cur.status !== 'done') await done(l); }
  h.clock = at('2026-10-03T00:20:00');
  const pv = (await h.ok('billing/family', { auth, familyId: fam.id, month: '2026-09' })).preview;
  await h.ok('billing/confirm', { auth, familyId: fam.id, month: '2026-09', expectedTotal: pv.total });
  // 10月: 決定した授業（これから）と仮予定、11月の計画（承認待ち）
  h.clock = at('2026-10-01T09:00:00');
  const oct = [];
  for (const d of ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']) { oct.push(await lesson(taro.id, d, '18:00', '数学')); oct.push(await lesson(taro.id, d, '19:30', '英語')); }
  for (const d of ['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24']) oct.push(await lesson(hana.id, d, '10:00', '化学'));
  for (const l of oct) await decide(l);
  for (const [sid, subject] of [[taro.id, '数学'], [taro.id, '英語'], [hana.id, '化学']]) {
    const line = (await h.ok('billing/plans/save', { auth, studentId: sid, subject, kind: '通常', startDate: '2026-10-01', endDate: '2026-10-31', count: subject === '化学' ? 4 : 5, minutes: 90, fee: 4500 })).line;
    await h.ok('billing/plans/consent', { auth, id: line.id, version: h.rows('select version from planLines where id = ?', line.id)[0].version, consentDate: '2026-09-28', via: 'LINE' });
  }
  h.clock = at('2026-10-01T20:00:00'); await done(oct[0]); await done(oct[1]);
  await rec(oct[0], { range: '二次関数の利用（FS3 p.60-63）', rangeParts: [{ unit: '二次関数の利用', material: 'FS3', pages: 'p.60-63' }], comment: '文章題の立式が自分でできるようになってきました。', staffNotes: { understanding: '4' }, homework: [{ title: 'p.64-66', material: 'FS3', dueMode: 'nextLesson', dueSubject: '数学' }] });
  h.clock = at('2026-10-03T20:00:00'); await done(oct[10]);
  await rec(oct[10], { range: '酸と塩基（セミナー p.120-128）', rangeParts: [{ unit: '酸と塩基', material: 'セミナー化学', pages: 'p.120-128' }], comment: '中和滴定の計算。単位の換算で迷うので、mol と mL の整理を次回も。', staffNotes: { understanding: '3' }, homework: [{ title: 'p.129-131', material: 'セミナー化学', dueMode: 'nextLesson', dueSubject: '化学' }] });
  // 11月の仮予定（締め切りつき）と、11月の計画（承認待ち）
  h.clock = at('2026-10-05T09:00:00');
  for (const d of ['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26']) { await lesson(taro.id, d, '18:00', '数学'); await lesson(taro.id, d, '19:30', '英語'); }
  for (const [sid, subject, n] of [[taro.id, '数学', 4], [taro.id, '英語', 4], [hana.id, '化学', 4]]) {
    await h.ok('billing/plans/save', { auth, studentId: sid, subject, kind: '通常', startDate: '2026-11-01', endDate: '2026-11-30', count: n, minutes: 90, fee: 4500 });
  }
  await h.ok('billing/plans/send', { auth, familyId: fam.id });
  // テスト・行事（保護者のログインは時計を進めると切れるので、入り直す）
  h.clock = at('2026-10-06T09:00:00');
  const parent2 = (await h.ok('family/login', { email: 'parent@example.invalid', password: 'family password 1' })).auth;
  await h.ok('family/events/add', { auth: parent2, studentId: taro.id, kind: 'test', date: '2026-10-15', dateTo: '2026-10-16', title: '2学期中間テスト' });
  await h.ok('family/events/add', { auth: parent2, studentId: taro.id, kind: 'test', date: '2026-11-08', title: '北辰テスト（第6回）' });
  await h.ok('family/events/add', { auth: parent2, studentId: hana.id, kind: 'event', date: '2026-10-30', title: '修学旅行' });
  // 成績
  const exam = async (studentId, body, scores, review) => {
    const id = (await h.ok('grades/exams/save', { auth, studentId, ...body })).examId;
    await h.ok('grades/scores/save', { auth, examId: id, scores });
    if (review) await h.ok('grades/reviews/save', { auth, examId: id, ...review });
  };
  await exam(taro.id, { kind: 'mock', name: '北辰テスト（第4回）', date: '2026-09-06', totalDeviation: 58.2 }, [{ subject: '英語', score: 72, max: 100, deviation: 61.0 }, { subject: '数学', score: 60, max: 100, deviation: 55.4 }, { subject: '国語', score: 68, max: 100, deviation: 57.1 }], { good: '英語の長文が安定してきた', issues: '数学の大問 3 以降', nextSteps: '関数の文章題を毎週 2 題' });
  await exam(taro.id, { kind: 'mock', name: '北辰テスト（第5回）', date: '2026-10-04', totalDeviation: 60.1 }, [{ subject: '英語', score: 78, max: 100, deviation: 63.2 }, { subject: '数学', score: 66, max: 100, deviation: 58.0 }, { subject: '国語', score: 65, max: 100, deviation: 55.9 }]);
  await exam(taro.id, { kind: 'regular', name: '1学期期末テスト', date: '2026-07-03' }, [{ subject: '英語', score: 81, max: 100, average: 62.3, rank: 18, rankOf: 160 }, { subject: '数学', score: 74, max: 100, average: 58.1, rank: 31, rankOf: 160 }]);
  const k = h.rows('select linkCode from students where id = ?', taro.id)[0].linkCode;
  const kh = h.rows('select linkCode from students where id = ?', hana.id)[0].linkCode;
  if (LIVE) h.db2._sqlite.prepare("insert into settings (key, value, updatedAt) values ('live', '1', ?) on conflict(key) do update set value = '1'").run(new Date().toISOString());
  return { h, k, kh };
}

const { h, k, kh } = await seed();
if (process.env.V2_SERVICE_KEY) h.env.V2_SERVICE_KEY = process.env.V2_SERVICE_KEY; // MCP の読み取りの鍵を試すとき
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  h.clock = Date.now();
  if (url.pathname.startsWith('/v2/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let out;
    if (req.method === 'POST' && (req.headers['content-type'] || '').includes('json') || (req.method === 'POST' && body.length && body[0] === 0x7b)) {
      let b = {}; try { b = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const r = await h.call(url.pathname.slice(4), b);
      const { status, ...rest } = r;
      res.writeHead(status || 200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(rest));
    }
    out = await h.raw(req.method, url.pathname.slice(4) + url.search, body.length ? body : undefined);
    res.writeHead(out.status, Object.fromEntries(out.headers)); return res.end(Buffer.from(await out.arrayBuffer()));
  }
  if (url.pathname === '/' && !(req.headers.accept || '').includes('text/html')) {
    const live = h.rows("select value from settings where key = 'live'")[0];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, service: 'stepwise-api', release: 'preview', cutover: { live: !!live && live.value === '1', oldReadOnlySince: '' } }));
  }
  let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
server.listen(PORT, () => {
  console.log(`v2 preview: http://localhost:${PORT}/family/  (parent@example.invalid / family password 1)${LIVE ? '  [live]' : ''}`);
  console.log(`student (太郎): http://localhost:${PORT}/student/?k=${encodeURIComponent(k)}`);
  console.log(`student (花):   http://localhost:${PORT}/student/?k=${encodeURIComponent(kh)}`);
  console.log(`staff: http://localhost:${PORT}/staff/  (owner@example.invalid / correct horse battery)`);
});
