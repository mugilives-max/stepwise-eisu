// 疎通確認。GAS の doGet と同じ形。release は移行の段階が分かる文字列にする。
export const RELEASE = "2026-10-03-v2-cancel-rate";

export async function health(env) {
  const out = { ok: true, service: "stepwise-api", release: RELEASE };
  try {
    const row = await env.DB.prepare("select count(*) as n from sqlite_master where type='table'").first();
    out.tables = row ? Number(row.n) : 0;
    // 切り替えの状態（今の画面が新しい画面へ案内するかを決める。assets/v2-move.js）
    const frozen = await env.DB.prepare("select value from config where key = 'v2CutoverAt'").first().catch(() => null);
    const live = env.DB2 ? await env.DB2.prepare("select value from settings where key = 'live'").first().catch(() => null) : null;
    out.cutover = { live: !!live && live.value === "1", oldReadOnlySince: frozen && frozen.value ? String(frozen.value) : "" };
  } catch (e) {
    out.ok = false;
    out.error = "D1 に接続できません";
  }
  return out;
}
