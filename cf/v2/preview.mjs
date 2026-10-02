// プレビュー: スタッフ（教室管理者）が、保護者ページ・生徒ページをその家族・生徒の目で見る。migrations-v2/0012_preview.sql
// - 鍵 pv2.…（1時間）を、保護者ページは auth、生徒ページは k の代わりに使う
// - 読むだけの操作（READS）以外は、index.mjs の入口ですべて断る（書き込み・メール・ログアウトも）
// - プレビューを始めたことは監査の記録に残す
import { fail, newToken, sha256Hex, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';

export const PREFIX = 'pv2.';
export const isPreviewToken = v => typeof v === 'string' && v.startsWith(PREFIX) && v.length <= 100;
// プレビューで通す操作（読むだけ）。files/link は成績票などを開く鍵を作るだけで、台帳は変えない
export const READS = new Set(['family/me', 'family/students', 'family/schedule', 'family/learning', 'family/money', 'family/grades',
  'student/me', 'student/schedule', 'student/learning', 'student/grades', 'files/link']);

// 鍵から、プレビューの相手（家族か生徒の行）を読む。kind が合わなければ null
export async function previewSubject(c, token, kind) {
  if (!isPreviewToken(token)) return null;
  const p = await c.db.prepare('select * from previewSessions where tokenHash = ?').bind(sha256Hex(token)).first();
  if (!p || p.kind !== kind || p.expiresAt <= iso(c.now)) return null;
  const row = await c.db.prepare(`select * from ${kind === 'family' ? 'families' : 'students'} where id = ?`).bind(p.subjectId).first();
  if (!row) return null;
  c.actor = { kind: 'staffPreview', id: p.staffId };
  c.preview = true;
  return row;
}

export const previewRoutes = {
  // プレビューを始める: { kind: 'family' | 'student', id } → 開く URL（同じサイトの /family/ か /student/）
  'admin/preview/start': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const kind = String(b.kind || ''), id = String(b.id || '');
    if (!['family', 'student'].includes(kind)) fail('badKind', '保護者ページか生徒ページかを選んでください');
    const row = await c.db.prepare(`select id from ${kind === 'family' ? 'families' : 'students'} where id = ?`).bind(id).first();
    if (!row) fail('notFound', kind === 'family' ? '家族が見つかりません' : '生徒が見つかりません', 404);
    const token = newToken('pv2'), now = iso(c.now);
    await c.db.batch([
      c.db.prepare('delete from previewSessions where expiresAt <= ?').bind(now),
      c.db.prepare('insert into previewSessions (tokenHash, staffId, kind, subjectId, expiresAt, createdAt) values (?, ?, ?, ?, ?, ?)').bind(sha256Hex(token), me.id, kind, id, iso(c.now + 3600e3), now),
    ]);
    await audit(c, 'previewStart', id, { kind });
    return { url: kind === 'family' ? '/family/#preview=' + encodeURIComponent(token) : '/student/?k=' + encodeURIComponent(token) };
  },
};
