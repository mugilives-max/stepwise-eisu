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

### 段階 A: 準備（半日）
1. `cf/` ディレクトリを新設（Workers プロジェクト、wrangler、D1 バインディング、`migrations/`）。Task Hub の構成をコピーして命名だけ変える。
2. D1 スキーマ（3 節）を `migrations/0001_init.sql` に起こす。日付は `TEXT 'YYYY-MM-DD'`、時刻は `TEXT 'HH:MM'`、真偽は `INTEGER 0/1`、金額は `INTEGER 円`。すべての表に `updated_at TEXT` を持たせる。
3. **取り込みスクリプト** `scripts/sheets-to-d1.mjs`: スプレッドシートを Sheets API（既存の `gas-release.cjs` のログイン資格を流用）で読み、D1 に upsert。何度流しても同じ結果になること（冪等）。まずテスト用 D1 に流し、行数がシートと一致することを確認する。

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

GAS が読む 38 シート（列は各 `ensure*_` 関数と `readRows_` の利用箇所が正）。同名で D1 の表にする。

| 群 | シート |
|---|---|
| 生徒・設定 | students, parents, config, lessonKinds |
| 予定 | slots, blocked, teacherOff, wishes, events, tasks, plans, planComments |
| 案内・編集 | offerEdits, acceptWrites, cancellationRequests, slotChangeNotices |
| 授業計画・請求 | planLines, monthAgreements, approvalEvents |
| 授業記録 | lessonRecords, lessonWrites, lessonReportDrafts, lessonPublicSnapshots, lessonReadReceipts, examReports |
| 保護者 | familyAccounts, familyChallenges, familyLinks, familyEmailPrefs, familyNoticeReads, familyOutbox |
| 生徒メール | studentEmails, studentEmailPrefs, studentEmailOutbox |
| 連絡・MCP・監査 | contactMessages, contactProcessing, mcpLog, log |

索引の最低限: `slots(studentId,date)`, `events(studentId,dateTo)`, `planLines(studentId,status)`, `familyLinks(accountId)`, `lessonRecords(slotId)`, `log(createdAt)`。

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
