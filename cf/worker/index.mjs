// ステップワイズ API Worker（段階 A: 骨組みのみ）。
// 役割: 画面(GitHub Pages)と MCP から来る {action:...} の JSON を受け、D1 から答える。
// 段階 A では読み取り action をまだ実装していない。未実装の action は notImplemented を返し、
// 呼び出し側（assets/portal.js / kanri/index.html）が GAS へ回せるようにする。
// 本番の GAS と同じ入出力の形（{action,...} -> {ok|error,...}）を保つことが移行の安全弁。
import { health } from "./health.mjs";

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
  async fetch(request, env) {
    const head = cors(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: head });

    const url = new URL(request.url);
    // 疎通確認。GAS の doGet と同じ形を返す（release だけは worker 版と分かる文字列）。
    if (request.method === "GET") return reply(await health(env), 200, head);

    if (request.method !== "POST") return reply({ error: "POST only" }, 405, head);

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return reply({ error: "不正なリクエストです" }, 400, head);
    }
    const action = String((body && body.action) || "");
    if (!action) return reply({ error: "action がありません" }, 400, head);

    // 段階 B で読み取り action を足す。ここに載るまでは呼び出し側が GAS を使う。
    return reply({ error: "この操作はまだ Worker にありません", errorCode: "notImplemented", action: action }, 501, head);
  },
};
