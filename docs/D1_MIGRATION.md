# D1 移行計画（速度改善）— 引き継ぎ用

作成: 2026-09-21。目的は **画面の応答を 5 秒前後 → 0.5 秒未満** にすること。実装は別セッション（Opus / Sonnet 想定）で進める。この文書だけで着手できるように書く。

## 0. 現状の事実（2026-09-21 時点）

- バックエンドは GAS Web アプリ（`gas/*.gs` 約 5,600 行、`doPost` の action 分岐 91 件）。台帳は Google スプレッドシート（38 シート、下記 3 節）。
- フロントは GitHub Pages の静的ページ（`kanri/` 管理画面、`yoyaku/` 生徒マイページ、`hogosha/` 保護者ページ、共通 `assets/portal.js` `assets/calendar.js`）。API の入口は `assets/portal.js` と `kanri/index.html` の `API` 定数 1 か所ずつ。
- MCP サーバー（`mcp/`）は GAS を HTTP で叩く中継。
- 遅さの内訳: (a) `readRows_(name)` が毎回シート全行を読む（1 リクエストで 10 回以上）、(b) GAS の起動待ち ~1 秒、(c) 書き込みは ScriptLock で直列、(d) Google へのリダイレクト往復。実測はサーバー内だけで概要 3.7 秒・全体 5.5 秒（`docs/SYSTEM.md` 6-4 節）。
- テスト: `npm test`（node --test、492 件、fail 0 が公開条件）。GAS の関数は `test/gas-harness.cjs` がスプレッドシートを模して読み込む。UI は `test/helpers/operations-ui-harness.cjs`。
- 先行事例: 同じ作者の Task Hub / Money Hub / Time Hub が Cloudflare Workers + D1 + Access で稼働中（構成・デプロイ手順はそちらのリポジトリを踏襲する）。

## 1. 到達形

```
ブラウザ(Pages) ──JSON──▶ Cloudflare Worker (api.stepwise-education.jp 想定)
                              │  D1 (正本)         ← 索引付き SQL、数十ms
                              │  Queues/Cron       ← メール送信・通知・バックアップの後回し
                              └─ Sheets へ書き出し ← 先生が眺める帳票（読み取り専用、日次 or 変更時）
MCP サーバー ────────────▶ 同じ Worker（token 認証はそのまま）
```

- **D1 を正本**にし、スプレッドシートは「見るための写し」に降格する。スプレッドシートを直接編集する運用は廃止（編集は管理画面か MCP）。
- 認証は現行踏襲: 生徒はリンクのコード（`sw_k`）、先生は管理トークン（`sw_admt`）、保護者はセッション（`docs/PARENT_AUTH.md`）。Cloudflare Access は先生用 API に追加で掛けてよい。
- API の**リクエスト/レスポンス形は変えない**（`{action, ...}` → `{ok|error, ...}`）。フロントは `API` 定数の差し替えだけで移れるようにする。これが移行の安全弁。

## 2. 進め方（段階ごとに公開して戻れるように）

各段階の終わりに `npm test` fail 0、【テスト】生徒での実操作、`docs/SYSTEM.md` への追記を行う。

### 段階 A: 準備（半日）— **ほぼ完了（2026-09-21）**。結果と残りは 7 節

1. `cf/` を新設（`wrangler.jsonc` / `worker/` / `lib/` / `migrations/`）。Time Hub・Money Hub と同じ設定の形（最上位が本番・`env.local` が開発用、D1 バインディングは `DB`、秘密は `wrangler secret`）にした。ただし**中身は素の JavaScript**。Time Hub は TypeScript + drizzle + React だが、このリポジトリは build 無し・`node --test`・CommonJS なので、そちらへ合わせた方が移行中の並走テストが書きやすい。
2. D1 スキーマは `cf/migrations/0001_init.sql`。**45 表**（当初の想定 38 + 7。7 節）。日付 `TEXT 'YYYY-MM-DD'`、時刻 `TEXT 'HH:MM'`、年月 `TEXT 'YYYY-MM'`、真偽 `INTEGER 0/1`、金額・分数 `INTEGER`。
   - 表名・列名は**シートの見出しそのまま**。GAS の `readRows_` / `ledgerRows_` が返すキーと 1 対 1 になり、並走テストが機械的に書ける。塾管理台帳の 5 シートは日本語のまま。
   - 「すべての表に `updated_at`」は取りやめ。業務列の `updatedAt` と紛らわしいので、取り込み用は `_syncedAt`（最後に台帳から入れた時刻）と `_sheetRow`（シート上の行番号）にした。
   - 外部キーは宣言しない。台帳には参照先が消えた行が残る（取消済みの授業など）ため。整合は取り込み後の検査で報告する。
3. **取り込み**は `cf/lib/import.mjs`（本体）と `scripts/ledger-to-d1.mjs`（CLI）。Sheets API は使わない（新しい OAuth 権限が要る）。代わりに「書き出しの束」を読む形にして、書き出しの手段を後から選べるようにした。何度流しても同じ結果になる（主キーで置き換え）。件数はシートと突き合わせて表示する。

### 段階 B: 読み取りを Worker へ（最初の体感改善）— **完了（2026-09-22）**。8 節も見る
1. Worker に読み取り系 action を実装: `state`, `familyStudentState`, `familyData`, `familyHome`, `familyNotices`, `kanriStudent`, `kanriDashboard`, `data`（管理画面の一覧）, `billingPreview`, `preview`。GAS の対応関数（`studentState_`, `kanriStudentOp_`, `kanriDashboard_`, `familyView_`, `billingPreview_`, `previewOp_`）の**返す JSON をそのまま再現**する。
2. 同期: GAS 側の書き込み後に Worker の `/sync` へ「変わったシート名と id」を UrlFetch で通知し、Worker が Sheets API で該当行だけ取り直す（全量取り込みは段階 A のスクリプトで日次）。GAS の書き込み関数は `ledgerAppend_/ledgerUpdate_` 系に集約されているので、そこに 1 か所フックを足す。
3. フロント: `assets/portal.js` と `kanri/index.html` の `apiPost` で「読み取り action は Worker、それ以外は GAS」に振り分ける表を持つ。失敗時は GAS にフォールバック。
4. 判定: 生徒マイページ初回表示・管理画面の生徒ページが 1 秒未満。

### 段階 C: 書き込みを Worker へ（GAS 引退）
1. 難易度の低い順に移す: `teacherOff/blocked/events/tasks/wishes` → `offer/accept/decline/cancel`（`gas/Scheduling.gs`）→ `planLines`（`gas/PlanLines.gs`）→ 請求・承認（`gas/BillingApproval.gs`、`billingMonthCalc_` の pending/carried を含む）→ 保護者認証（`gas/FamilyPortal.gs`）→ 授業記録（`gas/LessonCycle.gs`）→ 自然文（`gas/NaturalSchedule.gs`、Claude API 呼び出し）。
2. 排他は D1 のトランザクション（`batch`）と `expectedRevision` 列で行う。ScriptLock 相当の全体ロックは不要。
3. メール送信は Worker から直接送れないので、Resend か MailChannels か「GAS を送信専用に残す」のいずれか。**推奨は当面 GAS を送信専用に残す**（差出人が先生の Gmail のままで済む）。
4. 各 action を移すたびに振り分け表を更新し、GAS 側の同名 action は `410 Gone` 相当のエラーを返すようにする。
5. 全部移ったら GAS はバックアップ出力（`gas/Backup.gs`）と送信専用だけ残す。

### 段階 D: 仕上げ
- Sheets への書き出し（Cron 日次 + 請求確定時）。先生が見る表は今までのシートと同じ列順にする。
- MCP サーバーの向き先を Worker へ。`docs/MCP_OPERATIONS.md` の再試行方針は据え置き。
- PWA（`yoyaku/` `hogosha/` に manifest とプッシュ通知）。速度が出てからやる。

## 3. シート → 表の対応

台帳は**2冊**ある。予約・管理の台帳（GAS の `ss_()`）と塾管理台帳（`LEDGER_ID`）。同名で D1 の表にする。列の正本は各 `ensure*_` 関数と `*_COLS_` 定数（`docs/SYSTEM.md` の一覧は一部古い）。

**予約・管理の台帳（40 表）**

| 群 | シート |
|---|---|
| 生徒・設定 | students, parents, config, lessonKinds |
| 予定 | slots, blocked, teacherOff, wishes, events, tasks, plans, planComments |
| 案内・編集 | offerEdits, acceptWrites, cancellationRequests, slotChangeNotices |
| 授業計画・請求 | planLines, monthAgreements, approvalEvents |
| 授業記録 | lessonRecords, lessonPreparations, lessonPrivateNotes, lessonWrites, lessonReportDrafts, lessonPublicSnapshots, lessonReadReceipts, examReports |
| 保護者 | familyAccounts, familyChallenges, familyLinks, familyEmailPrefs, familyNoticeReads, familyOutbox |
| 生徒メール | studentEmails, studentEmailPrefs, studentEmailOutbox |
| 連絡・MCP・監査 | contactMessages, contactProcessing, mcpLog, log |

**塾管理台帳（5 表）** — 表名・列名は日本語のまま。読むときの別名は次のとおり。

| シート | 中身 | 別名（コード内で使う定数名） |
|---|---|---|
| 入金管理 | 請求と入金。`請求ID` が主キー | `LEDGER_INVOICES` |
| 生徒台帳 | 生徒の基本情報。`生徒ID` が主キー | `LEDGER_STUDENTS` |
| 成績推移 | 定期テストの点数 | `LEDGER_GRADES` |
| 模試 | 模試の成績 | `LEDGER_MOCKS` |
| 面談記録 | 面談の記録 | `LEDGER_MEETINGS` |

索引は `cf/migrations/0001_init.sql` に 44 本。最低限として挙げていた `slots(studentId,date)`, `events(studentId,dateTo)`, `planLines(studentId,status)`, `familyLinks(studentId)`, `lessonRecords(slotId)`, `log(time)` は入っている（`familyLinks` の親側の列名は `accountId` ではなく `familyId`、`log` の時刻列は `createdAt` ではなく `time`）。

## 4. テストの方針

- 既存 492 件は GAS の振る舞いの仕様書として残す。Worker 側は **同じ入力で同じ JSON** を返すことを確認する「並走テスト」を追加する（`test/parity/*.test.cjs`: GAS ハーネスと Worker（miniflare か `wrangler dev`）に同じ台帳を入れ、action ごとに出力を deepEqual）。
- 段階 B で読み取り 10 action、段階 C で書き込みを移すたびに並走テストを増やす。並走が揃った action だけ振り分け表を Worker に切り替える。

## 5. 守ること（現行の運用制約）

- 公開リポジトリに秘密を置かない（トークン・API キーは wrangler secret と GAS の Script Properties のみ）。
- 実在の生徒・保護者のデータは明示的な依頼なしに変更しない。動作確認は【テスト】生徒だけ。
- 文書・報告に生徒・保護者の個人情報を書かない。
- GAS を触る公開では `gas/Code.gs` の release 文字列を変え、`npm run gas:plan -- HEAD~1` → `npm run gas:apply -- <id>` の手順（`docs/SYSTEM.md`）。
- 保護者の承認方針（承認は授業を止めない、請求は承認済みのみ、先生記録の承認は保護者が確認）は `docs/SYSTEM.md` と `docs/PARENT_AUTH.md` に従い、移行で変えない。

## 6. 見積り

| 段階 | 目安 |
|---|---|
| A 準備・取り込み | 1 日 |
| B 読み取り移行 | 2〜3 日 |
| C 書き込み移行 | 5〜8 日（請求と保護者認証が重い） |
| D 仕上げ | 1〜2 日 |

段階 B が終わった時点で体感の大半は改善する。C は action 単位で少しずつ進められ、途中で止めても GAS が動き続ける。

## 7. 段階 A の結果（2026-09-21）

### できたもの

| 置き場所 | 中身 |
|---|---|
| `cf/wrangler.jsonc` | API Worker の設定。本番と `env.local`。D1 バインディングは `DB`。本番の `database_id` は `wrangler d1 create stepwise` の出力で差し替える |
| `cf/worker/index.mjs` | 骨組み。CORS と `{action}` の受け口、GET は疎通確認。読み取り action は段階 B で足す。未実装の action は `errorCode:'notImplemented'` を返すので、呼び出し側が GAS に回せる |
| `cf/migrations/0001_init.sql` | 45 表と 44 索引 |
| `cf/lib/import.mjs` | 書き出しの束を D1 に入れる本体。値の直し方は D1 のスキーマ自身から決める（型表を二重に持たない） |
| `scripts/ledger-to-d1.mjs` | 取り込みの CLI。手元のフォルダを読み、手元の SQLite に書くだけ。ネットワークへは何も送らない |
| `test/helpers/d1-harness.cjs` | `node:sqlite` で D1 と同じ形を作るシム。wrangler を起動せずにスキーマと Worker を検証できる |
| `test/d1-migration.test.cjs` | 5 件。`npm test` に含まれる |

### 取り込みの使い方

書き出しフォルダに `<app|ledger>.<シート名>.<json|csv>` を置く。CSV はスプレッドシートの「CSV をダウンロード」そのままでよい。JSON は `{sheet, headers, rows, offset}`。

```bash
node scripts/ledger-to-d1.mjs --bundle <書き出しフォルダ> --db .wrangler/test-d1.sqlite --reset
```

表ごとに「書き出しの件数 / D1 の件数 / 判定」が出る。`--sql <ファイル>` を足すと本番 D1 用の SQL も書き出す（流すのは `npx wrangler d1 execute DB --config cf/wrangler.jsonc --remote --file <ファイル>`）。

検証済み: 合成台帳（【テスト】生徒のみ）35 シートを JSON と CSV の両方の経路で取り込み、件数がすべて一致。二度流しても増えない。`slots(studentId,date)` の索引が使われることも確認した。実在の台帳はまだ取り込んでいない（下記）。

### 分かったこと

- **表は 38 ではなく 45**。計画の一覧に無かったのは `lessonPreparations`、`lessonPrivateNotes`（`gas/LessonCycle.gs` が作る）と、塾管理台帳の 5 シート。
- **真偽の書き方が 3 通り混在**している。native の TRUE/FALSE（`students.active`、`slots.done`）、文字列の `'true'`/`'false'`（`familyLinks.active`、`lessonKinds.active`）、文字列の `'1'`/`'0'`（`familyEmailPrefs`、`studentEmailPrefs`）。取り込みで `INTEGER 0/1` に寄せる。`familyLinks.active` は GAS 側が `=== 'true'` で厳密比較しているので、シートに native TRUE が入ると無効扱いになる。D1 では起きない。
- **`''` と `0` を区別する列**が 3 つある（`planLines.approvedCount`、`lessonKinds.standardMin` / `standardFee`）。ここだけ NULL 可にした。
- **`planComments` は凍結済み**。書き込む関数（`ensurePlanCommentsSheet_` / `planCommentSave_`）は既に `gas/*.gs` から消えていて、残っているのは読み取りの `planComment_`（`gas/Code.gs:597`）だけ。使い道も `planLinesMigrate_`（`gas/PlanLines.gs:323`）が過去分を `planLines.comment` に移すときだけ。**段階 C で書き込み経路を作らない**。主キーは `(studentId, ym)` の組で、`ym` は `plans` と違って `'default'` を取らない。
- **`ensureSchema_` の呼び出し順に小さな不具合があった（修正済み）**。`ensureEventKindCol_` が `ensureEventsSheet_` より先に呼ばれていたので、`events` シートを新規に作った直後は `kind` 列が付かなかった（次にスキーマ版が上がるまで）。本番の台帳には既にあったため実害は出ていない。`ensureSchema_` を「シートを作る」→「列を足す」の2段に整理し、`test/schema-bootstrap.test.cjs` で並び順を固定した。
- `docs/SYSTEM.md` の列一覧は一部古い（`wishes` は 8 列ではなく 11、`planLines` は 20 列ではなく 24、`plans` は 10 列ではなく 11）。正本は `*_COLS_` 定数。

### 実在の台帳の書き出し（2026-09-22 に決定・実装済み）

「スクリプトエディタから手で実行する書き出し関数」を選んだ。外から叩ける口を増やさずに初回コピーができる。GAS `2026-09-22-ledger-export`（v90）で公開済み。詳細は `docs/SYSTEM.md` の同名の節。

先生の手順:

1. スプレッドシートの拡張機能 → Apps Script でエディタを開く。
2. 関数の一覧から `exportLedgerForMigration` を選んで実行する。
3. 「途中で終わりました」と出たら `exportLedgerResume` を実行する。「完了」と出るまで繰り返す（6分の実行制限があるため、行数によっては数回かかる）。
4. マイドライブにできた「ステップワイズ_移行用書き出し_…」フォルダをダウンロードし、zip を展開する。
5. `node scripts/ledger-to-d1.mjs --bundle <展開したフォルダ> --db .wrangler/test-d1.sqlite --reset` を実行する。表ごとに件数の判定が出る。

**実台帳の取り込み結果（2026-09-22）**: 45 シート・372 行を取り込み、44 表すべて件数が一致。主キーの重複は無し（重複があれば置き換わって件数が合わなくなる）。参照の切れは授業記録 1 件のみ（授業の行が消えた過去の記録。公開されておらず、D1 では記録が残る）。「一覧」シートは GAS が読まない人向けの表なので対象外。取り込み先は手元の `.wrangler/test-d1.sqlite` で、Git には入らない。

この取り込みで見つけた不具合は 2 つ。どちらも直して GAS `2026-09-22-export-time-cells` で公開済み。

- 時刻だけのセルが `1899-12-30 07:30:00` の形で出ていた（`docs/SYSTEM.md` の同名の節）。
- 再開のたびに終わったシートを見て打ち切り、先に進まなくなる場合があった（`exportStep_` は 1 かたまり書くまで打ち切らない）。

段階 B に入るときに、この書き出しを自動で回す経路（鍵付きの読み出し口、または書き込みのたびに Worker へ push する仕組み）を別途決める。書き込みは GAS のままなので、同期は GAS から Worker への一方通行で足りる。

### 参考: 書き出し経路の比較（2026-09-21 の検討）

取り込みの仕組みはできているが、**本番の台帳からの書き出し経路は未決**。ここは先生が決める。

| 案 | 手間 | 増える露出 |
|---|---|---|
| A. スプレッドシートから CSV を手で落とす | 45 シート分の手作業。初回だけなら現実的 | なし |
| B. Apps Script エディタから手で実行する書き出し関数を足す（Drive に JSON を出す） | 関数を 1 つ足して 1 回押す | エディタに入れる人だけ。HTTP の口は増えない |
| C. GAS に鍵付きの読み出し専用エンドポイントを足す | 自動化できる。段階 B の差分同期にも使える | 台帳を丸ごと読める口が 1 つ増える（Script Properties の鍵で保護） |

C は段階 B の差分同期でいずれ必要になるが、「台帳を丸ごと読める口」を増やす判断なので、先生の指示を待つ。B は HTTP の口を増やさずに初回取り込みができるので、まず B で始めて、段階 B に入るときに C を検討するのが無難。

### 段階 B に入る前にやること

1. 書き出し経路を決めて、実在の台帳を一度取り込み、件数と主キーの重複を確認する。
2. `wrangler d1 create stepwise` で本番 D1 を作り、`cf/wrangler.jsonc` の `database_id` を差し替える。
3. `npm run cf:migrate:local` / `npm run cf:migrate:remote` でスキーマを当てる。
4. 並走テスト（`test/parity/`）の受け皿を作る。D1 側は `test/helpers/d1-harness.cjs` をそのまま使えるので、GAS ハーネスと同じ台帳を両方に入れて action ごとに比べる形にする。

## 8. 進み具合（2026-09-22 時点）

| 段階 | 状態 |
|---|---|
| A 準備・取り込み | **完了** |
| B 読み取りを Worker へ | **完了**。生徒・保護者・管理画面の読み取りが本番で Worker から返る |
| C 書き込みを Worker へ | **完了（2026-09-22 切り替え済み）**。10 節 |
| D 仕上げ（Sheets への書き出し・MCP の向き先・PWA） | 未着手 |

段階 B で Worker に載せた読み取りと、まだ Apps Script に回っているもの:

| 読み取り | 状態 |
|---|---|
| `state`（生徒マイページ） | Worker |
| `kanriStudent`（管理画面の生徒ページ、全タブ） | Worker |
| `kanriDashboard`（管理画面のホーム） | Worker |
| `billingPreview`（請求の下書き） | Worker |
| `admin state`（管理画面の全体） | Worker |
| `familyHome` / `familyData` / `familyStudentState` / `familyNotices`（保護者ページ） | Worker（2026-09-22 追加）|
| `preview`（先生のプレビュー） | Apps Script |
| `learningService` / `parentData` など | Apps Script |

計画当初に挙げていた `data` という読み取りは存在しなかった（`admin` にその op は無い）。

## 9. 段階 B の記録（2026-09-22）

### 方針を変えた: 作り直さず、同じコードをデータ層だけ差し替えて動かす

当初は「GAS の関数が返す JSON を Worker 側で再現する」つもりだった。実際に読んでみると
`studentState_` だけでも 20 近い補助関数にぶら下がっていて、請求や承認の判定を写し間違えると
お金と保護者への表示に直接ひびく。

一方で GAS の計算は素の JavaScript で、Google に依存しているのは**シートを読む所だけ**だった。
そこで `gas/*.gs` をそのまま Worker に載せ、シートの代わりに D1 を読ませる形にした。
作り直していないので「返す JSON が同じ」ことを比べて確かめるまでもなく、コードが同一である
ことで担保できる。実際に 8 つの読み取り経路で 1 文字も違わないことを確認した。

```
cf/worker/read.mjs ─ createGas(サービス一式) ← scripts/build-gas-bundle.mjs が gas/*.gs から生成
                       └ SpreadsheetApp の代わり ← cf/lib/sheet-view.mjs が D1 をシートの形に戻す
```

### できたもの

| 置き場所 | 中身 |
|---|---|
| `scripts/build-gas-bundle.mjs` | `gas/*.gs` を Worker から呼べる 1 モジュールに。`cf/migrations` から表ごとの列も生成。wrangler の `build.command` で dev / deploy のたびに走る |
| `cf/lib/gas-services.mjs` | Google サービスの代わり。**読み取り専用**で、書き込み・メール・カレンダー・外部通信はその場で例外。時計も差し替えられる（並走テスト用） |
| `cf/lib/sheet-view.mjs` | D1 → シートの形。真偽値は列ごとの書き方に戻す |
| `cf/worker/read.mjs` | `state`（生徒マイページ）と管理画面の `kanriDashboard` / `kanriStudent` / `billingPreview` / `state`。引き受けない操作は null |
| `test/parity-reads.test.cjs` / `test/parity-worker.test.cjs` | 並走テスト。GAS と Worker が同じ JSON を返すこと、ログイン不可を断ること、読み取り中に書こうとしたら止まることを確認 |

### 測ったもの（実台帳 372 行、`wrangler dev` のローカル D1）

| 処理 | 時間 |
|---|---|
| 台帳の読み込み（45 表） | 9 ms |
| 読み取り 2 件の計算 | 2 ms |
| 参考: 同じ画面の GAS 側 | 3,700〜5,500 ms |

### D1 で引っかかった制約

- **PRAGMA を実行できない**（`pragma table_info` も表関数の `pragma_table_info(...)` も `SQLITE_AUTH`）。列の一覧は `cf/migrations` から生成した表（`cf/worker/generated/schema.mjs`）を使う。
- `sqlite_%` `d1_%` に加えて **`_cf_%` の内部表も読めない**。表の一覧から外す。
- **表ごとに問い合わせると遅い**。45 表を順に読むと 180ms。`db.batch()` で 1 回にまとめて 9ms。

### 守っている安全側の作り

- Worker は `doPost` / `doGet` を通さず、必要な関数だけ直に呼ぶ。あちらは実行のたびに排他を取り、`ensureSchema_` から一度きりの移行処理まで走らせる（＝読みながら書く）ため。
- 台帳は読み取り専用。書こうとしたら黙って進まず例外にする。`ANTHROPIC_API_KEY` は Worker に置かず、「設定済みかどうか」の印だけを渡す。
- 引き受けない操作は `null`（HTTP では 501）を返すので、呼び出し側はそのまま GAS に回せる。

### 同期と振り分け（2026-09-22、GAS `2026-09-22-worker-sync`）

**同期**（`gas/Sync.gs` → `cf/worker/sync.mjs`）

- 書き込み用にシートを取った時点で目印を付け（`sheet_` / `ledgerSheet_`）、`doPost` の最後に
  変わったシートだけを Worker の `/sync` へ送る。1 回の書き込みで送るのは 3 シートほど（台帳は 34 シート）。
- **丸ごと置き換える**ので、消えた行（断られた案内など）も D1 から消える。
- 共有の鍵（24 文字以上）を知っている呼び出しだけ受け付ける。設定が無ければ何も送らない。
- 送信に失敗しても応答は壊さず、取りこぼしたシートを覚えて次の書き込みでまとめて送り直す。
- `resyncLedgerToWorker`（エディタから手で実行）で台帳ぜんぶを送り直せる。

**振り分け**（`assets/portal.js` / `kanri/index.html`）

- `READ_API` を設定したときだけ、読み取りを Worker に向ける。引き受けない（501）・失敗・通信不能
  なら、中身を変えずにそのまま Apps Script へ回す。**書き込みは常に Apps Script**。
- 既定は `READ_API=""` で**無効**。本番の動きは今と変わらない。

### 本番で有効にする手順（まだ実施していない）

1. `npx wrangler d1 create stepwise` を実行し、出た `database_id` を `cf/wrangler.jsonc` に書く。
2. `npm run cf:migrate:remote` でスキーマを当てる。
3. 台帳を入れる。`node scripts/ledger-to-d1.mjs --bundle <書き出しフォルダ> --sql out.sql` で SQL を作り、
   `npx wrangler d1 execute DB --config cf/wrangler.jsonc --remote --file out.sql` で流す。
4. 同期の鍵を決める（24 文字以上のランダムな文字列を 1 つ）。**先生が作って、次の 2 か所に同じ値を入れる**。
   - `npx wrangler secret put SYNC_KEY --config cf/wrangler.jsonc`
   - Apps Script のプロジェクトの設定 → スクリプト プロパティ → `WORKER_SYNC_KEY`
5. `npm run cf:deploy` で Worker を公開し、URL を確認する。
6. Apps Script のスクリプト プロパティに `WORKER_SYNC_URL`（Worker の URL + `/sync`）を入れる。
7. Apps Script から `resyncLedgerToWorker` を実行し、台帳ぜんぶを D1 に送る。
8. `assets/portal.js` と `kanri/index.html` の `READ_API` に Worker の URL を入れて公開する。
   ここで初めて画面が速くなる。おかしければ `READ_API` を空に戻すだけで元に戻る。

### 残り

- 段階 C（書き込みの移行）。メール・カレンダー・ドライブが絡むので、当面 GAS に残す方針は変えない。
- 段階 D（Sheets への書き出し・MCP の向き先・PWA）。
- 残っている読み取り: 先生のプレビュー（`preview`）と成績票などの `learningService`。どちらも使う頻度が低く、Apps Script のままでも困らない。

## 10. 段階 C（書き込み）: 仕組みは完成、切り替えは未実施（2026-09-22）

### 方針: D1 を唯一の正本にし、書き込みは一度に切り替える

表ごとの段階移行は成立しない。1 つの操作が複数の表にまたがるため（予定の共有は `events` と
`blocked` を同時に書く）、正本を移す単位は表ではなく「つながった塊」＝実質ぜんぶになる。
また GAS は自分の書き込みの中でも台帳を読む（案内を出すとき `blocked` を読んで避ける）ので、
一部だけ D1 に移すと GAS が古い情報で判断してしまう。

### できたもの

| 置き場所 | 中身 |
|---|---|
| `cf/migrations/0002_write.sql` | `_ledger`（台帳の版番号）、`_guard`（版の食い違いでまとめ書きを失敗させる）、`_effects`（付随処理の控え） |
| `cf/worker/write.mjs` | `doPost` を D1 の上で実行し、触った表だけを反映。版番号が読んだときと違えばやり直す（最大3回） |
| `cf/lib/gas-services.mjs` | `effects` モード。メールとカレンダーを控えに溜め、カレンダーには仮の予定IDを返す |
| `gas/Sync.gs` | `effectsOp_`（付随処理の代行）、`pullLedgerFromWorker`（Worker の台帳をシートへ写す）、`syncWriteBlocked_`（正本が移ったら書き込みを断る） |
| `test/parity-writes.test.cjs` | 生徒の書き込み6種が GAS と同じ台帳になること、付随処理の控え、競合のやり直し、PBKDF2 の一致 |

### 全体ロックの置き換え

台帳ぜんぶに 1 つの版番号を持たせた。書き込みは「読んだときの版」を持ち込み、変わっていなければ
版を +1 して反映する。変わっていたら**何も反映せず**、その操作を最初からやり直す（最大3回）。
Apps Script の全体ロックと違い、待つのではなく「やり直す」形。テストで割り込みを起こして確認済み。

### メール・カレンダーの扱い

Worker は Google のサービスを直接呼べない。台帳を書いたあと**応答を先に返し**、そのあとで
Apps Script に頼む（Cloudflare の `ctx.waitUntil`）。利用者は待たない。カレンダーの予定IDは
仮のものを台帳に入れ、登録が済んでから本物に書き戻す。先生のメールアドレスは Worker に置かず、
`TEACHER` という目印を Apps Script 側が自分のアドレスに置き換える。

付随処理は `_effects` にも残るので、失敗しても後から送り直せる。

### 保護者のパスワード

PBKDF2 60万回は純 JS だと 1204ms かかる。同じ値を返す `node:crypto` に差し替えて 133ms。
値が一致することはテストで突き合わせている（違うと保護者がログインできなくなる）。

### 切り替え（2026-09-22 実施済み）

台帳の正本は D1。書き込みも Worker が担当する。Apps Script は読み取り・付随処理の代行・
MCP の中継だけを担い、台帳には書かない（`WORKER_OWNS_LEDGER=1`）。

切り替え直後に 1 件不具合を出した。`cf/worker/index.mjs` で変数を定義する前に使っており、
数分間すべての書き込みが失敗した。本番の設定（`WRITE_MODE=worker`）でのみ通る経路だったため
テストで検出できなかった。**設定で分岐する経路は、その設定を入れた状態でも確かめる**こと。

切り替え後の確認（先生の実操作）: 台帳の版が 8 まで進み、`planLines` と `slots` と `log` に
反映された。仮のまま残ったカレンダー予定 0 件、未送信のメール 0 件。

### 切り替えの手順（実施済み・再掲）

1. `npx wrangler secret put GAS_URL --config cf/wrangler.jsonc`（Apps Script の /exec の URL）
   と `MCP_KEY`（MCP を使う場合）を登録する。
2. Apps Script のスクリプト プロパティに `WORKER_OWNS_LEDGER` = `1` を入れる。
   この瞬間から Apps Script は台帳への書き込みを断る（読み取りと付随処理の代行は続ける）。
3. `cf/wrangler.jsonc` の `WRITE_MODE` を `worker` にして `npm run cf:deploy`。
4. 画面の振り分けを「読み取りだけ」から「全部 Worker」に変える。
5. 確認後、`pullLedgerFromWorker` を実行してシートを最新の控えにする。

**戻すとき（順番が大事）**

1. Apps Script で `pullLedgerFromWorker` を実行し、D1 の内容をシートへ写す。
2. `cf/wrangler.jsonc` の `WRITE_MODE` を空にして deploy、画面の `WRITE_TO_WORKER` を false にして公開。
3. Apps Script のスクリプト プロパティから `WORKER_OWNS_LEDGER` を消す。

この順でないと、切り替え後に書かれた分が失われる。

### 切り替え後に出した不具合（2026-09-22）

1. `cf/worker/index.mjs` で変数を定義する前に使い、数分間すべての書き込みが失敗した。
   本番の設定（`WRITE_MODE=worker`）でのみ通る経路でテストに無かった。
2. カレンダーの模擬実装が実物と違い、**授業の確定がすべて失敗**した（`docs/SYSTEM.md` の
   「授業の確定とカレンダー」）。Google のサービスを模擬するときは、**戻り値の形まで実物に
   合わせる**こと。特に GAS 側が戻り値を検証している箇所（本人確認の印）に注意する。

どちらも「本番の設定でしか通らない経路」だった。切り替えを伴う変更では、切り替え後の
設定を入れた状態での確認を手順に含める。

### 切り替え後の見張り

次が 0 でなければ、付随処理のどこかが滞っている。

```sql
select (select count(*) from slots where eventId like 'pending-%') as 仮のまま残った予定,
       (select count(*) from _effects where status = 'failed') as 送信に失敗した付随処理,
       (select count(*) from _effects where status = 'pending') as 送られていない付随処理;
```

### 残り

- 切り替えそのもの（上の手順）。先生の操作が 2 か所（secret 1 つ、スクリプト プロパティ 1 つ）。
- 段階 D（Sheets への定期書き出し・MCP の向き先・PWA）。

## 11. 段階 D（仕上げ）実施 2026-09-22

### D-1 シートへの写し（GAS v97）
正本が D1 に移ったあと、シートは切り替え時点で止まっていた。既存の週次バックアップ
（`gas/Backup.gs`・日曜 3:00 に Drive へ複製）はシートを写す作りなので、そのままでは
**古い内容を保存しつづける**。毎日 2:00 に D1 からシートへ写し直し、それを週次バックアップが拾う。

- `gas/Mirror.gs` の `mirrorLedgerFromWorker`（毎日のトリガー）。`/export` から取り寄せて全面上書き。
- 書かない条件: 取り寄せ失敗 / 形が違う / 表の数が前回より減った / `students`・`slots` が空。
  引っかかったらシートはそのままにして先生に知らせる（初回と 7 回ごと）。
- `pullLedgerFromWorker` は、確認なしの上書きが手で走らないよう `mirrorLedgerFromWorker` に寄せた。
- 正本が Worker にあるあいだ、`syncPush_` は何もしない（Worker は `/sync` を 409 で断るため）。

**先生の操作（1 回だけ）**: スクリプトエディタで `setupLedgerMirror` を実行。
初回は、先に `startStepwiseBackup` を手で走らせて今のシートを Drive に残してから行う。

### D-2 MCP の向き先
これまで MCP は GAS を入口にして Worker へ中継していたため、呼び出しごとに GAS の
待ち時間（約 1.8 秒）が乗っていた。`stepwise-mcp` 0.4.0 で `STEPWISE_API_URL` を見るようにし、
設定されていれば Worker へ直接送る（無ければ従来どおり GAS）。送る中身も応答の形も同じ。

**必要な設定**: `stepwise-api` に Secret `MCP_KEY`（未設定なら Worker は MCP を断る）、
`stepwise-mcp` に `STEPWISE_API_URL`。どちらも本人が入れる。中継の経路は残してあるので、
問題があれば `STEPWISE_API_URL` を外すだけで戻せる。

### D-3 ホーム画面のアプリ
`yoyaku/` `hogosha/` に manifest とアイコンを追加（管理画面と同じ作り）。
ホーム画面から開くと専用リンクの `?k=` が付かないので、鍵を覚えていない端末では
今まで「読み込みに失敗しました」という見当違いの案内になっていた。鍵が無いときは
問い合わせず案内を出し、その画面でリンクを貼り直せるようにした。

プッシュ通知は未着手。VAPID 鍵と購読の保存先（D1）が要るので、別に立てる。

### 残り
- 読み取りで Apps Script のままのもの: 先生のプレビュー（`preview`）と成績票などの `learningService`。
- オンライン授業の確定だけは、Meet の URL を返すため今も GAS を待つ（`cf/worker/write.mjs` の `ensureEvents`）。

<a id="plan-outline-release"></a>

## 12. 任意の計画内訳の公開（2026-09-22・本番反映済み、確認残あり）

現行仕様は [授業サイクル仕様](LESSON_CYCLE_PHASE1_SPEC.md#local-plan-outline)。先生の本番反映承認後、`0004_plan_outlines.sql` を適用し、Worker・GAS・Pagesを公開した。既存列に触れず、`planOutlines` / `lessonOutlineLinks` / `lessonOutlineSnapshots` の3表だけを追加した。

先生の画面確認後、ローカル合成データでD1の報告・宿題・家族セッションの既読と、新3表の内容入りexport→Sheets mirrorを確認済み。全632テスト・構文確認・Workerのlocal環境向けdry-runが通過した。先生用プレビューの既読エラーも解消し、プレビュー閲覧で保護者の既読を付けない。本番の確認範囲と未解決事項は下記のとおりで、ローカル成功と区別する。

### 公開結果と復旧用の基準

- 実装コミット `bcf5375987bfe4f24114ea0ee124199bf5337ab8`。公開前の基準は `6b2a3bb2ba5d54ff0a2d8edabe127914436c845c`。GASの編集版・公開版v99・Git基準が一致することを確認し退避した。マニフェスト・OAuth権限・既存WebアプリURLは変更していない。
- D1はSQLへ退避し、別のローカルSQLiteへ復元して `integrity_check=ok`。migration直後、追加3表が空で、既存全表のスキーマ・内容が一致することを確認した。
- Worker version `6da37480-b781-4699-af76-d76d6c93d3b0`、GAS v100。両APIのhealthで `2026-09-22-lesson-record-outline` を確認。GASの公開直後の版照合は反映待ちで一度失敗したが、v100の読み戻しとhealthを確認後、同じrelease IDで完了した。余分な版は作成していない。
- Pages build `35731467934` が成功。管理・生徒・保護者HTML、`portal.js`、`lesson-report.js` / `.css` の6ファイルを公開先から取得し、改行正規化後の全文一致を確認した。
- 本番の専用テスト生徒で、内訳なしの報告保存、講師専用内訳の非公開、公開内訳の `1/2`、宿題3件の反映と同じrequestIdの再試行による重複防止、先生用メモの非公開を確認した。実生徒の入力・承認・請求・メール・カレンダー操作は行っていない。
- テスト専用データを再度退避後、対象を特定した23行（生徒・計画・授業・報告・宿題・内訳・journal・テスト家族）だけを除去した。テスト生徒リンクは失効。後片付け後の53表について管理用更新時刻・行位置を除く全業務値が開始時と一致した。台帳revisionだけ28→36へ正常に進み、巻き戻していない。
- 非公開の証跡・退避・復元DB: `.verification/lesson-outline-release-20260922/`。GASの元ソース・公開版・読み戻し: `.verification/releases/2026-09-22T12-58-18-326Z/`。これらに認証情報や台帳が含まれるためGitへ追加しない。
- 復旧先: Worker `a1a8d5ea-7bbf-4ebc-b617-8c38e75c5f78`、GAS v99、Pagesは実装コミットのrevert。追加表は削除せず、下記mirrorの保護条件も維持する。

### 未完了の確認・次の判断

1. **本番の保護者ログイン（後続対応で解消）**: 初回公開時に専用テスト家族の `familyLogin` が汎用エラーとなった。先生の調査・修正依頼を受け、下記 [認証修正](#family-crypto-release) で実ホスト固有の暗号計算上限を再現・修正し、本番の実家族セッションによる報告・既読のHTTP確認まで完了した。実アカウントのパスワード変更・保護条件の緩和は行っていない。
2. **本番Sheetsのmirror／週次バックアップ**: 共用コードとexport schema、新3表の内容入りmirrorはローカルで確認済み。本番の `mirrorLedgerFromWorker` / `ledgerMirrorStatus` と週次バックアップの実行・内容確認は今回未実施。D1が正本のままであり、現在のSQL退避は復元済み。既存の定期mirrorを変更・解除せず、次回は既存権限で実行結果と3表を確認する。
3. **実端末・実運用**: PC／スマホでの入力負担や所要時間は今後評価する。上記の未完了事項があるため、全経路の受け入れ完了とは記録しない。

### 公開時の順序（再実施・保守用）

関連更新では次の順で差分を照合する。今回の実施済み・未完了の区分は上記を正とする。

1. 現在のD1・適用済みmigration・Worker/GAS/Pages版と同時編集の有無を再確認。正本D1を非公開の保存先にバックアップし、件数・schema・復元方法を確認する。Sheetsの写しだけを現在のD1のバックアップとみなさない。
2. migrationの差分が3表の追加のみであることを確認し、D1へ適用する。公開Workerの切替前に表が存在する必要がある。新しい生成schemaは読取時に新表も参照するため、順序を逆にしない。
3. `scripts/build-gas-bundle.mjs` で共用処理とschemaを再生成しWorkerへ反映。既存のstate・授業記録と、新しい内訳読取／保存を合成データで確認する。料金・承認・実施数が変わらないことも確認。
4. GASで残るプレビュー経路にも共用ソースを整合させる。D1→Sheetsのmirrorが新3表を含むこと、週次バックアップがその写しを含むことを確認する。正本はD1のままで、旧Sheetsを正本へ戻して書き込まない。
5. 関連する管理画面・本人／保護者画面・共通JS/CSSをまとめて公開。内訳なし／講師専用／公開、報告→宿題反映、1/2表示、実際の家族セッションの既読を合成データだけでスモークテストする。実生徒の過去記録へ自動対応付けしない。

戻す場合は旧アプリ版を再配信できるよう保存しておく。追加テーブル・スナップショット・journalを削除しない。旧Workerのexportは新表を含まない可能性があり、mirrorの表数減少チェックで停止し得る。復旧時には新表の保持とmirror／backupの内容を再照合し、保護条件を安易に解除しない。

<a id="family-crypto-release"></a>

## 13. 本番の保護者ログインの修正（2026-09-22）

先生の依頼を受けて調査・修正・公開した。UIや台帳構造の変更ではなく、D1移行後のパスワード計算経路の修正である。

- **原因**: Cloudflare remote previewで `Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).` を再現。ローカルのNode／workerdは同じ600,000回を受け付けるため、従来のテストでは見つからなかった。既存ライブラリをそのままWorkerへ戻す案も実ホストのCPU制限で失敗し、本番には採用していない。利用者ごとの過去の失敗件数・影響期間は未調査。
- **対応**: 対応環境ではnative計算を継続し、上記上限時だけ既存GASの認証付き `parentCrypto` へ計算を依頼する。600,000回・UTF-8・既存hash形式を維持。アカウント・セッション・ロック・権限の正本はD1のままで、GASはSheetsを読まず計算だけ行う。計算待ちの未保存処理は破棄し、D1再読込・再検証後に一度だけ保存する。失敗時に認証を迂回しない。実アカウントのパスワード・既存鍵・URL・OAuth権限・契約は変更していない。詳細は [保護者認証](PARENT_AUTH.md#d1-parent-crypto)。
- **公開**: コード `583f681`。GAS v101、Worker `ae675d69-89f0-4652-ad61-52574c4b16cf`、両healthのreleaseは `2026-09-22-family-crypto-fallback`。GASを先に公開し、その後Workerを切り替えた。元のGAS v100・編集HEAD・Git基準 `1e24335` を照合・退避し、同じmanifest・公開URLを維持。GASの一時検証関数だけを除去し、17ファイル（manifest含む）の一致と固定版を確認した。claspのpushはリモートにしかない一時ファイルの削除だけを検知しないため、差分が自作検証関数のみであることを確認し、同じclaspの標準push処理で除去・再読込照合した。
- **検証**: 構文確認・全643テスト成功。新規11テストで既存hash互換、上限時の委譲、誤入力5回のロック、D1の再検証、停止／パスワード変更／証明失効との競合、登録・再設定用saltの保持、通信失敗時の無保存、公開口からの計算要求拒否を確認。実GASでは9項目成功、英数字／日本語・絵文字・空白の600,000回の計算がNode標準結果と一致（4,121ms／4,750ms）。実ホストの隔離Workerでも非同期計算と再実行が成功した（この段階のGAS応答は合成値）。
- **本番確認**: 専用の `【テスト】` 生徒・家族だけで、誤パスワード拒否、既存hash・salt不変のログイン、報告の内訳 `1/2`、宿題3件、未読→既読・再送、別生徒の拒否、講師メモ非公開、過去公開版の固定、ログアウト後の失効を確認。さらに登録／再設定のHTTP経路、証明の一回限り使用、同時2件の独立したログイン、新パスワードへの切替と旧2セッションの失効を確認した。登録・再設定の認証証明は専用のテスト行を事前作成し、実メール配信はしていない。単発ログイン3,508ms、登録7,929ms、再設定3,787ms、同時2ログインの両完了7,210ms。少数回の参考値であり、高負荷時の保証ではない。
- **退避と後片付け**: 事前D1はSQLへ退避し、SQLite復元とintegrity確認（54表・405行、ledger 36）。検証後の一括exportはCloudflare側でエラーとなったため、読み取り専用の全表取得へ切り替えた。前後のledger一致で取得中の更新がないことを確認し、非公開JSONへ退避・独立SQLite復元検証（54表・432行、ledger 58）。所有を確認したテスト専用27行だけを削除し、生徒リンク・家族セッションの失効を確認。後片付け後は54表・405行、ledger 59。管理用更新時刻・行位置・ledgerを除く53表の全業務値が作業前と一致。実生徒の授業・請求・承認・実メール・Calendarは操作していない。削除したテスト行は非公開退避から復元可能。
- **証跡と復旧**: `.verification/family-login-fix-20260922/`、GAS反映記録 `.verification/releases/2026-09-22T13-41-41-244Z/`。認証情報を含むためGitへ追加しない。直前版はWorker `6da37480-b781-4699-af76-d76d6c93d3b0`／GAS v100だが、Workerを戻すと今回のログインエラーが再発する。緊急時もデータを巻き戻さず、認証入口の停止案内と修正を優先する。GAS計算口を戻すときは、依存する新Workerを稼働させたまま先に削除しない。

本番Sheetsのmirror／週次バックアップが新3表を含むことと、PC・スマホの実利用での入力負担の評価は引き続き残る。今回の認証修正を、その確認の完了とは扱わない。
