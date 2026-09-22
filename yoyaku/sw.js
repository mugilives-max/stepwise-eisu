// 通知を受け取って表示するための小さな常駐プログラム（サービスワーカー）。
//
// 本文は端末の鍵で暗号化されて届くので、中継する配信サービスは中身を読めない。
// ここで初めて中身が開かれ、端末の通知として表示される。
//
// 置き場所がそのまま守備範囲になるため、生徒ページと保護者ページに 1 つずつ置く
// （/yoyaku/sw.js と /hogosha/sw.js。中身は同じ）。
//
// 画面の中身は保存しない。保存すると、端末に古い予定や他人の予定が残りうるため。

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var notice = { title: 'ステップワイズ', body: '新しいお知らせがあります', url: '/', tag: 'stepwise' };
  try {
    if (event.data) {
      var parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        if (parsed.title) notice.title = String(parsed.title);
        if (parsed.body) notice.body = String(parsed.body);
        if (parsed.url) notice.url = String(parsed.url);
        if (parsed.tag) notice.tag = String(parsed.tag);
      }
    }
  } catch (e) { /* 読めなくても、お知らせがあることだけは伝える */ }

  event.waitUntil(self.registration.showNotification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    icon: '/yoyaku/icon-192.png',
    badge: '/yoyaku/icon-192.png',
    lang: 'ja',
    data: { url: notice.url },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // すでに開いているページがあれば、それを前に出す（同じ画面を二重に開かない）
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && 'focus' in list[i]) {
        if ('navigate' in list[i]) { try { list[i].navigate(url); } catch (e) {} }
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
