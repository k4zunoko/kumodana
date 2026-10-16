# Quickstart: 共有棚 MVP の検証手順

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

実装が仕様どおりに動くことを確かめる手順。Cloudflare 側の初期設定とデプロイの詳細は
`docs/runbook.md`（実装時に作成）に置き、ここでは検証に必要な流れだけを示す。

## 前提

- Node.js 22.18 以上（Bun は不可）。npm の `min-release-age=7` を前提にしている
- `cf` にログイン済み（`cf auth login`）
- Zero Trust を有効化済み（チーム名を決め、支払い方法を登録）。R2 も有効化済み
- 社内プロキシ環境では `NODE_USE_ENV_PROXY=1` と `HTTPS_PROXY` を設定済み

## 1. ローカルでの検証（自動テスト）

```sh
npm ci
npm run typecheck
npm test
```

期待結果: すべて成功する。テストは次を含む（憲法 VI）。

- 認証: JWT なし・署名不正・`aud` 違い・期限切れ・許可されていない主体を拒否し、所有者のメールと CLI のクライアント ID を許可する
- CSRF: `X-Kumodana-Client` なし、`Origin` あり、`Sec-Fetch-Site: cross-site` を拒否する
- 上限: 小さい上限で超過を拒否し、`details` に使用量・上限・要求サイズが入る。同時アップロードでも超えない
- リンク: 解決、取り消し後の 404、取り消し済み・不存在・削除済みの 404 が同一、クエリ付きの 301
- 配信ヘッダー: [contracts/delivery.md](./contracts/delivery.md) のヘッダーがすべて付く
- CLI: EXIF の削除（位置情報が消え、向きが残る）、原本が変わらない、対象外形式の拒否
- 削除と後始末: 削除したファイルがただちに一覧と配信から消え、キャッシュ削除に失敗しても削除は完了する。
  途中で止まった削除と処理中の残骸は定期実行で片付く。中断したアップロードは 10 分を過ぎると置き直せる
- タグ: 複数タグでの絞り込み（AND）とタグの一覧（件数付き）

## 2. 初回のプロビジョニングとデプロイ

`docs/runbook.md` に従って次を行う。

1. D1 データベース `kumodana` と R2 バケット `kumodana` を作成する
2. マイグレーションを適用する（`cf d1 migrations apply <DATABASE_ID> --dir apps/admin/migrations`）
3. 配信用 `kumo`、続いて管理用 `kumodana-admin` をデプロイする（管理用は `--secrets-file` を付ける）
4. CLI 用のサービストークンを発行し、管理用 Worker に Worker 単位の Access をかける
   （所有者のメールを許可＋サービストークンの Service Auth）
5. 予算アラート（$1）と R2 の使用量通知を設定する
6. CLI の設定（[contracts/cli.md](./contracts/cli.md)）を書く

## 3. 本番での検証シナリオ

### US1: 置いてリンクで共有する

```sh
kumo put ./photo-with-gps.jpg --link
kumo put ./page.html --link
```

- 期待: ID とリンクが表示される。リンクをログインしていないブラウザ（PC とスマートフォン）で開くと表示される
- 期待: リンクから保存した画像を `exiftool` で調べると位置情報がない。向きは正しい
- 期待: `photo-with-gps.jpg` の原本は内容・更新日時ともに変わらない
- 期待: `kumo put ./video.mp4` は対象外として拒否され、何も保存されない

### US2: リンクの管理と取り消し

```sh
kumo link create <id> --label "Aさん"
kumo link create <id> --label "Bさん"
kumo link ls <id>
kumo link revoke <Aさんのリンク>
```

- 期待: 取り消しの 1 分後、A さんのリンクは「見つからない」、B さんのリンクは表示される
- 期待: `<リンク>?fbclid=test` を開くと、正規の URL へ転送されて表示される

### US3: 保存量の上限

```sh
kumo usage
```

- 期待: 使用量・上限・残り・ファイル数が表示される
- 上限超過の検証は自動テスト（小さい上限）で行う。本番で 8GB を埋める検証はしない

### US4: 整理

```sh
kumo tag <id1> +旅行 +2026
kumo tag <id2> +旅行 +2025
kumo tags
kumo ls --tag 旅行
kumo ls --tag 旅行 --tag 2026
kumo get <id1>
kumo rm <id1>
```

- 期待: `kumo tags` に「旅行 2」「2026 1」「2025 1」が表示される
- 期待: `--tag 旅行` は 2 件、`--tag 旅行 --tag 2026` は `<id1>` の 1 件だけが表示される
- 期待: `rm` の後はそのファイルが一覧から消え、リンクが「見つからない」になり、使用量が減る

### 隔離の確認（SC-006）

- 次を試みる検証用 HTML を置いてリンクで開く: 管理 API への `fetch`（`credentials: "include"`）、
  `document.cookie` の読み書き、`localStorage` の利用、別のリンクの内容の読み取り
- 期待: すべて失敗する（ブラウザの開発者ツールでエラーを確認する）

### キャッシュの確認（SC-007）

- 同じリンクを 2 回開き、2 回目の応答ヘッダーが `cf-cache-status: HIT` であることを確認する

## 4. 緊急停止の訓練

- `docs/runbook.md` の手順（`cf workers triggers deploy --mode stopped`）で配信を止め、リンクが開けなくなることを
  確認する。元の設定で再適用すると戻ることを確認する
