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

### 段階 B: 読み取りを Worker へ（最初の体感改善）
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
