# gas-effects — v2 の送信だけをする独立 Apps Script

2026-10-10 の決定（Kura の issues/stepwise-v2-google-relay.md、本人「推しの通りで」）。v2 のメールとカレンダー（Meet）は、旧システムのシートに紐づいた Apps Script（`gas/`）に Worker が頼んでいた。旧画面と旧 MCP を止める 11 月に、ここにある小さな独立スクリプトへ差し替え、旧シートと `gas/` を片づける。

- `Code.gs`：`gas/Sync.gs` の effectsOp_ とその下だけ。シートは使わない。設定は Script Properties（`WORKER_SYNC_KEY`、`CALENDAR_SYNC`）。
- `appsscript.json`：Calendar の高度なサービス、必要な権限、ウェブアプリの公開の形。

## 差し替えの手順（11/4〜11/8、旧画面を止める手順書と一緒に）

本人がすること（Google のログインが要る。10〜15 分）：

1. https://script.google.com/home で「新しいプロジェクト」。名前を `stepwise-effects` にする。
2. エディタの「プロジェクトの設定」で「appsscript.json をエディタで表示」を on にし、`Code.gs` と `appsscript.json` の中身をこのフォルダのものに置き換える（clasp を使うなら `clasp create --type standalone` → `clasp push`）。
3. 「プロジェクトの設定」→「スクリプト プロパティ」に `WORKER_SYNC_KEY` を足す。値は Worker の `SYNC_KEY` と同じ（1Password など本人の手元から。チャットや文書に書かない）。
4. エディタで関数 `authorize` を選んで実行し、メールとカレンダーの権限に同意する。
5. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、実行するユーザー「自分」、アクセス「全員」→ デプロイ。出てきた URL（`https://script.google.com/macros/s/…/exec`）を控える。

AI がすること（本人から URL を受け取ったあと）：

6. Worker の `GAS_URL` をその URL にする：`cd stepwise-kobetsu && npx wrangler secret put GAS_URL`（URL は秘密ではないが、Secret の置き場をそのまま使う）。`SYNC_KEY` は変えない。
7. スタッフ画面の 設定 → 送信の記録と控え → 「テスト送信」で、代表あてにメールが 1 通届くことを確かめる。オンラインの授業を 1 つ登録して、カレンダーに Meet つきで入ることも確かめる。
8. 旧 Apps Script（シート「ステップワイズ予約システム」の中）の「デプロイを管理」で、ウェブアプリのデプロイをアーカイブする（Worker からの古い URL は使われなくなる）。
9. 旧シート 2 つ（予約システム・塾管理台帳）を xlsx に書き出して ドライブ `Kura/塾/旧システム/` に置き、元はゴミ箱へ。`gas/` フォルダと `docs/SYSTEM.md` の旧システムの節は、リポジトリの記録として残す（コードは動かさない）。

戻すとき：`GAS_URL` を旧の URL に戻すだけ（旧のデプロイをアーカイブしていなければ）。
