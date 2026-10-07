// 受講規約の版と同意の記録（migrations-v2/0016_terms.sql）。
// - 今の版は settings に置く（教室管理者が「設定 → 受講規約」で決める）。版が空なら、規約の同意は求めない
// - 保護者は保護者ページで全文を読んで同意する（family/terms/accept）。同意していないと、計画の承認はできない
// - 書面や LINE でもらった同意は、教室管理者が記録する（admin/families/terms）
// - 計画の行には、承認したときの規約の版を残す（billing.mjs）
import { fail, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { requireFamily } from './family.mjs';

const KEYS = { version: 'termsVersion', title: 'termsTitle', url: 'termsUrl', from: 'termsFrom', note: 'termsNote' };
export async function currentTerms(db) {
  const rows = (await db.prepare(`select key, value from settings where key in (${Object.values(KEYS).map(() => '?').join(',')})`).bind(...Object.values(KEYS)).all()).results;
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { version: v.termsVersion || '', title: v.termsTitle || '', url: v.termsUrl || '', from: v.termsFrom || '', note: v.termsNote || '' };
}
// 家族から見た規約: 今の版、同意した版、同意が要るか
export async function familyTerms(db, f) {
  const current = await currentTerms(db);
  const agreed = { version: f.termsVersion || '', at: f.termsAcceptedAt || '' };
  return { current, agreed, needs: !!current.version && agreed.version !== current.version };
}
export async function needsTerms(db, f) { return (await familyTerms(db, f)).needs; }
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

async function recordConsent(c, familyId, version, { at, via, actorKind, actorId, note }) {
  await c.db.batch([
    c.db.prepare('update families set termsVersion = ?, termsAcceptedAt = ?, updatedAt = ?, version = version + 1 where id = ?').bind(version, at, iso(c.now), familyId),
    c.db.prepare('insert into termsConsents (familyId, version, acceptedAt, via, actorKind, actorId, note) values (?, ?, ?, ?, ?, ?, ?)').bind(familyId, version, at, via, actorKind, actorId, note),
  ]);
}

export const termsRoutes = {
  'admin/terms/get': async (c, b) => {
    await requireStaff(c, b, 'manager');
    const terms = await currentTerms(c.db);
    const fam = (await c.db.prepare("select termsVersion, count(*) n from families where status <> 'stopped' and testOnly = 0 group by termsVersion").all()).results;
    const total = fam.reduce((n, r) => n + r.n, 0), agreed = terms.version ? fam.filter(r => r.termsVersion === terms.version).reduce((n, r) => n + r.n, 0) : 0;
    const history = (await c.db.prepare('select t.*, f.name familyName from termsConsents t join families f on f.id = t.familyId order by t.id desc limit 50').all()).results;
    return { terms, families: { total, agreed }, history: history.map(h => ({ id: h.id, familyName: h.familyName, version: h.version, acceptedAt: h.acceptedAt, via: h.via, actorKind: h.actorKind, note: h.note })) };
  },
  // 今の版を決める。版を変えると、全家族が「同意が要る」状態になる
  'admin/terms/set': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const version = String(b.version || '').trim(), title = String(b.title || '').trim(), url = String(b.url || '').trim(), from = String(b.from || '').trim(), note = String(b.note || '').trim();
    if (version.length > 40) fail('badVersion', '版は40文字以内にしてください');
    if (version && !title) fail('needTitle', '規約の名前を入れてください');
    if (title.length > 80 || note.length > 500) fail('tooLong', '名前は80文字、説明は500文字以内にしてください');
    if (url && !/^https:\/\/\S{1,500}$/.test(url)) fail('badUrl', '全文のリンクは https:// で始めてください');
    if (from && !validDate(from)) fail('badDate', '適用日は YYYY-MM-DD で入れてください');
    const now = iso(c.now);
    await c.db.batch(Object.entries({ version, title, url, from, note }).map(([k, v]) => c.db.prepare('insert into settings (key, value, updatedAt) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updatedAt = excluded.updatedAt').bind(KEYS[k], v, now)));
    await audit(c, 'termsSet', version, { title, from, by: me.id });
    return { terms: await currentTerms(c.db) };
  },
  // 書面・LINE などでもらった同意を記録する（教室管理者）
  'admin/families/terms': async (c, b) => {
    const me = await requireStaff(c, b, 'manager');
    const f = await c.db.prepare('select * from families where id = ?').bind(String(b.id || '')).first();
    if (!f) fail('notFound', '家族が見つかりません', 404);
    const terms = await currentTerms(c.db);
    const version = String(b.version || terms.version || '').trim(), date = String(b.date || ''), via = String(b.via || '').trim(), note = String(b.note || '').trim();
    if (!version) fail('needVersion', '規約の版がまだありません。設定の「受講規約」で決めてください');
    if (!validDate(date)) fail('badDate', '同意をもらった日を入れてください');
    if (!via || via.length > 40) fail('needVia', '同意の方法（書面・LINE など）を入れてください');
    if (note.length > 300) fail('tooLong', 'メモは300文字以内にしてください');
    await recordConsent(c, f.id, version, { at: date, via, actorKind: 'staff', actorId: me.id, note });
    await audit(c, 'termsConsentRecorded', f.id, { version, via, date });
    return { terms: await familyTerms(c.db, await c.db.prepare('select * from families where id = ?').bind(f.id).first()) };
  },
  'family/terms': async (c, b) => ({ terms: await familyTerms(c.db, await requireFamily(c, b)) }),
  // 保護者が全文を読んで同意する
  'family/terms/accept': async (c, b) => {
    const me = await requireFamily(c, b);
    const terms = await currentTerms(c.db);
    if (!terms.version) fail('noTerms', '今、同意をお願いしている規約はありません');
    if (String(b.version || '') !== terms.version) fail('staleVersion', '規約が新しくなっています。画面を更新して、もう一度確かめてください', 409);
    if (b.agree !== true) fail('needAgree', '全文を読んで「同意します」に印を付けてください');
    await recordConsent(c, me.id, terms.version, { at: iso(c.now), via: '保護者ページ', actorKind: 'family', actorId: me.id, note: '' });
    await audit(c, 'termsAccepted', me.id, { version: terms.version });
    return { terms: await familyTerms(c.db, await c.db.prepare('select * from families where id = ?').bind(me.id).first()) };
  },
};
