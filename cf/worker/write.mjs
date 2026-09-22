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
// node:crypto の実装に差し替える（133ms）。値が同じことはテストで突き合わせる。
import { pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { books } from '../lib/sheet-view.mjs';
import { createServices } from '../lib/gas-services.mjs';
import { normalizeCell, quoteIdent, VIEW_SHEETS } from '../lib/import.mjs';
import { createGas } from './generated/gas.mjs';
import { TABLE_COLUMNS, TABLE_SCHEMA } from './generated/schema.mjs';

const MAX_ATTEMPTS = 3;

export class LedgerConflict extends Error {}

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

// 保護者のパスワード検証を native に差し替える（同じ 16 進の値を返す）
function fastParentCrypto() {
  return { derive: (pass, salt, iterations) => pbkdf2Sync(Buffer.from(pass), Buffer.from(salt), iterations, 32, 'sha256').toString('hex') };
}

/**
 * 書き込みを 1 件処理する。戻り値は { result, effects }。result は GAS と同じ形。
 */
export async function runWrite(body, env, options = {}) {
  let last = null;
  let primedEvents = options.primedEvents || {};
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const version = await currentVersion(env.DB);
    const view = await books(env.DB, TABLE_COLUMNS);
    const services = createServices({ books: view, properties: propertiesFor(env), now: options.now ?? null, mutable: true, effects: true, primedEvents });
    const gas = createGas(services);
    gas.StepwiseParentCrypto = fastParentCrypto();
    const out = gas.doPost({ postData: { contents: JSON.stringify(body) } });
    const result = JSON.parse(out.getContent());

    // オンライン授業の Meet は Worker では作れない。Apps Script に先に作ってもらい、
    // その結果を持ってもう一度実行する（台帳にはまだ何も書いていないのでやり直せる）
    const pending = services._needsGoogle.filter(x => !primedEvents[x.id]);
    if (pending.length) {
      const made = await ensureEvents(env, pending);
      if (!made.ok) {
        return { result: { error: 'オンライン授業の会議室を用意できませんでした。もう一度お試しください', errorCode: 'calendarUnavailable' }, effects: [], attempts: attempt };
      }
      primedEvents = { ...primedEvents, ...made.events };
      continue; // 台帳は書かずにやり直す
    }

    if (!services._touched.size) return { result, effects: services._effects, version, attempts: attempt };
    try {
      await flush(env.DB, view, services._touched, version);
      return { result, effects: services._effects, version: version + 1, attempts: attempt };
    } catch (e) {
      if (!(e instanceof LedgerConflict)) throw e;
      last = e;
    }
  }
  return { result: { error: '他の操作と重なりました。もう一度お試しください', errorCode: 'conflict' }, effects: [], attempts: MAX_ATTEMPTS, conflict: String(last && last.message) };
}

// Apps Script に予定を作ってもらい、できた予定をそのまま受け取る（Meet を含む）
async function ensureEvents(env, wanted) {
  if (!env.GAS_URL || !env.SYNC_KEY) return { ok: false };
  try {
    const res = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'effects', key: env.SYNC_KEY, ensure: wanted }),
      redirect: 'follow',
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload || payload.error || !payload.events) return { ok: false };
    return { ok: true, events: payload.events };
  } catch (e) {
    return { ok: false };
  }
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
  const writebacks = (payload && Array.isArray(payload.writebacks)) ? payload.writebacks : [];
  if (writebacks.length) {
    await env.DB.batch(writebacks.map(w => env.DB.prepare('update slots set eventId = ?, meetUrl = ? where eventId = ?').bind(String(w.eventId || ''), String(w.meetUrl || ''), String(w.marker))));
  }
  return { sent: error ? 0 : effects.length, error, writebacks: writebacks.length };
}
