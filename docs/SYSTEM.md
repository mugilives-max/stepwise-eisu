# ステップワイズ個別指導 システム概要

最終更新: 2026-09-06 / 管理者: 麦倉優輔 (mugilives@gmail.com)

このファイルが「システム全体のどこに何があるか」の正本です。別のチャットや別のAI(ChatGPT など)から作業するときは、まずここを読んでください。
公開リポジトリに置いているため、生徒の氏名・ID・専用リンクのコード・パスワードは書きません。

## 1. 一言でいうと

- 画面(HTML)は **GitHub Pages**、ロジック(API)は **Google Apps Script**、データは **Google Drive のスプレッドシート2つ** にあります。
- GitHub にはデータは一切ありません。壊れたら困るものは Drive のスプレッドシート2つだけです。

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
| GitHub `mugilives-max/stepwise-eisu`(main / root を Pages 配信) | `index.html` ホームページ、`yoyaku/index.html` 生徒マイページ、`kanri/index.html` 管理画面、`gas/Code.gs` サーバーコードの写し、`docs/` この文書 | ローカルは `C:\Users\mugir\dev\stepwise-eisu`。ブラウザは約10分キャッシュするので確認時は `?nc=適当な値` を付ける |
| Google Apps Script(スプレッドシート「ステップワイズ予約システム」に紐づくコンテナバインド) | 実行中のコード。Web アプリとして公開(URL は `yoyaku/index.html` と `kanri/index.html` の `API` 定数) | GitHub の `Code.gs` はこの写し。編集はローカル → エディタに貼り付け → 保存 → 「デプロイを管理」→ 新バージョン |
| Drive: スプレッドシート「ステップワイズ予約システム」 | 生徒一覧と専用リンクコード、授業枠、授業できない日、希望日程、共有予定、月の授業回数(計画)と保護者承認、宿題・持ち物、先生ログイン情報(ハッシュ)、操作ログ | 場所: マイドライブ/ステップワイズ塾/ |
| Drive: スプレッドシート「塾管理台帳」 | 生徒台帳、成績推移、模試、入金管理、面談記録 | 同上。ID は `Code.gs` の `LEDGER_ID` |
| Drive フォルダ「ステップワイズ塾」 | `01_生徒/<生徒>/`(成績票PDFなど)、`02_契約・規約`、`03_教材`、`04_経理`、`99_アーカイブ` | PC では Google Drive for Desktop で `G:\マイドライブ\ステップワイズ塾\` として見える |
| 生徒の端末 | ブラウザに専用リンクのコードと表示キャッシュが残るだけ | 正本ではない |

## 3. スプレッドシートの中身

### 3-1. 「ステップワイズ予約システム」(アプリ用。列名は英語)

| シート | 列 | 意味 |
|---|---|---|
| config | key, value | 設定と先生のログイン情報。`passHash`/`passSalt`(パスワードのハッシュ)、`adminToken`/`adminTokenExp`(ログイン中トークン。1か所のみ有効)、`teacherEmail`、`calendarSync`、`emailNotify`、`reset*`(パスワード再設定コード)、`failCount`/`lockUntil` |
| students | id, name, active, email, code, rate30, monthly, parentToken, parentExp | 生徒。`code` が専用リンク(`/yoyaku/?k=code`)の鍵。`rate30` は30分単価、`monthly` は月謝(あれば定額)。`active=false` は停止中 |
| slots | id, date, start, min, status, studentId, done, eventId, meetUrl, subject, req | 授業枠。`status` は open(空き)/offered(案内中=承認待ち)/booked(確定)。`done=true` で実施済み。`eventId`/`meetUrl` はカレンダー連携。`req` は取消依頼のJSON |
| blocked | id, studentId, date, note | 生徒の「授業できない日」 |
| wishes | id, studentId, date, start, end, note, createdAt, kind | 生徒の希望日程。`kind` は want(この日時に授業をしたい)/ok(この時間帯のどこかで) |
| events | id, studentId, date, dateTo, title, createdAt, kind | 生徒が共有した予定(大会・見学など)。`kind=test` はテスト・模試(マイページでカウントダウン表示) |
| plans | id, studentId, ym, subject, count, status, proposedAt, approvedAt, approvedVia, memo | 月の授業回数(計画)。`ym` は `YYYY-MM` か `default`(毎月の既定)。`status` は draft/proposed/approved、`approvedVia` は parent(保護者ページで承認)/teacher(LINE・電話で承諾を先生が記録) |
| tasks | id, studentId, type, title, due, createdAt, createdBy, doneAt | 宿題・持ち物(やること)。生徒も先生も追加できる |
| log | time, message | 操作ログ(日本語1行) |

### 3-2. 「塾管理台帳」(人が見る台帳。列名は日本語。シートを直接編集してもよい)

| シート | 列 |
|---|---|
| 生徒台帳 | 生徒ID, 氏名, ふりがな, 学年, 学校, 保護者名, 保護者連絡先, メール, 入塾日, 状態, 科目, 単価(30分), 月謝, 備考 |
| 成績推移 | 日付, 生徒ID, 氏名, テスト名, 科目, 点数, 満点, 偏差値, 順位, 備考(1行=1科目) |
| 模試 | 日付, 生徒ID, 氏名, 模試名, 回, 学年, 国語, 国語偏差値, 数学, 数学偏差値, 社会, 社会偏差値, 理科, 理科偏差値, 英語, 英語偏差値, 3教科, 3教科偏差値, 5教科, 5教科偏差値, 3教科順位, 5教科順位, 受験者数, 志望校判定(" / "区切り), 資料URL(成績票PDF。先生のみ表示), 備考(1行=1回分) |
| 入金管理 | 年月, 生徒ID, 氏名, 請求額, 請求日, 入金日, 入金方法, 状態, 備考 |
| 面談記録 | 日付, 生徒ID, 氏名, 相手, 方法, 内容, 次のアクション |

`生徒ID` は「ステップワイズ予約システム」students シートの `id` と同じ値で、2つのファイルをつないでいます。

## 4. 画面

| URL | 誰が | 中身 |
|---|---|---|
| `/yoyaku/?k=<code>` | 生徒(LINEで専用リンクを配布) | マイページ。タブ: 予定(予定表カレンダー・予定管理・授業登録の確定/再調整)/ 成績(模試・成績推移)/ 授業の記録 / 保護者(パスワード制。今月の授業・お支払い・授業回数の承認) |
| `/kanri/` | 先生(メール+パスワードでログイン。PIN は廃止、再設定は登録メール宛の6桁コード) | ホーム(取消依頼・共有予定・希望、今日/今週、全体の予定表、生徒カード)/ 授業(案内フォーム・承認待ち・カレンダー・NG日・実施記録と請求文面)/ 生徒(追加・停止中)/ 生徒カルテ `#s=<id>`(予定表、基本情報、リンク設定、今月の授業と請求、月の授業回数と承認、成績推移、模試、今後の予定、履歴、入金、面談)/ 設定 |

保護者ページのパスワードは、いまは先生の管理ログインのパスワードと同じです。

## 5. API(Apps Script)

- 呼び出しは `POST /exec` に JSON。`action` で分岐。生徒側は `k`(専用リンクのコード)で本人確認、先生側は `action:"admin"` + `token`(ログイン時に発行)+ `op`。
- 生徒側 action: accept / decline / cancelReq / wish / unwish / wishMany / eventAdd / eventAddMany / eventDel / block / unblock / blockSet / taskAdd / taskDone / taskDel / grades / parentLogin / parentData / parentPlanDecide
- 先生側 op: state / offer / deleteSlot / unbook / toggleDone / addStudent / setEmail / setFee / newCode / addBlock / delBlock / hideStudent / changePass / resolveCancel / delWish / delEvent / planSet / planPropose / planApproveTeacher / taskAdd / taskDone / taskDel / kanriDashboard / kanriStudent / kanriSaveProfile / kanriAddGrade / kanriAddExam / kanriAddPayment / kanriSetPaid / kanriAddMeeting / kanriDeleteRow / kanriSetActive / logout。ログイン前: login / setupAccount / resetRequest / resetConfirm
- 主なルール: 確定授業の取消は生徒からの「依頼」で先生が承認(締切は授業の24時間前 `CANCEL_DEADLINE_H`)。月の授業回数は保護者(または先生が記録した承諾)の承認がないと請求できない前提。
- エディタから手で実行する関数: `setup`(初回のシート作成)、`resetTeacherLogin`(先生ログイン初期化)、`kanriSelfTest`。

## 6. 更新・デプロイ手順

1. ローカル `C:\Users\mugir\dev\stepwise-eisu` を編集し、`git commit` → `git push origin main`。GitHub Pages に1〜2分で反映(ブラウザキャッシュに注意)。
2. `gas/Code.gs` を変えたときは、Apps Script エディタ(スプレッドシート「ステップワイズ予約システム」→ 拡張機能 → Apps Script)に全文貼り付け → 保存 → 「デプロイ」→「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」→ デプロイ。URL は変わりません。
3. 新しいシートや列は、コード側の `ensureSchema_` / `LEDGER_COLS` が初回アクセス時に自動で作ります。
4. 動作確認はテスト用の生徒(名前に【テスト】が付いている生徒)で行い、本物の生徒の予定・記録は触りません。

## 7. 運用メモ

- 先生のログインは1か所のみ有効。別端末でログインすると前のログインは切れます。
- パスワードを忘れたら管理画面の「パスワードを忘れた」→ 登録メール(mugilives@gmail.com)に届く6桁コードで再設定。
- 通知メールは Apps Script から Gmail で送信(送信済みに残る)。確定授業は Google カレンダーにも作成(写し)。
- バックアップは Drive のスプレッドシート2つをコピーすれば足ります。

## 8. 別チャット・他のAIから参照するとき

- まずこのファイル(GitHub: `docs/SYSTEM.md`)。同じ内容を Drive `ステップワイズ塾/00_システム概要.md` にも置いています(こちらは手でコピーしているので、GitHub 側が最新)。
- コードの詳細は `gas/Code.gs`(先頭のコメントにセットアップ手順)、画面は各 `index.html` 1ファイル完結(外部ライブラリなし)。
- 生徒の実データはスプレッドシートにしかありません。AIに読ませるときは氏名・連絡先を含むので取り扱いに注意。

## 9. 変更履歴(要点)

- 2026-08-29 予約システム稼働(GAS + Pages)
- 2026-09-04 管理画面 `/kanri/` 追加、生徒管理を管理画面へ移行、高速化
- 2026-09-05 生徒ページをマイページ化(タブ、保護者ページ、希望日程・共有予定・授業できない日、月の授業回数と保護者承認、宿題・テスト予定)、パスワード再設定をメールコード方式に
- 2026-09-05 模試(北辰テスト)の記録を追加(台帳「模試」シート、管理画面・生徒ページで表示)
