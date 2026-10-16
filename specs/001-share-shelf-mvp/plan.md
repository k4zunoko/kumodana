# Implementation Plan: 共有棚 MVP（画像と HTML をリンクで共有する）

**Branch**: `001-share-shelf-mvp` | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-share-shelf-mvp/spec.md`

## Summary

自分専用の共有棚を、Cloudflare の Workers、R2、D1、Access、Workers Cache で作る。所有者は kumo CLI から
管理用 Worker（`kumodana-admin`、Access と JWT 検証で保護）を通じてファイルを置き、タグで整理し、リンクを
発行・取り消す。閲覧者は配信用 Worker（`kumo`、Workers Cache 有効）からリンクで閲覧する。

**用語**: 文書では、コマンドを「kumo CLI」、配信用の Worker を「配信用 Worker（`kumo`）」と書き分ける。
配信用 Worker のソースは `apps/files`、管理用 Worker からのサービスバインディング名は `FILES`。

技術的な要点（詳細は [research.md](./research.md)）:

- Worker を管理用と配信用に分け、キャッシュの削除は配信用の RPC `purge(tags)` で行う
- 保存量の上限は、処理中・削除中を含む合計を条件にした 1 文の `INSERT` で原子的に判定する
- ファイルの状態を `pending`・`ready`・`deleting` で管理し、「`ready` なら R2 に実体がある」を常に保つ
- 重い処理（EXIF の削除、SHA-256、形式の判定）は CLI で行い、Worker は R2 へ流し込むだけにする
- 配信するすべての応答に CSP の `sandbox` などの防御用ヘッダーを付ける。エッジの保持は最長 1 時間
- 整理はタグだけ（複数タグの AND 絞り込みと、件数付きのタグ一覧）。アルバムは作らない（憲法 v2.0.0）

## Technical Context

**Language/Version**: TypeScript 7.0（型検査）、Node.js 22.18 以上（CLI と開発ツール）、Workers ランタイム
（compatibility date は実装開始時の `cf init` の値に固定）

**Build**: Worker は `cf build`（Vite）でバンドルする。CLI はビルドせず、Node.js の型除去で直接実行する（research R16）

**Primary Dependencies**:
- 管理用 Worker: Hono 4、Zod 4、jose 6
- 配信用 Worker: なし（`WorkerEntrypoint` のみ）
- CLI: commander、exiftool-vendored
- 開発: `cf`（1.0.0-beta、完全固定）、Vite 8、`@cloudflare/vite-plugin` 2.0 beta（完全固定）
- 版は、導入時点で公開から 7 日以上経った最新版に完全固定する

**Storage**: D1（メタデータ、DB 名 `kumodana`）、R2（ファイルの実体、バケット名 `kumodana`、公開しない）

**Testing**: Vitest 4、`@cloudflare/vitest-plugin`（Worker 用、`experimental.newConfig`）、Vitest（CLI 用、Node.js 上）

**Target Platform**: Cloudflare Workers（無料プラン、`meshnode.workers.dev`）、所有者の Windows PC（CLI）

**Project Type**: CLI ＋ 2 つの Web サービス（npm workspaces のモノレポ）

**Performance Goals**: 5MB の画像を置いてリンクを得るまで 15 秒以内（SC-001）。キャッシュに当たった閲覧では
Worker を動かさない（SC-007）

**Constraints**:
- Workers 無料プラン: 1 日 10 万リクエスト（キャッシュのヒットも数える）、1 回 10ms の CPU
- リクエスト本文は 100MB まで、Workers Cache の応答は 512MB まで
- キャッシュの削除は 1 分あたり 5 回（バケット 25）
- R2 の保存量はアプリ側で 8 × 10⁹ バイトまで

**Scale/Scope**: 利用者 1 人、ファイル数は 1 万件程度まで、保存量 8GB まで

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | この計画での対応 | 判定 |
|---|---|---|
| I. 原本は手元、棚には共有用のコピーだけ | CLI は原本を読み取るだけで、EXIF の削除は一時コピーで行う。バックアップ機能は持たない | PASS |
| II. 既定は非公開、共有はリンクで行う | リンクなしのファイルは配信されない。トークンは 128 ビット。取り消しは D1 の記録＋タグでのキャッシュ削除。削除の失敗は `purge.ok=false` で知らせる。ブラウザ側の保持は 60 秒、エッジは最長 1 時間（失敗時の最悪値）。公開一覧・期限付きリンクなし | PASS |
| III. 書き込み経路は管理 API だけ | R2 と D1 への書き込みは管理用 Worker のみ。配信用 Worker は読み取りと自身のキャッシュ削除だけ。R2 の実体を消すのは `pending`・`deleting` のときだけで、`ready` には必ず実体がある。残骸は定期実行で片付ける | PASS |
| IV. 多層防御 | Worker 単位の Access ＋ jose による JWT 検証。Worker を 2 つに分け、`previewUrls: false`。全配信応答に sandbox などのヘッダー。管理 API は独自ヘッダー必須・他オリジンを拒否。EXIF は既定で削除。個人の識別子とシークレットは `--secrets-file`（gitignore） | PASS |
| V. コストには上限を設ける | Workers 無料プラン。上限は 1 文の条件付き `INSERT`。配信は Workers Cache、クエリ付きは 301。重い処理は CLI。予算アラートと緊急停止は runbook | PASS |
| VI. 重要な経路は自動テストで守る | 認証、CSRF、上限、リンクの解決と取り消し、配信ヘッダーを `@cloudflare/vitest-plugin` で workerd 上でテスト。デプロイ前に型検査とテスト | PASS |
| VII. 小さく保つ | MVP の範囲のみ。整理はタグだけでアルバム・ギャラリーなし。依存は憲法の基準どおり（形式判定は自前で `file-type` を使わない）。ベータ版ツールは完全固定 | PASS |

**Phase 1 後の再確認**: data-model と contracts を確認し、違反はない。2 つの Worker と共有パッケージ 1 つの構成は、
憲法 IV（Worker の分離）と R2・R13 の理由により必要で、より少ない構成は要件を満たせない（Complexity Tracking には
該当しない）。

## Project Structure

### Documentation (this feature)

```text
specs/001-share-shelf-mvp/
├── plan.md              # この計画
├── research.md          # Phase 0: 技術調査と決定
├── data-model.md        # Phase 1: テーブルと状態遷移
├── quickstart.md        # Phase 1: 検証手順
├── contracts/
│   ├── admin-api.md     # 管理 API
│   ├── delivery.md      # 配信
│   ├── files-rpc.md     # 管理用 → 配信用の RPC
│   └── cli.md           # kumo CLI
├── checklists/
│   └── requirements.md  # 仕様の品質チェック
└── tasks.md             # Phase 2（/speckit.tasks で作成）
```

### Source Code (repository root)

```text
package.json                 # npm workspaces、共通スクリプト（typecheck、test）
tsconfig.base.json
.gitignore                   # node_modules、.cloudflare、.env、.secrets.*.json など
docs/
└── runbook.md               # 初期設定、デプロイ、Access、予算アラート、緊急停止

packages/
└── shared/                  # 管理用 Worker と CLI で共有
    ├── src/
    │   ├── api-types.ts     # FileSummary、Link、Usage、PurgeResult、エラーコード
    │   ├── limits.ts        # 許可する形式、最大サイズ
    │   ├── ids.ts           # ID とトークンの生成・検証
    │   └── names.ts         # タグの正規化・検証
    └── test/

apps/
├── admin/                   # Worker: kumodana-admin
│   ├── cloudflare.config.ts # D1、R2、FILES（サービスバインディング）、secret、cron、workersDev、previewUrls
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── migrations/
│   │   └── 0001_init.sql
│   ├── src/
│   │   ├── index.ts         # エントリ（fetch と scheduled）
│   │   ├── app.ts           # Hono アプリの組み立て（CSRF → 認証 → ルート）
│   │   ├── auth.ts          # Access JWT の検証と主体の判定
│   │   ├── csrf.ts          # 独自ヘッダー・Origin・Sec-Fetch-Site の検査
│   │   ├── errors.ts        # エラー応答の生成
│   │   ├── purge.ts         # FILES.purge の呼び出し（テストで差し替え可能）
│   │   ├── db/              # files、links、tags、usage の SQL
│   │   ├── routes/          # usage、files、tags、links（app.ts で登録）
│   │   └── cleanup.ts       # pending と deleting の片付け
│   └── test/
├── files/                   # Worker: kumo
│   ├── cloudflare.config.ts # D1、R2、cache、workersDev、previewUrls、停止用モード
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts         # WorkerEntrypoint: fetch と purge
│   │   └── headers.ts       # 配信用ヘッダー
│   └── test/
└── cli/                     # kumo コマンド
    ├── package.json         # bin: kumo
    ├── src/
    │   ├── main.ts          # commander の定義
    │   ├── config.ts        # 環境変数と設定ファイル
    │   ├── api.ts           # 管理 API クライアント
    │   ├── sniff.ts         # 形式の判定
    │   ├── exif.ts          # EXIF の削除（一時コピー）
    │   ├── output.ts        # 人向けと JSON の出力、終了コード
    │   └── commands/        # put、ls、get、rm、tag、tags、link、usage
    └── test/
```

**Structure Decision**: npm workspaces のモノレポにする。`apps/admin` と `apps/files` はそれぞれ独自の
`cloudflare.config.ts` を持つ（`cf` の設定は 1 ファイルに 1 Worker）。マイグレーションはスキーマを所有する
`apps/admin` に置く。CLI だけが使う形式判定と EXIF 処理は `apps/cli` に置き、共有するのは API の型と検証だけにする。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

違反はない。
