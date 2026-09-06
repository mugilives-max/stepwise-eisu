# MCP(ChatGPT / Codex 連携)運用手順

最終更新: 2026-09-07。設計の経緯は [MCP_DESIGN.md](MCP_DESIGN.md)、システム全体は [SYSTEM.md](SYSTEM.md)。
このファイルは「どこに何があり、止め方・直し方・更新の仕方」をまとめた運用用のメモです。

## 1. 構成と置き場所

```
ChatGPT(Chat/Work)  ─OAuth(パスフレーズ)─►  Cloudflare Workers "stepwise-mcp"  ─mcpKey─►  GAS(/exec)  ─►  スプレッドシート
Codex(このPC)       ─stdio────────────►  PC 内の同じコード(dist/stdio.js) ─mcpKey─►  GAS(/exec)
```

| もの | 場所 | 備考 |
|---|---|---|
| MCP サーバーのコード | PC: `C:\Users\mugir\dev\stepwise-mcp`(git 管理。GitHub の private リポジトリは未作成) | `src/tools.ts` ツール定義、`src/stdio.ts` Codex 用入口、`src/worker.ts` Cloudflare 用入口、`test/` 動作確認スクリプト |
| リモート版(ChatGPT が接続する先) | Cloudflare Workers。URL `https://stepwise-mcp.stepwise-edu.workers.dev/mcp` | Cloudflare アカウント: mugilives@gmail.com(Account ID 51b3ef02…)。Worker 名 `stepwise-mcp`、workers.dev サブドメイン `stepwise-edu`、KV `OAUTH_KV`(OAuth のトークン保存用) |
| Cloudflare の Secret(3つ) | Cloudflare 側にのみ保存。表示不可 | `STEPWISE_GAS_URL`(GAS の /exec URL)、`STEPWISE_MCP_KEY`(GAS 側の MCP_KEY と同じ値)、`MCP_LOGIN_PASSWORD`(ChatGPT 接続時のパスフレーズ。先生だけが知る) |
| PC 側の設定 | `C:\Users\mugir\dev\stepwise-mcp\.env`(gitignore 済み) | `STEPWISE_GAS_URL`、`STEPWISE_MCP_KEY`、`STEPWISE_CLIENT=codex` |
| GAS 側 | Apps Script プロジェクト「ステップワイズ予約システム」の Script Properties `MCP_KEY` と、`Code.gs` の `mcpEntry_` 以下 | 許可 op は `MCP_READ_OPS` / `MCP_WRITE_OPS` のホワイトリスト |
| 呼び出し記録 | スプレッドシート「ステップワイズ予約システム」の `mcpLog` シート | time / requestId / client / op / target / params / result / ms |
| ChatGPT 側の登録 | ChatGPT の 設定 → プラグイン → 開発者モード → 「Stepwise」 | 2026-09-07 登録済み(認証 OAuth) |
| Codex 側の登録 | `C:\Users\mugir\.codex\config.toml` の `[mcp_servers.stepwise]` | `node C:\Users\mugir\dev\stepwise-mcp\dist\stdio.js` を起動する設定 |

## 2. いま使える機能(閲覧のみ)

find_student(生徒検索) / get_schedule(期間の予約状況) / get_student(カルテ) / get_pending_actions(未処理の対応) / get_billing_summary(月の実施回数と請求予定) / get_teacher_off(先生の休み) / get_student_wishes(生徒の希望)。
予約の作成・変更・実施記録・請求の登録は **できません**(管理画面から行う)。返却値には専用リンクコード・メールアドレス・トークン・Meet URL を含めません。

## 3. 緊急停止と再開

| したいこと | 手順 |
|---|---|
| **今すぐ全部止める**(ChatGPT・Codex とも) | Apps Script エディタで関数 `mcpDisable` を実行(Script Properties の MCP_KEY を削除)。以後、MCP からの呼び出しは全て「MCP キーが正しくありません」で拒否される。管理画面・生徒ページには影響なし |
| 再開する / キーを作り直す | エディタで `mcpRotateKey` を実行 → 実行ログに新しいキーが1回だけ表示される → PC の `.env` の `STEPWISE_MCP_KEY` を書き換え、Cloudflare にも `npx wrangler secret put STEPWISE_MCP_KEY` で登録(下記) |
| ChatGPT だけ止める | ChatGPT の プラグイン設定で Stepwise を無効化または削除。あるいは Cloudflare のダッシュボードで Worker を無効化 |
| ChatGPT の接続をやり直させる | パスフレーズを変える(`npx wrangler secret put MCP_LOGIN_PASSWORD`)。既存のトークンは有効期限(8時間)で切れ、次回から新しいパスフレーズが必要になる |

## 4. よくある作業(PowerShell、`cd C:\Users\mugir\dev\stepwise-mcp` してから)

```powershell
npx wrangler whoami                         # Cloudflare にログインできているか
npx wrangler login                          # ログインが切れていたら(ブラウザで Allow)
npx wrangler secret list                    # Secret の名前一覧(値は見えない)
npx wrangler secret put MCP_LOGIN_PASSWORD  # パスフレーズを変える(入力は表示されない)
npx wrangler secret put STEPWISE_MCP_KEY    # GAS 側でキーを作り直したとき
npx wrangler deploy                         # コードを変えたあとの再配置
npx wrangler tail                           # 本番のログをリアルタイムで見る(Ctrl+C で終了)
npm run build                               # Codex 用(dist/)を作り直す。コードを変えたら必ず
node test/smoke.mjs                         # GAS の MCP 入口を直接確認
node test/client.mjs                        # Codex と同じ stdio 経由で7ツールを確認
$env:BASE="https://stepwise-mcp.stepwise-edu.workers.dev"; node test/oauth-flow.mjs   # 本番のOAuth 動作確認(パスフレーズなしの範囲)
```

## 5. ツールを追加・変更する手順

1. `src/tools.ts`(ツール定義)を編集。GAS 側に新しい op が必要なら `stepwise-eisu/gas/Code.gs` の `MCP_READ_OPS`/`MCP_WRITE_OPS` と `mcpDispatch_` に追加し、GAS を新バージョンでデプロイ。
2. `npm run build` → `node test/client.mjs` で確認(Codex 用はこれで反映。Codex は再起動)。
3. `npx wrangler deploy`(ChatGPT 用に反映。ChatGPT 側の再登録は不要)。
4. `stepwise-eisu/docs/MCP_DESIGN.md` の段階表と、必要ならこのファイルを更新。

更新系ツールを足すときの約束(設計書より): dry_run → 確認トークン → 実行の2段階、`request_id` で冪等化、`MCP_WRITE_SCOPE=test` でまずテスト生徒のみ、返却値に秘密情報を含めない。

## 6. トラブルシューティング

| 症状 | 見るところ |
|---|---|
| ChatGPT で「認証に失敗」「接続できない」 | `https://stepwise-mcp.stepwise-edu.workers.dev/` をブラウザで開いて説明ページが出るか。出なければ Cloudflare 側(`npx wrangler tail`、ダッシュボード)。出るなら ChatGPT で Stepwise を一度削除して作り直す |
| ログイン画面で「パスフレーズがちがいます」 | 10分に10回の制限あり。忘れたら `npx wrangler secret put MCP_LOGIN_PASSWORD` で新しく設定 |
| ツールが「MCP キーが正しくありません」 | GAS 側でキーが変わった/消えた。`mcpRotateKey` → `.env` と Cloudflare Secret を更新 |
| ツールが「この操作は MCP から実行できません」 | その op がホワイトリストに無い。設計どおり(高リスク操作は意図的に不可) |
| 応答が遅い(30秒前後) | GAS のコールドスタート。1回再試行で通ることが多い(サーバーが自動で1回再試行する) |
| Codex 側で stepwise が起動しない | `npm run build` 済みか、`.env` があるか、`node dist/stdio.js` を手で起動してエラーを見る |
| `wrangler deploy` で「subdomain を登録」と聞かれる | 初回のみ。PowerShell で対話的に `y` と答える(自動実行では進まない) |

## 7. 費用・上限

Cloudflare Workers 無料枠(1日10万リクエスト)、KV 無料枠、GAS 無料。個人利用の規模では超えない。GAS の MailApp は1日100通の上限があるが MCP は現状メールを送らない。
