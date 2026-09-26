// 書き込みの処理。GAS の doPost をそのまま D1 の上で動かし、変わった表を D1 に反映する。
//
// 流れ（1 リクエスト）
//   1. 台帳の版番号と全表を読む
//   2. GAS のコードを実行する（台帳は手元の入れ物に書かれる。メール・カレンダーは控えに溜まる）
//   3. 触った表を D1 に反映する。版番号が読んだときと違えば反映せず 1 からやり直す（最大 3 回）
//      → Apps Script の全体ロックの置き換え。読んでから書くまでの割り込みを検出する
//   4. 応答を返す。そのあと（ctx.waitUntil）で控えの付随処理を Apps Script に頼み、
//      カレンダーの本物の予定 ID を書き戻す
//
// 保護者のパスワード検証（PBKDF2 60万回）は純 JS だと 1.2 秒かかるので、同じ結果を出す
// node:crypto を優先し、本番の上限に当たった場合はGASへ計算だけを依頼する（60万回を維持）。
import { parentCryptoSession } from '../lib/parent-crypto.mjs';
import { books } from '../lib/sheet-view.mjs';
import { createServices } from '../lib/gas-services.mjs';
import { normalizeCell, quoteIdent, VIEW_SHEETS } from '../lib/import.mjs';
import { createGas } from './generated/gas.mjs';
import { createRuntime } from './read.mjs';
import { TABLE_COLUMNS, TABLE_SCHEMA } from './generated/schema.mjs';

const MAX_ATTEMPTS = 3;

export class LedgerConflict extends Error {}

export async function takeNaturalScheduleQuota(db, scope, limit) {
  const cutoff = new Date(Date.now() - 3600000).toISOString(), now = new Date().toISOString();
  await db.prepare('delete from _nl_usage where createdAt < ?').bind(cutoff).run();
  const inserted = await db.prepare('insert into _nl_usage (scope, createdAt) select ?, ? where (select count(*) from _nl_usage where scope = ? and createdAt >= ?) < ?')
    .bind(scope, now, scope, cutoff, limit).run();
  return Number(inserted.meta && inserted.meta.changes) === 1;
}

export async function runNaturalSchedule(result, env) {
  if (!result || result.errorCode !== 'nlNeedsWorker') return result;
  if (!env.ANTHROPIC_API_KEY) return { error: '文章解析のAPI設定を確認してください', errorCode: 'notConfigured' };
  const proxy = result.nlProxy || {}, scope = String(proxy.rateScope || ''), limit = Math.max(1, Math.min(60, Number(proxy.rateLimit) || 20));
  if (!scope || !(await takeNaturalScheduleQuota(env.DB, scope, limit))) return { error: '文章からの読み取りは1時間に' + limit + '回までです。しばらくしてからお試しください', errorCode: 'rateLimited' };
  let response, body;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(proxy.payload || {}), signal: AbortSignal.timeout(30000),
    });
    body = await response.json().catch(() => ({}));
  } catch (e) {
    return { error: '文章を読み取れませんでした。しばらくしてからもう一度お試しください', errorCode: 'upstream' };
  }
  if (!response.ok) {
    if (response.status === 429 || response.status === 529) return { error: '読み取りが混み合っています。少し待ってからもう一度お試しください', errorCode: 'upstream' };
    return { error: '文章を読み取れませんでした。しばらくしてからもう一度お試しください', errorCode: 'upstream' };
  }
  const block = (body.content || []).find(c => c && c.type === 'tool_use' && c.name === 'propose_schedule');
  if (!block) return { error: '文章を読み取れませんでした。内容を少し具体的にしてもう一度お試しください', errorCode: 'upstream' };
  const gas = await createRuntime(env), today = String(proxy.today || ''), context = proxy.context || {};
  const normalized = proxy.teacher === true ? gas.nlNormalizeTeacher_(block.input, today, context) : gas.nlNormalize_(block.input, today);
  return { ok: true, items: normalized.items, questions: normalized.questions, summary: normalized.summary, today };
}

// 台帳に入らない設定値。読み取りと同じ + 書き込みで要るもの
function propertiesFor(env) {
  return {
    ANTHROPIC_API_KEY: env.NL_ENABLED === '1' ? 'configured-in-gas' : '',
    PLAN_LINES_MIGRATED: 'worker-owned',
    // MCP からの書き込みは Worker 経由になる。鍵は secret で渡す（未設定なら MCP は使えない）
    MCP_KEY: env.MCP_KEY || '',
  };
}

async function currentVersion(db) {
  const row = await db.prepare('select version from _ledger where id = 1').first();
  return row ? Number(row.version) : 0;
}

// 触った表を、読んだときの版番号を条件に反映する（1 つのまとめ書き＝取り消しも一括）
async function flush(db, view, touched, version) {
  const now = new Date().toISOString();
  const statements = [
    // 版が違えば CHECK で落ち、このまとめ書きぜんぶが取り消される
    db.prepare('insert into _guard (x) select 1 where (select version from _ledger where id = 1) <> ?').bind(version),
    db.prepare('update _ledger set version = version + 1 where id = 1'),
  ];
  for (const table of touched) {
    if (VIEW_SHEETS.includes(table)) continue;
    const columns = TABLE_SCHEMA[table];
    if (!columns) throw new Error('D1 にこのシートに対応する表がありません: ' + table);
    const values = view.app[table] || view.ledger[table] || [];
    const headers = (values[0] || []).map(String);
    const byName = new Map(columns.map(c => [c.name, c]));
    // シートにあって D1 に無い列は入れない（見出しが増えたら移行の見直しが要る）
    const used = [];
    headers.forEach((h, i) => { const col = byName.get(h); if (h !== '' && col) used.push({ index: i, column: col }); });
    if (!used.length) throw new Error('取り込める列がありません: ' + table);

    const target = used.map(u => u.column.name).concat(['_syncedAt', '_sheetRow']);
    const sql = `INSERT INTO ${quoteIdent(table)} (${target.map(quoteIdent).join(', ')}) VALUES (${target.map(() => '?').join(', ')})`;
    statements.push(db.prepare(`delete from ${quoteIdent(table)}`));
    values.slice(1).forEach((row, i) => {
      const cells = used.map(u => normalizeCell(row[u.index], u.column));
      statements.push(db.prepare(sql).bind(...cells, now, i + 2));
    });
  }
  try {
    await db.batch(statements);
  } catch (e) {
    if (/CHECK constraint failed/i.test(String((e && e.message) || e))) throw new LedgerConflict('台帳が他の操作で更新されました');
    throw e;
  }
}

/**
 * 書き込みを 1 件処理する。戻り値は { result, effects }。result は GAS と同じ形。
 */
export async function runWrite(body, env, options = {}) {
  let last = null;
  const crypto = parentCryptoSession(env, options.parentCrypto);
  // Request-local secure entropy is replayed only for discarded attempts.
  // Registration/reset must keep the freshly generated salt while the KDF is
  // awaited. Nothing is reused across HTTP requests or successful commits.
  const uuids = [];
  let computations = 0, attempt = 1;
  while (attempt <= MAX_ATTEMPTS) {
    const version = await currentVersion(env.DB);
    const view = await books(env.DB, TABLE_COLUMNS);
    const services = createServices({ books: view, properties: propertiesFor(env), now: options.now ?? null, mutable: true, effects: true });
    const randomUuid = services.Utilities.getUuid;
    let uuidIndex = 0;
    services.Utilities.getUuid = () => uuids[uuidIndex++] ||= randomUuid();
    const gas = createGas(services);
    gas.StepwiseParentCrypto = crypto.crypto;
    const result = options.monthlyBilling === true ? gas.familyCloseMonths_() : JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());

    if (crypto.pending) {
      // Nothing from this run (including failures, new IDs or queued mail) is
      // persisted. The next run reads fresh D1 state and rechecks lockouts,
      // password changes, expired challenges and concurrent account changes.
      if (++computations > MAX_ATTEMPTS) throw Error('Password computation changed repeatedly');
      await crypto.resolve();
      continue;
    }

    if (!services._touched.size) return { result, effects: services._effects, version, attempts: attempt };
    try {
      await flush(env.DB, view, services._touched, version);
      return { result, effects: services._effects, version: version + 1, attempts: attempt };
    } catch (e) {
      if (!(e instanceof LedgerConflict)) throw e;
      last = e;
      attempt++;
    }
  }
  return { result: { error: '他の操作と重なりました。もう一度お試しください', errorCode: 'conflict' }, effects: [], attempts: MAX_ATTEMPTS, conflict: String(last && last.message) };
}

// ---- 付随処理（メール・カレンダー）を Apps Script に頼む ----

export async function recordEffects(db, effects) {
  if (!effects.length) return [];
  const now = new Date().toISOString();
  const rows = await db.batch(effects.map(e => db.prepare('insert into _effects (createdAt, kind, payload) values (?, ?, ?)').bind(now, e.kind, JSON.stringify(e))));
  return rows.map(r => Number(r.meta && r.meta.last_row_id) || 0);
}

/**
 * 控えた付随処理を Apps Script へ送り、カレンダーの本物の ID を書き戻す。
 * 応答を返したあとに ctx.waitUntil で呼ぶ。失敗しても利用者の操作は成功したまま。
 */
export async function deliverEffects(env, effects, ids) {
  if (!effects.length) return { sent: 0 };
  if (!env.GAS_URL || !env.SYNC_KEY) return { sent: 0, skipped: 'GAS_URL / SYNC_KEY が未設定' };
  let payload = null;
  let error = '';
  try {
    const res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'effects', key: env.SYNC_KEY, items: effects }),
      redirect: 'follow',
    });
    payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.error) error = (payload && payload.error) || ('HTTP ' + res.status);
  } catch (e) {
    error = String((e && e.message) || e);
  }
  const now = new Date().toISOString();
  const status = error ? 'failed' : 'sent';
  if (ids.length) {
    await env.DB.batch(ids.map(id => env.DB.prepare('update _effects set status = ?, attempts = attempts + 1, error = ?, sentAt = ? where id = ?').bind(status, error.slice(0, 300), error ? '' : now, id)));
  }
  // カレンダーの仮 ID → 本物の ID・Meet の URL
  // 台帳には iCalUID の形（<marker>@google.com）で入っている。Apps Script が返す marker は
  // 素の ID なので、どちらの形でも当たるように照合する（片方だけだと書き戻しが空振りする）
  const writebacks = (payload && Array.isArray(payload.writebacks)) ? payload.writebacks : [];
  if (writebacks.length) {
    // meetUrl は「取れたときだけ」書く。題名だけを直した書き換えの応答で、
    // すでに発行済みの Meet を消してしまわないようにする
    await env.DB.batch(writebacks.map(w => env.DB
      .prepare("update slots set eventId = ?, meetUrl = case when ? <> '' then ? else meetUrl end where eventId = ? or eventId = ? || '@google.com'")
      .bind(String(w.eventId || ''), String(w.meetUrl || ''), String(w.meetUrl || ''), String(w.marker), String(w.marker))));
  }
  return { sent: error ? 0 : effects.length, error, writebacks: writebacks.length };
}

// ---- Meet の取り直し ----
//
// オンライン授業の Meet は Google 側で少し遅れて発行される。台帳は待たずに確定し、
// URL は付随処理が書き戻す。その書き戻しが間に合わなかった授業をここで拾う。
// 定期実行で探し回るのではなく、画面が読みに来たときに合わせて取り直す
// （誰も見ていないなら急ぐ必要はない）。

const MEET_RETRY_MS = 120000; // 同じ予定を立て続けに頼まない

/** URL がまだ無いオンライン授業について、Apps Script に Meet を取り直してもらう。 */
export async function backfillMeet(env, limit = 5) {
  if (!env.GAS_URL || !env.SYNC_KEY) return { asked: 0 };
  const since = new Date(Date.now() - MEET_RETRY_MS).toISOString();
  const rows = await env.DB.prepare(
    `select s.eventId as eventId from slots s
      where s.deliveryMode = 'online' and s.status = 'booked'
        and s.eventId <> '' and (s.meetUrl is null or s.meetUrl = '')
        and not exists (select 1 from _effects e
                         where e.kind = 'calendarMeet' and e.createdAt > ?
                           and e.payload like '%' || s.eventId || '%')
      limit ?`).bind(since, limit).all();
  const wanted = (rows.results || []).map(r => ({ kind: 'calendarMeet', eventId: String(r.eventId) }));
  if (!wanted.length) return { asked: 0 };
  const ids = await recordEffects(env.DB, wanted);
  await deliverEffects(env, wanted, ids);
  return { asked: wanted.length };
}
