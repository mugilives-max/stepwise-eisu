// メール・カレンダーの控え（v2 の effects 表）。応答を返したあとで Apps Script に頼む。
// 頼み方（action=effects、items の形）は今の仕組み（cf/worker/write.mjs の deliverEffects）と同じ。
// テスト用の家族・スタッフあて（testOnly）は実際には送らず、送らなかったことを記録する。
export async function recordEffects(db, items, now) {
  if (!items.length) return [];
  const at = new Date(now).toISOString();
  const rows = await db.batch(items.map(e => db.prepare('insert into effects (createdAt, kind, payload, status, error) values (?, ?, ?, ?, ?)')
    .bind(at, e.kind, JSON.stringify(e), e.testOnly ? 'dismissed' : 'pending', e.testOnly ? 'テスト用のため送らない' : '')));
  return rows.map((r, i) => ({ id: Number(r.meta && r.meta.last_row_id) || 0, item: items[i] })).filter(x => !x.item.testOnly);
}

export async function deliverEffects(env, db, queued, fetcher = fetch) {
  if (!queued.length) return { sent: 0 };
  if (!env.GAS_URL || !env.SYNC_KEY) return { sent: 0, skipped: 'GAS_URL / SYNC_KEY が未設定' };
  let error = '';
  try {
    const res = await fetcher(env.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ action: 'effects', key: env.SYNC_KEY, items: queued.map(q => { const { testOnly, ...item } = q.item; return item; }) }) });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.error) error = (payload && payload.error) || ('HTTP ' + res.status);
  } catch (e) { error = String((e && e.message) || e); }
  const at = new Date().toISOString();
  await db.batch(queued.map(q => db.prepare('update effects set status = ?, attempts = attempts + 1, error = ?, sentAt = ? where id = ?')
    .bind(error ? 'failed' : 'sent', error.slice(0, 300), error ? '' : at, q.id)));
  return { sent: error ? 0 : queued.length, error };
}
