# Implementation Plan: kumo CLI にブラウザでログインする（kumo login / logout）

**Branch**: `003-cli-login` | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-cli-login/spec.md`

## Summary

kumo CLI に `kumo login`、`kumo login --status`、`kumo logout` を加え、ブラウザで所有者としてログインするだけで管理操作を使えるようにする。
管理用 Worker の Access アプリで有効にした Managed OAuth（ベータ）を使い、CLI は OAuth 2.0 の公開クライアントとしてトークンを得て、
`Authorization: Bearer` で管理 API を呼ぶ。Access がトークンを所有者の JWT に変えて Worker に渡すので、管理用 Worker（`apps/admin`）、配信用 Worker、
D1、R2、`packages/shared` は変えない。既存のサービストークンの経路も、そのまま動かす。全体の決定は Issue #3、本番での検証は #4 にある。

技術的な要点（詳細は [research.md](./research.md)）:

- 認可コードフロー（PKCE S256、`state`、RFC 8707 の `resource`）。受け取りは `127.0.0.1` の空いているポート。クライアントは動的登録で PC ごとに 1 回だけ作る（L5・L6）
- 接続先の情報は、管理用 Worker の URL の `/.well-known/oauth-protected-resource` と `/.well-known/oauth-authorization-server` から得る（L4）
- ログインの記録は `config.json` と同じフォルダーの `login.json` に平文で保存する。一時ファイルに書いてから置き換え、Windows 以外は 600（L9）
- 期限の 60 秒前と 401 のときに、1 回だけ更新する。古いリフレッシュトークンも使えるので、ロックは使わない（L8）
- 資格情報の順は「環境変数のサービストークン → ログイン → `config.json` のサービストークン」。トークンはログインした URL にだけ送る（L10）
- Access の設定は、アクセストークン 15 分、許可 1 週間、転送先はループバックだけ（L3。設定は #9）
- 依存は増やさない（`fetch`、`node:http`、`node:crypto`、`node:child_process`、`node:fs`）

## Technical Context

**Language/Version**: TypeScript 7.0（型検査）、Node.js 22.18 以上（CLI はビルドせず型除去で実行。001 の research R16）

**Primary Dependencies**: 追加なし。既存の commander 15、exiftool-vendored 39、markdown-it 15.0.2、`@mdit/plugin-tasklist` 1.1.3 のまま。
OAuth の処理は Node.js の標準機能で書く。外部サービスとして、Cloudflare Access の Managed OAuth（ベータ。既存の Access の機能）を使う

**Storage**: 所有者の PC の `login.json`（新規、[data-model.md](./data-model.md)）。`config.json` は読むだけ。D1 と R2 は変更なし

**Testing**: Vitest 5（Node.js 上、`apps/cli`）。Access の代わりに、ローカルの HTTP サーバーで偽の認可サーバー兼管理 API を作る（research L16）。
Worker のテストは変更しない

**Target Platform**: 所有者の Windows PC（CLI）。macOS と Linux でも動くようにする。社内プロキシの内側でも使う

**Project Type**: CLI ＋ 2 つの Web サービス（npm workspaces のモノレポ）。今回変えるのは CLI と、その使い方の文書（README、runbook の §3・§7・§10）。Access の設定値と runbook §6 は #9 で変える

**Performance Goals**: ブラウザでのログインの待ち時間を除き、`kumo login` は数秒で終わる。新しい PC でのインストールから最初の管理操作まで 3 分以内（SC-001）。
期限前の更新は管理操作 1 回あたり最大 1 往復を足すだけ

**Constraints**:

- 管理用 Worker の認証（`apps/admin/src/auth.ts`）、管理 API、D1、`packages/shared` を変えない（FR-022）
- 既存のサービストークンの経路の振る舞いと、既存のテストの期待を変えない（FR-021）
- 資格情報をどの出力にも出さない（FR-015）。トークンはログインした URL と、メタデータのエンドポイントにだけ送る（FR-013）
- 依存を増やさない（#3 の決定、憲法 VII）
- Cloudflare の設定はこの PR では変えない。最終的な期間の値は #9 で設定する

**Scale/Scope**: 利用者 1 人、PC は数台。CLI のソースに 7 ファイル（`login-store.ts`、`oauth.ts`、`loopback.ts`、`browser.ts`、`credentials.ts`、
`commands/login.ts`、`commands/logout.ts`）を加え、`config.ts`、`api.ts`、`runtime.ts`、`commands/index.ts`、`main.ts` を変える

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

憲法 v2.1.0（2026-10-19 改正）に対して確認する。**改正は要らない**。

| 原則 | この計画での対応 | 判定 |
|---|---|---|
| I. 原本は手元、棚には共有用のコピーだけ | ファイルの扱いは変えない | PASS |
| II. 既定は非公開、共有はリンクで行う | リンクの仕組みは変えない | PASS |
| III. 書き込み経路は管理 API だけ | 管理操作は今までどおり管理 API を通る。変わるのは、管理 API に送る資格情報の種類だけ | PASS |
| IV. 多層防御 | 管理 API が受け付けるのは、今までどおり「所有者のメールアドレス」と「CLI 用のサービストークン」だけ。ログインの経路は、Access の `owner` ポリシー（所有者のメールアドレス）でしかトークンが出ず、Worker には所有者の `email` を持つ JWT として届く。Worker の JWT の検証（署名と `aud`）は変えないので、Access の設定だけに依存しない。CSRF 対策（独自ヘッダー）もそのまま。トークンはリポジトリに含めず、所有者の PC の `login.json` にだけ置く（L9・L15） | PASS |
| V. コストには上限を設ける | Access の Managed OAuth は Zero Trust の Free プランで使える（L2）。Worker の処理は増えない（トークンの確かめは Access が行う） | PASS |
| VI. 重要な経路は自動テストで守る | 管理用 Worker の認証は変えず、既存の workerd のテストで守られたまま。CLI のログイン・更新・取り消し・出力から隠すことは、偽の認可サーバーを使った CLI のテストで守る（L16） | PASS |
| VII. 小さく保つ | 依存を増やさない。外部サービスは既存の Access の機能（Managed OAuth）を使うだけで、追加の理由と退路を research L1 に記録した。Managed OAuth はベータで版を固定できないため、使えなくなったときはサービストークン（環境変数・`config.json`）で使い続ける。CLI はエンドポイントをメタデータから得て、URL を決め打ちしない。なお、憲法の「ベータ版のツールは版を完全に固定する」はツールを想定した文言で、版を固定できないベータの機能の扱いは書かれていない。「固定できないベータの機能は、退路を記録して使う」と明記する改正は、#10 を決めるときか次の PATCH の改正で行う（PR #11 のレビューの指摘 13。この PR では改正しない） | PASS |
| 技術・運用上の制約 | Access の設定（Managed OAuth）は手順書に残す必要がある。#4 で検証用の値のまま有効にしてあり、今の値と設定の手順（GET → PUT → 差分の確認）は research L2 に記録した。最終的な値と手順は #9 で runbook §6 に書く（tasks の Phase 8）。設定は `cf zero-trust access applications update --body` かダッシュボードで行い、`cf` は今の版（1.0.0-beta.13）のまま | PASS（#9 で手順書を更新するまで、本番の設定が手順書より先行している点を tasks で追う） |

**Phase 1 後の再確認**: data-model（Worker 側の変更なし、`login.json` の追加）と contracts（CLI の設定・`login`・`logout`・案内、管理 API の 1 段目の追加）を
確認し、違反はない。001 の FR-031（入口と本体の 2 か所での確認）と FR-033（資格情報を出力しない）にも合う。

## Project Structure

### Documentation (this feature)

```text
specs/003-cli-login/
├── plan.md              # この計画
├── research.md          # Phase 0: 技術上の決定と、#4 の検証の結果（L1〜L17）
├── data-model.md        # Phase 1: login.json と CLI の中の値（Worker 側の変更なし）
├── quickstart.md        # Phase 1: 検証手順（ローカルと本番）
├── contracts/
│   ├── cli.md           # 設定の優先順位、kumo login / --status / logout、エラーの案内
│   └── admin-api.md     # 認証の 1 段目に Bearer の経路、Access が提供するエンドポイント
├── checklists/
│   └── requirements.md  # 仕様の品質チェック
└── tasks.md             # Phase 2（/speckit.tasks で作成）
```

### Source Code (repository root)

```text
apps/cli/
├── src/
│   ├── config.ts            # 変更: login.json のパス（loginFilePath）。既存の loadConfig はサービストークンの経路としてそのまま使う
│   ├── login-store.ts       # 新規: login.json の読み込みと検証、一時ファイルからの置き換え、権限、session の削除
│   ├── oauth.ts             # 新規: 探索、動的登録、PKCE と state、認可の URL、交換、更新、取り消し（fetch だけ）
│   ├── loopback.ts          # 新規: 127.0.0.1 での受け取り（state・Host・error・時間切れ、完了のページ）
│   ├── browser.ts           # 新規: URL を既定のブラウザで開く（シェルを通さない。差し替え可能）
│   ├── credentials.ts       # 新規: 資格情報の選択（L10）と、方法ごとのヘッダー・更新・保存・隠す値
│   ├── api.ts               # 変更: 資格情報の方法を受け取り、401 で 1 回だけ更新してやり直す。案内を方法で出し分ける（L11）
│   ├── runtime.ts           # 変更: 資格情報の選択から AdminApi を作る（既存のテスト用の差し替え口は残す）
│   ├── main.ts              # 変更: 説明文
│   └── commands/
│       ├── login.ts         # 新規: kumo login [<adminUrl>] [--no-open] [--status]
│       ├── logout.ts        # 新規: kumo logout
│       └── index.ts         # 変更: login と logout の登録
└── test/
    ├── helpers.ts           # 変更: 偽の認可サーバー兼管理 API、一時の設定フォルダー
    ├── login-store.test.ts  # 新規
    ├── oauth.test.ts        # 新規
    ├── loopback.test.ts     # 新規
    ├── credentials.test.ts  # 新規
    ├── api.test.ts          # 変更: Bearer、更新とやり直し、案内の出し分け（既存の期待は変えない）
    ├── login.test.ts        # 新規
    └── logout.test.ts       # 新規

docs/runbook.md                                   # 実装の PR: §3・§7・§10。#9: §6（Access の設定値と手順）・§11 と §12（検証の記録）
README.md                                         # 実装の PR: 使い方に kumo login・logout
specs/001-share-shelf-mvp/contracts/cli.md        # 注記: 設定は 003 で置き換えた
specs/001-share-shelf-mvp/contracts/admin-api.md  # 注記: 認証の 1 段目に 003 の経路
specs/001-share-shelf-mvp/research.md             # 注記: R3 に 003 の経路
```

変更しないもの: `apps/admin/**`、`apps/files/**`、`apps/admin/migrations/**`、`packages/shared/**`、`apps/cli/package.json` の依存。

**Structure Decision**: 001・002 の構成のまま、CLI（`apps/cli`）の中だけで完結させる。プロトコルの部品（`oauth.ts`・`loopback.ts`・`browser.ts`）、
保存（`login-store.ts`）、選択と更新（`credentials.ts`）、コマンド（`commands/login.ts`・`commands/logout.ts`）に分け、`AdminApi` は「方法」を受け取るだけにする。
サービストークンの経路は今の `loadConfig` と案内をそのまま包むので、既存のテストは変えずに通る。各部品は `fetch` とブラウザを開く関数を差し替えられるようにし、
偽の認可サーバーでテストする。

作業は Issue に合わせて分ける（tasks.md）: #6（ログイン）、#7（保存・更新・管理操作への組み込み）、#8（ログアウト）は実装の PR で行い、
README と runbook（§3・§7・§10）の利用者向けの更新もこの PR に含める（tasks の Phase 7）。機能をマージした時点で、main の文書が新しいコマンドに
追いついているようにするため。#9（Access の最終的な値の設定、runbook §6 の設定手順、§11・§12 への本番での確認の記録）はその後に行う（Phase 8）。
#10（サービストークンを残すか）はこの仕様の範囲外。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

違反はない。
