// 今の画面（/hogosha/・/yoyaku/・/kanri/）から、新しい画面への案内（作り直し v2 の9段目）。
// API の疎通確認（health）の cutover.live を見て、切り替えたあとだけ動く。切り替える前は何もしない。
// - 保護者ページ（/hogosha/、/yoyaku/#family）→ /family/
// - 生徒のマイページ（/yoyaku/?k=…）→ /student/?k=…（鍵はそのまま。端末に覚えている鍵も使う）
// - 管理画面（/kanri/）は、1か月ほど読むだけで使うので移さず、上に案内を出す
(function () {
  var API = 'https://stepwise-api.stepwise-edu.workers.dev/';
  function ls(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (h) {
    if (!h || !h.cutover || !h.cutover.live) return;
    var p = location.pathname;
    if (p.indexOf('/hogosha') === 0) { location.replace('/family/'); return; }
    if (p.indexOf('/yoyaku') === 0) {
      if (location.hash.indexOf('#family') === 0) { location.replace('/family/'); return; }
      var k = new URLSearchParams(location.search).get('k') || ls('sw_k');
      location.replace('/student/' + (k ? '?k=' + encodeURIComponent(k) : ''));
      return;
    }
    if (p.indexOf('/kanri') === 0) {
      var bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#fff3c4;color:#5a4300;padding:10px 14px;font-size:14px;text-align:center;border-bottom:1px solid #e8d48a';
      bar.innerHTML = '新しい管理画面に切り替えました。この画面は<strong>読むだけ</strong>です（変更はできません）。 <a href="/staff/" style="color:#0717a8;font-weight:700">新しい管理画面へ</a>';
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }).catch(function () {});
})();
