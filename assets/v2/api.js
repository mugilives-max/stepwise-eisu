// 作り直し（v2）の API を呼ぶ共通の道具。ログインのトークンは端末に保存し、本文の auth に入れて送る。
export const API = location.hostname === 'www.stepwise-education.jp' || location.hostname === 'stepwise-education.jp'
  ? 'https://stepwise-api.stepwise-edu.workers.dev/v2/'
  : (window.STEPWISE_V2_API || '/v2/'); // 手元の確認では同じ場所の /v2/ を使う

export function session(key) {
  return {
    get() { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
    set(v) { try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch {} },
  };
}

// 失敗は { ok:false, error:{code,message} } で返る。通信できなかったときも同じ形にそろえる
export async function call(route, body = {}, auth = '') {
  try {
    const res = await fetch(API + route, { method: 'POST', body: JSON.stringify(auth ? { ...body, auth } : body) });
    const data = await res.json().catch(() => null);
    return data || { ok: false, error: { code: 'server', message: '処理に失敗しました。もう一度お試しください' } };
  } catch {
    return { ok: false, error: { code: 'network', message: '通信できませんでした。電波の良いところでもう一度お試しください' } };
  }
}

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// 切り替えの状態（API の疎通確認 health の cutover.live）。切り替える前だけ「準備中」の案内を出すために使う。
// 分からないうち（読み込み中・通信できない）は、切り替えたあとと同じ扱い（案内を出さない）
let liveCache = null;
export function liveState(onChange) {
  if (liveCache) return liveCache;
  liveCache = { known: false, live: true };
  fetch(API.replace(/v2\/$/, ''), { cache: 'no-store' }).then(r => r.json()).then(h => {
    liveCache.known = true; liveCache.live = !!(h && h.cutover && h.cutover.live);
    if (onChange) onChange();
  }).catch(() => {});
  return liveCache;
}
