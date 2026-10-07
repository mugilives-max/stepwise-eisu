// ファイルの置き場所（すべての領域で共通）。migrations-v2/0010_files.sql
// - 中身は R2（env.FILES）に 'f/<id>' で置く。台帳（files 表）に、種類・持ち主・つながる先・名前・大きさを持つ。
// - 送る: 領域の操作（例: family/grades/upload）が startUpload で行を作り、送る鍵を返す → 画面が POST /v2/files/put?t=鍵 に中身を送る。
// - 開く: files/link で開く鍵（5分）をもらう → GET /v2/files/get?t=鍵 を新しいタブで開く。
// - 誰が開けるかは canRead だけで決める（種類ごと）。領域ごとに決まりを書かない。
// - お金の書類（請求書・領収書・給与明細）は7年消せない（retainUntil）。
import { fail, newId, newToken, sha256Hex, iso, audit } from './util.mjs';
import { readSession } from './accounts.mjs';
import { rolesOf } from './staff.mjs';
import { recordEffects, deliverEffects } from './effects.mjs';
import { isPreviewToken, previewSubject } from './preview.mjs';

export const CATEGORIES = ['scoreSheet', 'invoice', 'receipt', 'payStatement', 'contract', 'other'];
export const FILE_MAX = 20 * 1024 * 1024;
const MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const RETAIN_YEARS = { invoice: 7, receipt: 7, payStatement: 7 };
const key = id => 'f/' + id;
const addYears = (d, n) => (Number(d.slice(0, 4)) + n) + d.slice(4);

// 中身の先頭で、本当にその種類かを確かめる（名前や申告の種類だけを信じない）
function sniff(bytes) {
  const b = i => bytes[i];
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  return '';
}

// ---- だれが開けるか（ここだけで決める） ----
// who: { kind: 'staff', me } / { kind: 'family', me } / { kind: 'student', student }
export async function canRead(c, f, who) {
  if (f.status !== 'ready') return false;
  if (who.kind === 'staff') {
    const roles = rolesOf(who.me);
    if (roles.includes('manager')) return true;
    return f.category === 'payStatement' && f.staffId === who.me.id; // 講師は自分の給与明細だけ
  }
  if (who.kind === 'family') {
    if (!['scoreSheet', 'invoice', 'receipt', 'contract'].includes(f.category)) return false;
    if (f.familyId === who.me.id) return true;
    if (f.studentId) { const s = await c.db.prepare('select familyId from students where id = ?').bind(f.studentId).first(); return !!s && s.familyId === who.me.id; }
    return false;
  }
  if (who.kind === 'student') return f.category === 'scoreSheet' && f.studentId === who.student.id && f.uploadedByKind === 'student';
  return false;
}
// auth（スタッフ・保護者）か k（生徒の専用リンク）から、だれかを決める
export async function whoIs(c, b) {
  // スタッフのプレビュー: 見ている相手（家族・生徒）として開く
  if (isPreviewToken(b.k)) { const s = await previewSubject(c, b.k, 'student'); if (s) return { kind: 'student', student: s }; fail('badLink', 'プレビューの期限が切れました', 401); }
  if (isPreviewToken(b.auth)) { const f = await previewSubject(c, b.auth, 'family'); if (f) return { kind: 'family', me: f }; fail('needLogin', 'プレビューの期限が切れました', 401); }
  if (b.k) {
    const s = String(b.k).length <= 100 ? await c.db.prepare("select * from students where linkCode = ? and status <> 'left'").bind(String(b.k)).first() : null;
    if (!s) fail('badLink', '専用リンクが正しくありません。先生から届いたリンクを開き直してください', 401);
    c.actor = { kind: 'student', id: s.id }; return { kind: 'student', student: s };
  }
  const auth = String(b.auth || '');
  if (auth.startsWith('s2.')) { const me = await readSession(c, 'staff', auth); if (me) { c.actor = { kind: 'staff', id: me.id }; return { kind: 'staff', me }; } }
  if (auth.startsWith('f2.')) { const me = await readSession(c, 'family', auth); if (me) { c.actor = { kind: 'family', id: me.id }; return { kind: 'family', me }; } }
  fail('needLogin', 'ログインし直してください', 401);
}

// ---- 送る ----
// 領域の操作から呼ぶ。行（pending）を作り、送る鍵（10分・1回）を返す。extraStmts は同じ時に書く領域の行
export async function startUpload(c, { category, familyId = '', studentId = '', staffId = '', refType = '', refId = '', name, mime, size, note = '', by }, extraStmts = () => []) {
  if (!CATEGORIES.includes(category)) fail('badCategory', 'ファイルの種類が正しくありません');
  if (!MIMES[mime]) fail('badType', '写真（JPEG・PNG）か PDF を送ってください');
  size = Number(size);
  if (!Number.isInteger(size) || size < 1 || size > FILE_MAX) fail('tooLarge', 'ファイルは20MBまでにしてください');
  name = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || '無題';
  note = String(note || '').trim(); if (note.length > 200) fail('tooLong', '一言は200文字以内にしてください');
  const day = new Date(Date.parse(iso(c.now).slice(0, 10) + 'T00:00:00Z')).toISOString();
  if ((await c.db.prepare('select count(*) n from files where uploadedById = ? and createdAt >= ?').bind(by.id, day).first()).n >= 30) fail('tooMany', '1日に送れるのは30件までです');
  const id = newId('fl'), token = newToken('ft'), now = iso(c.now);
  await c.db.batch([
    c.db.prepare('insert into files (id, category, familyId, studentId, staffId, refType, refId, name, mime, size, note, uploadedByKind, uploadedById, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, category, familyId, studentId, staffId, refType, refId, name, mime, size, note, by.kind, by.id, now, now),
    c.db.prepare("insert into fileTokens (tokenHash, fileId, purpose, expiresAt) values (?, ?, 'put', ?)").bind(sha256Hex(token), id, new Date(c.now + 10 * 60e3).toISOString()),
    ...extraStmts(id),
  ]);
  return { fileId: id, uploadUrl: 'files/put?t=' + encodeURIComponent(token) };
}
// 置いたあとに領域へ知らせる（例: 成績票が届いたら教室管理者へ）。category → async (c, file)
const onReady = {};
export function whenReady(category, fn) { onReady[category] = fn; }

// システムが作る書類（請求書の PDF など）を置く。中身は手元にある（bytes）
export async function putGenerated(c, { category, familyId = '', studentId = '', staffId = '', refType = '', refId = '', name, mime, bytes, note = '' }) {
  if (!c.env.FILES) fail('unavailable', 'ファイルの置き場所が使えません', 503);
  const id = newId('fl'), now = iso(c.now), retain = RETAIN_YEARS[category] ? addYears(now.slice(0, 10), RETAIN_YEARS[category]) : '';
  await c.env.FILES.put(key(id), bytes, { httpMetadata: { contentType: mime } });
  await c.db.prepare("insert into files (id, category, familyId, studentId, staffId, refType, refId, name, mime, size, sha256, note, uploadedByKind, status, retainUntil, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', 'ready', ?, ?, ?)")
    .bind(id, category, familyId, studentId, staffId, refType, refId, name, mime, bytes.length, await digest(bytes), note, retain, now, now).run();
  return id;
}
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');

// ---- 送られた中身・開く（JSON ではない2つの口。index.mjs から呼ぶ） ----
async function useToken(c, token, purpose) {
  const t = token ? await c.db.prepare('select * from fileTokens where tokenHash = ?').bind(sha256Hex(token)).first() : null;
  if (!t || t.purpose !== purpose || t.expiresAt < iso(c.now) || (purpose === 'put' && t.usedAt)) return null;
  return t;
}
export async function handleTransfer(request, env, ctx, route, head) {
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...head } });
  const c = { env, db: env.DB2, now: Date.now(), effects: [], actor: { kind: 'system', id: 'files' }, userAgent: request.headers.get('user-agent') || '' };
  const token = new URL(request.url).searchParams.get('t') || '';
  if (!env.FILES) return json(503, { ok: false, error: { code: 'unavailable', message: 'ファイルの置き場所が使えません' } });
  if (route === 'files/put') {
    if (request.method !== 'POST') return json(405, { ok: false, error: { code: 'method', message: 'POST で送ってください' } });
    const t = await useToken(c, token, 'put');
    if (!t) return json(403, { ok: false, error: { code: 'expiredLink', message: '送るための鍵が切れました。もう一度選んで送ってください' } });
    const f = await c.db.prepare('select * from files where id = ?').bind(t.fileId).first();
    const len = Number(request.headers.get('content-length') || 0);
    if (!f || f.status !== 'pending' || (len && len !== f.size)) return json(400, { ok: false, error: { code: 'badSize', message: '大きさが合いません。もう一度送ってください' } });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length !== f.size) return json(400, { ok: false, error: { code: 'badSize', message: '途中で切れました。もう一度送ってください' } });
    if (sniff(bytes) !== f.mime) return json(400, { ok: false, error: { code: 'badType', message: '写真（JPEG・PNG）か PDF を送ってください' } });
    await c.db.prepare("update fileTokens set usedAt = ? where tokenHash = ? and usedAt = ''").bind(iso(c.now), t.tokenHash).run();
    await env.FILES.put(key(f.id), bytes, { httpMetadata: { contentType: f.mime } });
    const retain = RETAIN_YEARS[f.category] ? addYears(iso(c.now).slice(0, 10), RETAIN_YEARS[f.category]) : '';
    await c.db.prepare("update files set status = 'ready', sha256 = ?, retainUntil = ?, updatedAt = ? where id = ?").bind(await digest(bytes), retain, iso(c.now), f.id).run();
    if (onReady[f.category]) await onReady[f.category](c, { ...f, status: 'ready' });
    await audit(c, 'fileUpload', f.id, { category: f.category, size: f.size, by: f.uploadedByKind });
    if (c.effects.length) {
      const finish = deliverEffects(env, c.db, await recordEffects(c.db, c.effects, c.now)).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(finish); else await finish;
    }
    return json(200, { ok: true, fileId: f.id });
  }
  // files/get: 開く（5分のあいだは何度でも。PDF の表示は何回かに分けて読むため）
  if (request.method !== 'GET') return json(405, { ok: false, error: { code: 'method', message: 'GET で開いてください' } });
  const t = await useToken(c, token, 'get');
  const f = t ? await c.db.prepare('select * from files where id = ?').bind(t.fileId).first() : null;
  if (!f || f.status !== 'ready') return new Response('リンクの期限が切れました。画面からもう一度開いてください。', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  const obj = await env.FILES.get(key(f.id));
  if (!obj) return new Response('ファイルが見つかりません。', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const fname = /\.\w+$/.test(f.name) ? f.name : f.name + '.' + MIMES[f.mime];
  return new Response(obj.body, { headers: { 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fname)}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

export const fileRoutes = {
  // 開く鍵をもらう（5分）。だれが開けるかは canRead
  'files/link': async (c, b) => {
    const who = await whoIs(c, b);
    const f = await c.db.prepare('select * from files where id = ?').bind(String(b.id || '')).first();
    if (!f || !(await canRead(c, f, who))) fail('notFound', 'ファイルが見つかりません', 404);
    const token = newToken('ft');
    await c.db.prepare("insert into fileTokens (tokenHash, fileId, purpose, expiresAt) values (?, ?, 'get', ?)").bind(sha256Hex(token), f.id, new Date(c.now + 5 * 60e3).toISOString()).run();
    return { url: 'files/get?t=' + encodeURIComponent(token), name: f.name, mime: f.mime };
  },
  // 消す（教室管理者）。保存の期限があるものは消せない
  'files/delete': async (c, b) => {
    const who = await whoIs(c, b);
    if (who.kind !== 'staff' || !rolesOf(who.me).includes('manager')) fail('forbidden', '教室管理者だけが消せます', 403);
    const f = await c.db.prepare('select * from files where id = ?').bind(String(b.id || '')).first();
    if (!f || f.status === 'deleted') fail('notFound', 'ファイルが見つかりません', 404);
    if (f.retainUntil && f.retainUntil > iso(c.now).slice(0, 10)) fail('retained', `${f.retainUntil} までは消せません（お金の書類は7年残します）`, 409);
    if (c.env.FILES) await c.env.FILES.delete(key(f.id));
    await c.db.prepare("update files set status = 'deleted', deletedAt = ?, deletedBy = ?, updatedAt = ? where id = ?").bind(iso(c.now), 'staff:' + who.me.id, iso(c.now), f.id).run();
    await audit(c, 'fileDelete', f.id, { category: f.category, name: f.name });
    return {};
  },
};

// 毎日: 送られなかった行（1日たった pending）と、切れた鍵を片づける
export async function cleanupFiles(c) {
  const day = new Date(c.now - 86400e3).toISOString();
  const stale = (await c.db.prepare("select id from files where status = 'pending' and createdAt < ?").bind(day).all()).results;
  if (stale.length) {
    const ids = stale.map(r => r.id), q = `(${ids.map(() => '?').join(', ')})`;
    await c.db.batch([c.db.prepare(`delete from fileTokens where fileId in ${q}`).bind(...ids), c.db.prepare(`delete from examFiles where fileId in ${q}`).bind(...ids), c.db.prepare(`delete from files where id in ${q}`).bind(...ids)]);
  }
  await c.db.prepare('delete from fileTokens where expiresAt < ?').bind(day).run();
  return { removed: stale.length };
}
