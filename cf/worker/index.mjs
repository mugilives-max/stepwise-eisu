// ステップワイズ API Worker（段階 A: 骨組みのみ）。
// 役割: 画面(GitHub Pages)と MCP から来る {action:...} の JSON を受け、D1 から答える。
// 段階 A では読み取り action をまだ実装していない。未実装の action は notImplemented を返し、
// 呼び出し側（assets/portal.js / kanri/index.html）が GAS へ回せるようにする。
// 本番の GAS と同じ入出力の形（{action,...} -> {ok|error,...}）を保つことが移行の安全弁。
import { health } from "./health.mjs";
import { handleRead, isReadAction } from "./read.mjs";
import { handleSync, syncStatus } from "./sync.mjs";
import { runWrite, recordEffects, deliverEffects, backfillMeet } from "./write.mjs";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function cors(env, request) {
  const allow = env.ALLOW_ORIGIN || "";
  const origin = request.headers.get("origin") || "";
  const value = allow === "*" ? "*" : allow && origin === allow ? allow : "";
  const h = { Vary: "Origin" };
  if (value) {
    h["Access-Control-Allow-Origin"] = value;
    h["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

const reply = (data, status, extra) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

export default {
  async fetch(request, env, ctx) {
    const head = cors(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: head });

    const url = new URL(request.url);
    // 生徒マイページは GET で読む（GAS の doGet と同じ）
    if (request.method === "GET" && url.searchParams.get("action") === "state") {
      try {
        return reply(await handleRead({ action: "state", k: url.searchParams.get("k") || "" }, env), 200, head);
      } catch (e) {
        return reply({ error: "読み取りに失敗しました", errorCode: "workerError" }, 500, head);
      }
    }
    // 開発時（AUTH_MODE=mock）だけの調査用。D1 は PRAGMA や内部の表を断るので、
    // どの問い合わせで止まるのかを順に試せるようにしてある。本番では出さない。
    if (request.method === "GET" && url.searchParams.get("debug") === "d1" && env.AUTH_MODE === "mock") {
      const steps = [];
      const run = async (label, fn) => { try { steps.push({ label, ok: true, value: await fn() }); } catch (e) { steps.push({ label, ok: false, error: String((e && e.message) || e).slice(0, 120) }); } };
      await run("表の一覧", async () => { const { results } = await env.DB.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'd1_%' and name not like '_cf_%'").all(); return results.length; });
      await run("台帳の読み込みms", async () => { const { createRuntime } = await import("./read.mjs"); const t0 = Date.now(); await createRuntime(env); return Date.now() - t0; });
      await run("読み取りms", async () => { const { createRuntime } = await import("./read.mjs"); const gas = await createRuntime(env); const t0 = Date.now(); gas.studentState_("no-such-code"); gas.kanriDashboard_(); return Date.now() - t0; });
      return reply({ steps }, 200, head);
    }
    // 疎通確認。GAS の doGet と同じ形を返す（release だけは worker 版と分かる文字列）。
    if (request.method === "GET") return reply({ ...(await health(env)), ...(await syncStatus(env)) }, 200, head);

    if (request.method !== "POST") return reply({ error: "POST only" }, 405, head);

    // GAS からの同期。鍵を知っている呼び出しだけ（画面からは来ない）。
    // Worker が正本になったら（WRITE_MODE=worker）受け付けない。受けると D1 を古い台帳で上書きしてしまう
    if (url.pathname === "/sync") {
      let payload;
      try { payload = await request.json(); } catch (e) { return reply({ error: "不正なリクエストです" }, 400, head); }
      if (env.WRITE_MODE === "worker") return reply({ error: "Worker が正本のため、Apps Script からの同期は受け付けません", errorCode: "ledgerOwnedByWorker" }, 409, head);
      const r = await handleSync(payload, env);
      return reply(r.payload, r.status, head);
    }
    // Apps Script からの中継（MCP など）。鍵を知っている呼び出しだけ。
    // MCP の鍵は Worker に置かず、中継のたびに Apps Script から渡してもらう
    if (url.pathname === "/proxy") {
      let payload;
      try { payload = await request.json(); } catch (e) { return reply({ error: "不正なリクエストです" }, 400, head); }
      const { syncAuthorized } = await import("./sync.mjs");
      if (!syncAuthorized(env, payload && payload.key)) return reply({ error: "鍵が正しくありません" }, 403, head);
      const inner = payload.request || {};
      const scoped = { ...env, MCP_KEY: String(payload.mcpKey || "") };
      try {
        const readOnly = await handleRead(inner, scoped);
        if (readOnly !== null) return reply(readOnly, 200, head);
        const done = await runWrite(inner, scoped);
        if (done.effects.length) {
          const ids = await recordEffects(env.DB, done.effects);
          const finish = deliverEffects(env, done.effects, ids);
          if (ctx && ctx.waitUntil) ctx.waitUntil(finish); else await finish;
        }
        return reply(done.result, 200, head);
      } catch (e) {
        return reply({ error: "中継の処理に失敗しました", errorCode: "workerError" }, 500, head);
      }
    }
    // 台帳ぜんぶの取り出し（Apps Script がシートへ写す・戻すため）。鍵を知っている呼び出しだけ
    if (url.pathname === "/export") {
      let payload;
      try { payload = await request.json(); } catch (e) { return reply({ error: "不正なリクエストです" }, 400, head); }
      const { syncAuthorized } = await import("./sync.mjs");
      if (!syncAuthorized(env, payload && payload.key)) return reply({ error: "鍵が正しくありません" }, 403, head);
      const { books } = await import("../lib/sheet-view.mjs");
      const { TABLE_COLUMNS } = await import("./generated/schema.mjs");
      return reply({ ok: true, exportedAt: new Date().toISOString(), ...(await books(env.DB, TABLE_COLUMNS)) }, 200, head);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return reply({ error: "不正なリクエストです" }, 400, head);
    }
    const action = String((body && body.action) || "");
    if (!action) return reply({ error: "action がありません" }, 400, head);

    // 開発時（AUTH_MODE=mock）だけ、失敗した問い合わせを控えて原因を追えるようにする。
    // 本番では中身を返さない（台帳の構造を外に出さないため）。
    const dev = env.AUTH_MODE === "mock";
    let lastSql = "";
    const scope = dev ? { ...env, DB: { ...env.DB, prepare: (sql) => { lastSql = sql; return env.DB.prepare(sql); }, batch: (s) => env.DB.batch(s) } } : env;

    // 書き込み。WRITE_MODE=worker のときだけ受ける（それまでは Apps Script が正本）。
    // 台帳を書いたら応答を返し、そのあとでメール・カレンダーを Apps Script に頼む。
    if (env.WRITE_MODE === "worker" && !isReadAction(body)) {
      try {
        const done = await runWrite(body, scope);
        if (done.effects.length) {
          const ids = await recordEffects(env.DB, done.effects);
          const finish = deliverEffects(env, done.effects, ids);
          if (ctx && ctx.waitUntil) ctx.waitUntil(finish); else await finish;
        }
        return reply(done.result, 200, head);
      } catch (e) {
        const detail = dev ? { detail: String((e && e.message) || e).slice(0, 200) } : {};
        return reply({ error: "処理に失敗しました。もう一度お試しください", errorCode: "workerError", ...detail }, 500, head);
      }
    }

    // 読み取りは D1 から返す。GAS のコードをそのまま動かすので応答は同じ（cf/worker/read.mjs）。
    // 書き込みと、まだ載せていない読み取りは 501 を返し、呼び出し側が GAS に回す。
    try {
      const res = await handleRead(body, scope);
      if (res !== null) {
        // 画面を返したあとで、URL がまだ無いオンライン授業の Meet を取り直す（待たせない）
        if (env.WRITE_MODE === "worker" && ctx && ctx.waitUntil) ctx.waitUntil(backfillMeet(env).catch(() => {}));
        return reply(res, 200, head);
      }
    } catch (e) {
      const detail = dev ? { detail: String((e && e.message) || e).slice(0, 200), sql: lastSql.slice(0, 200) } : {};
      return reply({ error: "読み取りに失敗しました", errorCode: "workerError", ...detail }, 500, head);
    }
    return reply({ error: "この操作はまだ Worker にありません", errorCode: "notImplemented", action: action }, 501, head);
  },
};
