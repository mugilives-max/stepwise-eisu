# stepwise-eisu — AI共通の入口

Claude / Codex 共通。塾のホームページと予約・管理システム。画面はGitHub Pages、APIはApps Script、業務データはDriveの2台帳にある。

## 重要な制約

- 作業開始時はGitの状態を確認し、既存の変更を上書きしない。共有作業先は `C:\Users\mugir\dev\stepwise-eisu`。同じファイルを同時編集しない。
- 動作確認の書き込みは名前が `【テスト】` で始まる生徒だけ。実生徒の予定・記録はテストで変更しない。移行・上書き・削除は対象と差分を確認し、復元可能にしてから行う。
- 公開リポジトリに実生徒の氏名・ID・専用リンク・認証情報を置かない。先生のパスワードは本人が入力する。新しいOAuth権限への同意はユーザーの明示的な承認が必要。既に許可された作業で段階ごとの再承認は求めない。
- `gas/*.gs` は本番の写し。GitへのpushだけではGASに反映されない。変更時は下記の反映手順を参照する。

## 必要なときに読む

全資料の通読は不要。対象に関係する節とコードを読む。

| 作業 | 正本・参照先 |
|---|---|
| 構成、台帳、画面、API、デプロイ | [SYSTEM.md](docs/SYSTEM.md) |
| 未完了事項、次の作業、運用上の判断 | [FUTURE_WORK.md](docs/FUTURE_WORK.md) |
| 保護者認証の変更・検証・復旧 | [PARENT_AUTH.md](docs/PARENT_AUTH.md) |
| MCPの接続・停止・更新 / 将来の書き込み設計 | [MCP_OPERATIONS.md](docs/MCP_OPERATIONS.md) / [MCP_DESIGN.md](docs/MCP_DESIGN.md) |
| 授業サイクルの導入順 / 初回実装 | [REDESIGN_MASTER_PLAN.md](docs/REDESIGN_MASTER_PLAN.md) / [LESSON_CYCLE_PHASE1_SPEC.md](docs/LESSON_CYCLE_PHASE1_SPEC.md) |
| 過去の調査根拠 / 契約条項の検討 | [REDESIGN_CURRENT_STATE.md](docs/REDESIGN_CURRENT_STATE.md) / [CONTRACT_CLAUSES_DRAFT.md](docs/CONTRACT_CLAUSES_DRAFT.md) |

仕様や運用が変わったら該当する正本を更新し、後続作業に影響する未解決事項だけをFUTURE_WORKへ残す。別の引き継ぎ資料やDriveの本文コピーを増やさない。

確認は影響に合わせる。文書だけならリンク・参照・記述の整合、コードなら変更した機能の構文・回帰テスト、公開時は影響する画面/APIの反映を確認する。全テストや本番操作を毎回一律に行わない。
