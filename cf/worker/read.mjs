// 読み取りの処理。GAS のコードをそのまま動かし、シートの代わりに D1 を読む。
//
// 作り直していないので、返す JSON は GAS と同じ（並走テスト test/parity-*.test.cjs で確認する）。
// 書き込みは一切しない。書こうとする経路に入ったら cf/lib/gas-services.mjs が例外にする。
//
// doPost / doGet は通さない。あちらは実行のたびに排他を取り、ensureSchema_ から
// 一度きりの移行処理まで走らせる（＝読みながら書く）ため。ここでは必要な関数だけ直に呼ぶ。
import { books } from '../lib/sheet-view.mjs';
import { createServices } from '../lib/gas-services.mjs';
import { createGas } from './generated/gas.mjs';
import { TABLE_COLUMNS } from './generated/schema.mjs';

// 台帳に入らない設定値。読み取りに要るのはこれだけ。
function propertiesFor(env) {
  return {
    // 「文章で予定を登録」が使えるかどうかの判定にしか使わない。実際の鍵は GAS 側にしかなく、
    // Worker には置かない。ここには「設定済みかどうか」だけを持たせる。
    ANTHROPIC_API_KEY: env.NL_ENABLED === '1' ? 'configured-in-gas' : '',
    // 旧 plans から planLines への一度きりの移行を走らせないための印。
    // 走ると書き込みになるので、印が無いと読み取りの途中で落ちる（それが正しい）。
    PLAN_LINES_MIGRATED: 'worker-read-only',
  };
}

export async function createRuntime(env, options = {}) {
  const view = await books(env.DB, TABLE_COLUMNS);
  return createGas(createServices({ books: view, properties: propertiesFor(env), now: options.now ?? null }));
}

// 管理画面から読みに来る操作。書き込みを伴うものは載せない。
const ADMIN_READS = {
  state: gas => ({ ok: true, admin: gas.adminState_() }),
  kanriDashboard: gas => ({ ok: true, data: gas.kanriDashboard_() }),
  kanriStudent: (gas, req) => gas.kanriStudentOp_(req),
  billingPreview: (gas, req) => {
    const bp = gas.billingPreview_(String(req.studentId || ''), String(req.ym || ''));
    return bp.error ? bp : { ok: true, billing: bp };
  },
};

export function isReadAction(body) {
  const action = String((body && body.action) || '');
  if (action === 'state') return true;
  if (action === 'admin') return Object.prototype.hasOwnProperty.call(ADMIN_READS, String(body.op || ''));
  return false;
}

/**
 * 読み取りを 1 件処理する。戻り値は GAS と同じ形。
 * 対応していない操作は null を返す（呼び出し側が GAS に回す）。
 */
export async function handleRead(body, env, options = {}) {
  const action = String((body && body.action) || '');
  // 引き受けない操作は台帳を読む前に返す（読み込みは無駄になるので）
  if (!isReadAction(body)) return null;
  const started = Date.now();
  const gas = await createRuntime(env, options);

  // 生徒マイページ。専用リンクのコードだけで引く（GAS の doGet と同じ）
  if (action === 'state') return gas.studentState_(String(body.k || ''));

  const handler = ADMIN_READS[String(body.op || '')];

  // 先生のログインの確認。GAS と同じ判定を使う
  if (gas.authMode_() !== 'account' || !gas.tokenOk_(body.token)) {
    return { error: 'ログインし直してください', badAuth: true };
  }
  // 管理画面の呼び出しでは予約ページ用の全データを作らない（GAS の admin_ と同じ）
  gas.LITE_ = body.from === 'kanri' && body.view !== 'lessons';

  const res = handler(gas, body);
  if (res && typeof res === 'object') {
    res.ms = Date.now() - started;
    res.timings = { lockMs: 0, schemaMs: 0, operationMs: Date.now() - started };
  }
  return res;
}
