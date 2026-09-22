// 疎通確認。GAS の doGet と同じ形。release は移行の段階が分かる文字列にする。
export const RELEASE = "2026-09-22-lesson-record-outline";

export async function health(env) {
  const out = { ok: true, service: "stepwise-api", release: RELEASE };
  try {
    const row = await env.DB.prepare("select count(*) as n from sqlite_master where type='table'").first();
    out.tables = row ? Number(row.n) : 0;
  } catch (e) {
    out.ok = false;
    out.error = "D1 に接続できません";
  }
  return out;
}
