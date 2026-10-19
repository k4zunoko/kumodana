# kumodana 運用手順書（runbook）

初期設定、デプロイ、日常の運用、緊急停止の手順をまとめる。コマンドはリポジトリのルートで実行する
（`cf` はプロジェクトに入っている版を `npx cf` で使う）。

- 管理用 Worker: `kumodana-admin`（`https://kumodana-admin.<subdomain>.workers.dev`、Access で保護）
- 配信用 Worker: `kumo`（`https://kumo.<subdomain>.workers.dev/<token>`）
- `<subdomain>` はアカウントの workers.dev サブドメイン。実際の値は `apps/admin/cloudflare.config.ts` の `FILES_BASE_URL` にある
- D1: `kumodana`、R2: `kumodana`（R2 は公開しない）

## 0. 前提

- Node.js 22.18 以上（Bun は不可）。社内プロキシ経由なら `NODE_USE_ENV_PROXY=1` と `HTTPS_PROXY` を設定する
- `npm ci` 済み
- `npx cf auth login` でログイン済み（`npx cf auth whoami` で確認）
- **Workers は無料プランのまま運用する**（憲法 V）。ダッシュボードの Workers & Pages でプランが Free であることを
  確認する。有料プランへの変更は憲法の改正で決める
- R2 を有効化済み（無料枠でも支払い方法の登録が必要）
- Zero Trust を有効化済み（チーム名を決め、Free プランを選ぶ。支払い方法の登録が必要）

## 1. リソースの作成（初回のみ）

```sh
npx cf d1 create --name kumodana --primary-location-hint apac
npx cf r2 buckets create --name kumodana --location-hint apac
npx cf d1 list        # kumodana の uuid（DATABASE_ID）を控える
```

- `apps/admin/cloudflare.config.ts` と `apps/files/cloudflare.config.ts` の `bindings.d1({ name: "kumodana" })` に
  `id: "<DATABASE_ID>"` を足してコミットする（名前の変更に影響されないようにするため）。

## 2. マイグレーション

```sh
cd apps/admin
npx cf d1 migrations apply <DATABASE_ID> --dir migrations
```

スキーマを変えたときも同じコマンドを使う。ローカルの D1 はテストが毎回作り直すので、適用は不要。

## 3. CLI 用サービストークン

```sh
npx cf zero-trust access service-tokens create --name kumodana-cli --duration 8760h
```

- 出力の `client_id` と `client_secret` を控える。**`client_secret` はこのときしか表示されない**ので、
  パスワードマネージャーなどに保存する
- 有効期限（作成から 1 年）をカレンダーなどに記録する。延長は `npx cf zero-trust access service-tokens refresh <TOKEN_ID>`

## 4. シークレットファイル

リポジトリのルートに `.secrets.production.json` を作る（`.gitignore` 済み。**コミットしない**）。
形式は `secrets.production.example.json` を参照。

| キー | 値 |
|---|---|
| `OWNER_EMAIL` | 自分のメールアドレス（Access でログインするもの） |
| `CLI_CLIENT_ID` | 手順 3 の `client_id` |
| `ACCESS_TEAM_DOMAIN` | `https://<チーム名>.cloudflareaccess.com` |
| `ACCESS_AUD` | 手順 6 で作る Access アプリの AUD。初回は仮の値（例: `pending`）でよい（すべて拒否される） |

## 5. デプロイ

```sh
npm run deploy -w @kumodana/files   # 配信用 Worker を先に
npm run deploy -w @kumodana/admin   # 管理用 Worker（--secrets-file を付けて毎回シークレットを渡す）
# または npm run deploy（上の 2 つを順に実行）
```

各 `deploy` は、型検査 → テスト → `vite build` → `cf deploy --dry-run` → `cf deploy` の順に進み、
途中で失敗すると止まる（憲法 VI）。

## 6. 管理用 Worker に Access をかける

2026-10-16 に下記「API で設定する場合」の手順で作成済み（アプリ名 `kumodana-admin`、ポリシー `owner` と
`kumodana-cli`）。ブラウザでのログインは Cloudflare アカウントでのログイン（Zero Trust の既定の
ログイン方法）を使う。

### ダッシュボードで設定する

1. Workers & Pages → `kumodana-admin` → **Access** タブ → **Protect this Worker behind Access**
2. **All traffic** を選び、ポリシーで自分のメールアドレスだけを許可する
3. Zero Trust → Access → Applications で、作られたアプリを開き、ポリシーを追加する
   - Action: **Service Auth**、Include: **Service Token** = `kumodana-cli`
4. アプリの **Application Audience (AUD) Tag** を控え、`.secrets.production.json` の `ACCESS_AUD` に入れて
   `npm run deploy -w @kumodana/admin` で再デプロイする
5. Zero Trust の設定で **Strict service token authentication** を有効にする（失敗時にログイン画面へ転送せず
   401/403 を返すようになる）

### API で設定する場合

`npx cf workers list` で `kumodana-admin` の ID を、`npx cf zero-trust access service-tokens list` でトークンの ID を確認し、
次の本文を `access-app.json` に保存して作成する（形式は `npx cf schema zero-trust access applications create` で確認できる）。

```json
{
  "type": "self_hosted",
  "name": "kumodana-admin",
  "destinations": [{ "type": "worker", "worker_id": "<WORKER_ID>" }],
  "policies": [
    { "name": "owner", "decision": "allow", "include": [{ "email": { "email": "<OWNER_EMAIL>" } }] },
    { "name": "kumodana-cli", "decision": "non_identity", "include": [{ "service_token": { "token_id": "<TOKEN_ID>" } }] }
  ]
}
```

```sh
npx cf zero-trust access applications create --body "@C:\path\to\access-app.json"
```

Windows の Git Bash では `--body "$(cat ...)"` が JSON として解釈されないため、`@<Windows のパス>` で渡す。

## 7. CLI の設定

```sh
npm install -g ./apps/cli    # kumo コマンドを登録（ビルド不要。Node.js の型除去で直接動く）
```

`%APPDATA%\kumodana\config.json`（Windows）に書く。環境変数 `KUMODANA_ADMIN_URL`・`KUMODANA_CLIENT_ID`・
`KUMODANA_CLIENT_SECRET` があればそちらが優先される。

```json
{
  "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev",
  "clientId": "<client_id>",
  "clientSecret": "<client_secret>"
}
```

`kumo usage` が使用量を表示すれば設定は完了。

### シークレットの保管と再発行

`clientSecret` は発行時に一度しか表示されず、このファイルにしか保存していない（控えは取らない方針）。
ファイルを失ったとき、漏れたとき、期限（2027-10-16）が近いときは、同じトークンのシークレットを再発行する。

```sh
npx cf zero-trust access service-tokens rotate <service_token_id>   # kumodana-cli の ID は cf zero-trust access service-tokens list で確認
```

`clientId` は変わらないため、Worker の再デプロイは不要。新しいシークレットで `config.json` の `clientSecret` を
書き換え、`kumo usage` で確認する。古いシークレットは使えなくなる。

## 8. 予算アラートと使用量の通知（憲法 V、FR-038）

- ダッシュボードの Manage Account → Billing → Billable Usage → **Budget alerts** でアラートを作る
  - 2026-10-16 時点: 所有者が作った `all usage`（**$0.01**、少しでも課金が発生したら通知）と、自動で作られた
    `Default budget alert`（$10）がある
- R2 の保存量ごとの通知（Notifications → Usage Based Billing）は、$0.01 の予算アラートで超過を検知できるため作っていない
- サービストークンの期限切れ通知（Expiring Service Token Alert）は Zero Trust の有効化時に自動で作られている

## 9. 緊急停止（FR-037）

無料枠を使い切ると管理用 Worker も止まるため、Workers を使わずに止める手段を使う。

```sh
npm run stop -w @kumodana/files     # 配信用 Worker の workers.dev を止める（Cloudflare API を直接使う）
npm run resume -w @kumodana/files   # 再開
```

- `cf` が使えない場合: ダッシュボードの Workers & Pages → `kumo` → Settings → Domains & Routes で
  workers.dev を **Disable** にする
- 1 日の無料枠は日本時間 9 時（00:00 UTC）にリセットされる

## 10. 日常の運用

| 作業 | 方法 |
|---|---|
| ライブログ | `npx wrangler tail kumodana-admin` / `npx wrangler tail kumo`（`cf` は未対応） |
| 使用量の確認 | `kumo usage`。R2 側の実測は `npx cf r2 buckets metrics list` |
| 残骸の片付け | 管理用 Worker の定期実行（15 分ごと）が自動で行う |
| 上限の変更 | `apps/admin/cloudflare.config.ts` の `STORAGE_LIMIT_BYTES` を変えてデプロイ |
| サービストークンの更新 | 手順 3 の `refresh`。作り直した場合は config.json と `CLI_CLIENT_ID` を更新して再デプロイ |
| Markdown の変換器の更新 | `markdown-it` と `@mdit/plugin-tasklist`（`apps/cli` の依存）のセキュリティ修正は、公開から 7 日経ってから `npm install -w kumodana-cli --save-exact markdown-it@<版>` で上げ、`npm test` を通して `npm install -g ./apps/cli` し直す。Worker のデプロイは要らない。置いた文書は自動では変わらない（置き直すと別のファイルになる） |

## 11. 検証の記録（research.md の確認事項、T030・T082）

| 項目 | 結果 | 日付 |
|---|---|---|
| R9: EXIF 削除で Orientation と ICC_Profile が残る | 確認済み（`apps/cli/test/exif.test.ts`、JPEG と PNG） | 2026-10-16 |
| R16: 型除去での CLI 実行（Windows、`npm install -g ./apps/cli`、`@kumodana/shared` の読み込みを含む） | 確認済み（`kumo --version`、`kumo --help`） | 2026-10-16 |
| R15: `--mode stopped` で workers.dev の公開が止まる | 本番で確認済み。`npm run stop` の約 10 秒後から `error code: 1042`（workers.dev 無効）になり、`npm run resume` で約 10 秒後に復旧 | 2026-10-16 |

## 12. 本番検証の記録（quickstart.md、T084）

初回デプロイ（2026-10-16）での結果。検証用のファイルとリンクは最後に削除した。

| 項目 | 結果 |
|---|---|
| SC-001 | 4.8MB の JPEG（位置情報付き）を `kumo put --link --tag` で置いてリンクを得るまで 4.5 秒 |
| SC-002 | 所有者がスマートフォンで、写真と隔離チェックのページが問題なく表示されることを確認 |
| SC-003 | 取り消しの 3 秒後に 404（エッジのキャッシュ削除が成功）。同じファイルの別リンクは 200 のまま |
| SC-005 | 配信された画像に GPS とカメラ情報がなく、Orientation は残っている。原本のハッシュと更新日時は不変 |
| SC-006 | 隔離チェックのページで 7 項目すべて防がれた（`origin` は `null`。Cookie、localStorage、管理 API、他のリンク） |
| SC-007 | 同じリンクの 2 回目は `CF-Cache-Status: HIT` |
| FR-022 | `?fbclid=test` 付きは 301 で正規の URL へ転送 |
| FR-028 | `kumo rm` の 3 秒後に、キャッシュ済みだったリンクも 404。使用量は 0 に戻り、R2 と D1 も空 |
| 認証 | 認証なしは Access のログイン画面へ 302、誤ったサービストークンは 401（Strict service token authentication は既定で有効） |

## 13. 既知の問題

- **`apps/admin` で `cf build` / `cf dev` が失敗する**（cf 1.0.0-beta.13）。npm workspaces で
  `@cloudflare/vite-plugin` がルートに置かれると「declared ... but is not installed」と表示される。
  回避のため、スクリプトは `vite build` と `cf deploy --prebuilt --mode production` を使う。
- **開発用の依存に `sharp` の脆弱性が報告されている**（`npm audit`）。`@cloudflare/vite-plugin` と
  `@cloudflare/vitest-plugin` が使う miniflare の依存で、デプロイされる Worker には含まれない。
  公開から 7 日経った修正版が出たら更新する。
