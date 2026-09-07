# ステップワイズ個別指導 システム概要

最終更新: 2026-09-08 / 管理者: 麦倉優輔 (mugilives@gmail.com)

現行の構成・台帳・API・反映手順の正本。作業対象に関係する節を参照する。共通の制約と資料案内は [AGENTS.md](../AGENTS.md)、未完了事項は [FUTURE_WORK.md](FUTURE_WORK.md)。

## 1. 一言でいうと

- 画面(HTML)は **GitHub Pages**、ロジック(API)は **Google Apps Script**、データは **Google Drive のスプレッドシート2つ** にあります。
- 実生徒の業務データは2台帳、成績票などの原資料はDriveに保存する。復旧にはコード・GAS設定・原資料も必要なので、台帳のコピーだけでシステム全体のバックアップが完了したとは扱わない。

```
生徒・保護者のスマホ ──► https://www.stepwise-education.jp/yoyaku/ (マイページ)
先生のスマホ・PC   ──► https://www.stepwise-education.jp/kanri/  (管理画面, PWA)
        │  fetch(POST, JSON)
        ▼
Google Apps Script Web アプリ (/exec)  … gas/Code.gs が本体
        │
        ├─ スプレッドシート「ステップワイズ予約システム」 … 予定・生徒・設定
        ├─ スプレッドシート「塾管理台帳」                 … 台帳・成績・模試・入金・面談
        ├─ Google カレンダー(確定授業の写し)・Gmail(通知メール)
        └─ Drive フォルダ「ステップワイズ塾」              … 成績票PDF など元ファイル
```

## 2. データの置き場所

| 置き場所 | 何があるか | 備考 |
|---|---|---|
| GitHub `mugilives-max/stepwise-eisu`（public、main / root を Pages 配信） | `index.html` ホームページ、`yoyaku/index.html` 生徒マイページ、`kanri/index.html` 管理画面、`gas/Code.gs` サーバーコードの写し、`docs/` 文書 | 作業先は [AGENTS.md](../AGENTS.md)。公開確認は `?nc=適当な値` でキャッシュを避け、配信内容を照合する |
| Google Apps Script（予約システムに紐づくコンテナバインド） | 実行中のコード。WebアプリURL・デプロイIDは両HTMLの `API` 定数を参照 | [プロジェクト](https://script.google.com/home/projects/1vlfS4thMpRgV0WbHXZ8joFLzZBMmoROdopAJXK6JEIQWplokSgvgo619/edit)。Script IDはこのURLの `/projects/` と `/edit` の間。反映は6章 |
| Drive: スプレッドシート「ステップワイズ予約システム」 | 生徒一覧と専用リンクコード、授業枠、授業できない日、希望日程、共有予定、月の授業回数(計画)と保護者承認、宿題・持ち物、先生ログイン情報(ハッシュ)、操作ログ | 場所: マイドライブ/ステップワイズ塾/ |
| Drive: スプレッドシート「塾管理台帳」 | 生徒台帳、成績推移、模試、入金管理、面談記録 | 同上。ID は `Code.gs` の `LEDGER_ID` |
| [Drive フォルダ「ステップワイズ塾」](https://drive.google.com/drive/folders/1DbCfH9j8BDtFsbe6iXpsUyCu4YURkBVG) | `01_生徒/<生徒>/`(成績票PDFなど)、`02_契約・規約`、`03_教材`、`04_経理`、`99_アーカイブ` | Drive for Desktopのマウント先・稼働状態は環境により異なる。必要なら接続中のDriveから参照 |
| 生徒の端末 | ブラウザに専用リンク、表示キャッシュ、保護者セッションが残る | 業務データの正本ではない。認証情報の扱いは [PARENT_AUTH.md](PARENT_AUTH.md) |

## 3. スプレッドシートの中身

### 3-1. 「ステップワイズ予約システム」(アプリ用。列名は英語)

| シート | 列 | 意味 |
|---|---|---|
| config | key, value | 設定と先生のログイン情報。`passHash`/`passSalt`(パスワードのハッシュ)、`adminToken`/`adminTokenExp`(ログイン中トークン。1か所のみ有効)、`teacherEmail`、`calendarSync`、`emailNotify`、`reset*`(パスワード再設定コード)、`failCount`/`lockUntil` |
| parents | 列順・保存仕様は [PARENT_AUTH.md](PARENT_AUTH.md#認証と保存) | 生徒別の保護者認証（v45追加）。旧students.parentToken/parentExpは使用しない |
| students | id, name, active, email, code, rate30, monthly, parentToken, parentExp | 生徒。`code` が専用リンク(`/yoyaku/?k=code`)の鍵。`rate30` は30分単価、`monthly` は月謝(あれば定額)。`active=false` は停止中 |
| slots | id, date, start, min, status, studentId, done, eventId, meetUrl, subject, req | 授業枠。`status` は open(空き)/offered(案内中=承認待ち)/booked(確定)。`done=true` で実施済み。`eventId`/`meetUrl` はカレンダー連携。`req` は取消依頼のJSON |
| blocked | id, studentId, date, note, start, end | 生徒の「授業できない日」。start/end が空なら終日、入っていればその時間帯だけ |
| teacherOff | id, date, note, start, end | 先生の休み。1行=1日。start/end が空なら終日、入っていればその時間帯だけ。管理画面のホーム(日付タップ)か授業ページから登録。生徒にはメモを見せない |
| wishes | id, studentId, date, start, end, note, createdAt, kind | 生徒の希望日程。`kind` は want(この日時に授業をしたい)/ok(この時間帯のどこかで) |
| events | id, studentId, date, dateTo, title, createdAt, kind | 生徒が共有した予定(大会・見学など)。`kind=test` はテスト・模試(マイページでカウントダウン表示) |
| plans | id, studentId, ym, subject, count, status, proposedAt, approvedAt, approvedVia, memo | 月の授業回数(計画)。`ym` は `YYYY-MM` か `default`(毎月の既定)。`status` は draft/proposed/approved、`approvedVia` は parent(保護者ページで承認)/teacher(LINE・電話で承諾を先生が記録) |
| tasks | id, studentId, type, title, due, createdAt, createdBy, doneAt | 宿題・持ち物(やること)。生徒も先生も追加できる |
| log | time, message | 操作ログ(日本語1行) |
| mcpLog | time, requestId, client, op, target, params, result, ms | MCP(ChatGPT/Codex)からの呼び出し記録 |

### 3-2. 「塾管理台帳」(人が見る台帳。列名は日本語)

| シート | 列 |
|---|---|
| 生徒台帳 | 生徒ID, 氏名, ふりがな, 学年, 学校, 保護者名, 保護者連絡先, メール, 入塾日, 状態, 科目, 単価(30分), 月謝, 備考 |
| 成績推移 | 日付, 生徒ID, 氏名, テスト名, 科目, 点数, 満点, 偏差値, 順位, 備考(1行=1科目) |
| 模試 | 日付, 生徒ID, 氏名, 模試名, 回, 学年, 国語, 国語偏差値, 数学, 数学偏差値, 社会, 社会偏差値, 理科, 理科偏差値, 英語, 英語偏差値, 3教科, 3教科偏差値, 5教科, 5教科偏差値, 3教科順位, 5教科順位, 受験者数, 志望校判定(" / "区切り), 資料URL(成績票PDF。先生のみ表示), 備考(1行=1回分) |
| 入金管理 | 年月, 生徒ID, 氏名, 請求額, 請求日, 入金日, 入金方法, 状態, 備考 |
| 面談記録 | 日付, 生徒ID, 氏名, 相手, 方法, 内容, 次のアクション |

`生徒ID` は「ステップワイズ予約システム」students シートの `id` と同じ値で、2つのファイルをつないでいます。

構造変更では列名・列順・ID・行番号の参照を確認する。`config`、`slots`、`plans`、`students.code`、入金状態、ログ、Script Propertiesのキーは管理画面または対応API/専用関数から更新する。台帳の直接編集が必要な場合も、行番号で参照する処理（例: `kanriSetPaid_`）と既存データへの影響を確認してから行う。

## 4. 画面

| URL | 誰が | 中身 |
|---|---|---|
| `/yoyaku/?k=<code>` | 生徒(LINEで専用リンクを配布) | マイページ。タブ: ホーム(今月の授業・やること・予定表(見るだけ、先生の休みは出さない)・次の授業・授業登録の確定/再調整・今後の予定)/ 予定(予定表(先生の休みも表示)・予定管理: 授業の希望・予定の共有・授業できない日 / 授業登録 / 今後の予定)/ 成績(模試・成績推移)/ 授業の記録 / 保護者(パスワード制。今月の授業・お支払い・授業回数の承認) |
| `/kanri/` | 先生(メール+パスワードでログイン。PIN は廃止、再設定は登録メール宛の6桁コード) | ホーム(取消依頼・共有予定・希望、今日/今週、全体の予定表、生徒カード)/ 授業(案内フォーム・承認待ち・カレンダー・NG日・実施記録と請求文面)/ 生徒(追加・停止中)/ 生徒カルテ `#s=<id>`(予定表、基本情報、リンク設定、今月の授業と請求、月の授業回数と承認、成績推移、模試、今後の予定、履歴、入金、面談)/ 設定 |

保護者は先生と別の専用認証を使用する。利用の流れ・認証仕様は [PARENT_AUTH.md](PARENT_AUTH.md)。月間承認の本運用と契約条項の確定は認証実装とは別の課題。

## 5. API(Apps Script)

- 呼び出しは `POST /exec` に JSON。`action` で分岐。生徒側は `k`(専用リンクのコード)で本人確認、先生側は `action:"admin"` + `token`(ログイン時に発行)+ `op`。
- 生徒側 action: accept / decline / cancelReq / wish / unwish / wishMany / eventAdd / eventAddMany / eventDel / block / unblock / blockSet / taskAdd / taskDone / taskDel / grades。保護者actionと先生のコード発行opは [PARENT_AUTH.md API](PARENT_AUTH.md#api)。
- 先生側 op: state / offer / deleteSlot / unbook / toggleDone / finishOffered(返事がないまま日付が過ぎた案内を確定・実施済みにする) / addStudent / setEmail / setFee / newCode / addBlock / delBlock / addOff / delOff(先生の休み) / hideStudent / changePass / resolveCancel / delWish / delEvent / planSet / planPropose / planApproveTeacher / taskAdd / taskDone / taskDel / kanriDashboard / kanriStudent / kanriSaveProfile / kanriAddGrade / kanriAddExam / kanriAddPayment / kanriSetPaid / kanriAddMeeting / kanriDeleteRow / kanriSetActive / logout。ログイン前: login / setupAccount / resetRequest / resetConfirm
- 確定授業の取消は生徒からの「依頼」で先生が承認（締切は授業の24時間前 `CANCEL_DEADLINE_H`）。月の授業回数の事前承認は業務上の方針だが、案内・確定・請求APIが承認と回数上限を一律には強制していない。未解決事項は [FUTURE_WORK.md](FUTURE_WORK.md#月間承認と請求予約apiの整合)。
- エディタから手で実行する関数: `setup`(初回のシート作成)、`resetTeacherLogin`(先生ログイン初期化)、`kanriSelfTest`、`mcpRotateKey`(MCP 用キーの発行・更新)、`mcpDisable`(MCP 停止)。
- MCP 用の入口: `action:"admin"` + `mcpKey`(Script Properties の `MCP_KEY`)。実行できる op は `MCP_READ_OPS`(mcpPing / mcpStudents / mcpSchedule / mcpStudent / mcpPending / mcpBilling / mcpTeacherOff / mcpWishes)と `MCP_WRITE_OPS`(現在は空)のホワイトリストのみ。呼び出しは `mcpLog` シートに記録。返却値に専用リンクコード・メール・トークンは含めない。

## 6. 更新・デプロイ手順

1. Gitの差分と対象の本番版を確認し、変更範囲に応じて検証する。JS/GASは `npm run check`、認証変更は `npm test` と [認証の検証条件](PARENT_AUTH.md#今後の再反映時の順序と確認)。文書だけなら参照の整合確認でよい。
2. GASを変更する場合は、実稼働ソースを退避してローカル基準と比較する。データ移行・構造変更では対象台帳もコピーし、内容・構造を比較してから進める。`ensureSchema_` / `LEDGER_COLS` の自動追加任せにせず、既存列との互換性と準備手順を確認する。初期設定用 `setup()` を移行のために再実行しない。
3. Apps Scriptエディタに `gas/Code.gs` を反映・保存し、読み戻した全文を改行正規化後に照合する。「保存しています」等の表示だけで判断しない。一時検証関数は削除し、既存の「デプロイを管理」→鉛筆→「新バージョン」で公開する（既存URLを維持）。Codexでもブラウザ経由の反映を実施済み。`clasp` 導入は [未着手の課題](FUTURE_WORK.md#apps-script-の反映を自動化clasp)。
4. mainへ `git commit` → `git push origin main` でGitHub/Pagesを更新する。**新APIに依存する画面はGAS→HTMLの順**にし、旧画面との互換性も確認する。独立した画面・文書変更ではGASの再デプロイは不要。
5. Pagesのビルド完了と対象ファイルの公開内容を確認する。GAS更新時は `/exec` の応答と、変更機能のテスト生徒による疎通を確認する。通知・カレンダーを動かす検証は対象と設定を確認し、作成したテストデータを片付ける。

画面は対象コミットのrevert→pushで戻す。GASは既存デプロイの版を戻せるが、スキーマや認証の互換性を確認して選ぶ。コードの差し戻しと台帳の復旧は分け、無関係の授業・入金まで巻き戻さない。保護者認証の旧版復帰の制約は [戻し方](PARENT_AUTH.md#戻し方)。

## 7. 運用メモ

- 先生のログインは1か所のみ有効。別端末でログインすると前のログインは切れます。
- パスワードを忘れたら管理画面の「パスワードを忘れた」→ 登録メール(mugilives@gmail.com)に届く6桁コードで再設定。
- 通知メールはApps ScriptからGmailで送信し、確定授業はGoogleカレンダーにも作成する。案内・確定・取消承認・希望・取消依頼・パスワード再設定などは通知や予定変更を伴う。実行前に対象APIの副作用を確認する。MCPの閲覧も `mcpLog` に記録される。
- LINEで受けた生徒のNG日を代理登録するときは、`blocked` のメモに「LINE連絡(日付)」を残す。
- 台帳バックアップはDriveで2台帳をコピーする。個別移行の退避・照合記録は該当機能の文書に残す（認証は [PARENT_AUTH.md](PARENT_AUTH.md#今回の確認範囲)）。自動化・保管範囲は [FUTURE_WORK.md](FUTURE_WORK.md#バックアップの自動化)。

## 8. 別チャット・他のAIから参照するとき

- 共通入口は [AGENTS.md](../AGENTS.md)。GitHubの `docs/` を文書の正本とし、Driveの00〜04は対応する正本へのリンクにする。本文を二重保守しない。
- コードの実装は [gas/Code.gs](../gas/Code.gs)、画面は [kanri/index.html](../kanri/index.html) / [yoyaku/index.html](../yoyaku/index.html)。機能を変更するときは対象コードも確認する。
- [Driveの05引き継ぎ](https://drive.google.com/file/d/1N3KMqRqJAC6vT294lFhB1aQEHA3bIMmt/view)は2026-09-07の履歴。過去の編集手段（ClaudeのMonaco操作）、当時の環境やメモリの所在を調べる場合だけ参照する。そこでの「毎回読む順序」「Codexの反映未確認」「v44」「専用検証環境なし」は現行の指示・状態ではない。

## 8-2. 関連ドキュメント

- [MCP_DESIGN.md](MCP_DESIGN.md): ChatGPT / Codex から操作するための MCP サーバー設計と段階計画(2026-09-06〜)
- [MCP_OPERATIONS.md](MCP_OPERATIONS.md): **MCP の運用手順**(置き場所、緊急停止、キー・パスフレーズの変更、再配置、トラブル対応)
- [CONTRACT_CLAUSES_DRAFT.md](CONTRACT_CLAUSES_DRAFT.md): 契約書に追加する条項の下書き(保護者承認・保護者パスワード)
- [PARENT_AUTH.md](PARENT_AUTH.md): 保護者専用認証の実装と反映順序
- [REDESIGN_CURRENT_STATE.md](REDESIGN_CURRENT_STATE.md) / [REDESIGN_MASTER_PLAN.md](REDESIGN_MASTER_PLAN.md) / [LESSON_CYCLE_PHASE1_SPEC.md](LESSON_CYCLE_PHASE1_SPEC.md): 移行前の調査記録・将来計画・未実装仕様。採否はMASTER_PLAN、具体的な受け入れ条件はPHASE1_SPEC
- MCPサーバー本体は別のprivateリポジトリ `mugilives-max/stepwise-mcp`。接続先・環境・配置手順は [MCP_OPERATIONS.md](MCP_OPERATIONS.md) に集約する。

## 9. 変更履歴(要点)

- 2026-09-07 保護者専用認証を本番GAS v45へ反映（実装commit a2b6fe6）。検証・退避の記録は [PARENT_AUTH.md](PARENT_AUTH.md#今回の確認範囲)、残件は [FUTURE_WORK.md](FUTURE_WORK.md)。

- 2026-08-29 予約システム稼働(GAS + Pages)
- 2026-09-04 管理画面 `/kanri/` 追加、生徒管理を管理画面へ移行、高速化
- 2026-09-05 生徒ページをマイページ化(タブ、保護者ページ、希望日程・共有予定・授業できない日、月の授業回数と保護者承認、宿題・テスト予定)、パスワード再設定をメールコード方式に
- 2026-09-05 模試(北辰テスト)の記録を追加(台帳「模試」シート、管理画面・生徒ページで表示、GAS v39)
- 2026-09-06 返事がないまま日付が過ぎた案内を管理画面ホーム/授業/カルテで警告し、「実施済みにする」「未実施」を選べるように(GAS v40)
- 2026-09-06 先生の休み(teacherOff シート)。管理画面から登録、各カレンダーに「休」、案内時に警告、生徒ページにも表示(GAS v41)。同日、ホームの日付タップから登録、時間帯指定(start/end)に対応(GAS v42)
- 2026-09-07 生徒ページを「ホーム」と「予定」の2ページに分割(#home / #schedule)。ホームの予定表には先生の休みを出さない(生徒に不要なため)。commit cb5d51a、GAS 変更なし
- 2026-09-07 管理画面ホームの全体予定表: 生徒の授業できない日を出さない(授業ページには残す)、Google カレンダー風の Box 表示(renderCal の opts.boxes)。授業は時刻順に「時刻 姓 科目」を1件1行で全件表示(省略しない)、時間帯が重なる授業は左の太線でひとまとまり、生徒の希望(緑)・共有予定(ピンク)・先生の休み(灰)も Box。GAS 変更なし
- 2026-09-06 生徒の「授業できない日」も時間帯指定に対応(blocked に start/end)。生徒ページ右上の「トップページへ」リンクを削除(GAS v43)
- 2026-09-06〜07 MCP 連携: GAS に読み取り専用の MCP 入口(v44)、MCP サーバー(閲覧7ツール)を Codex(stdio)と Cloudflare Workers(ChatGPT、OAuth)に配置。運用手順は docs/MCP_OPERATIONS.md
