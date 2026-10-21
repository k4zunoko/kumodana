# Contract: 管理 API の変更（003）

001 の [contracts/admin-api.md](../../001-share-shelf-mvp/contracts/admin-api.md) に対する追加。**管理用 Worker（`apps/admin`）のコード、
エンドポイント、応答、エラーコードは変えない**。変わるのは、Worker の前にある Access で受け付ける資格情報の種類と、Access が返す応答だけ。

**Base URL**: `https://kumodana-admin.<subdomain>.workers.dev`（`<subdomain>` はアカウントの workers.dev サブドメイン）

## 認証（2 段）の 1 段目に、ログインの経路を加える

1. **Access（Cloudflare の入口）**: CLI は次のどちらか一方を送る。
   - **サービストークン**（001 のまま）: `CF-Access-Client-Id` と `CF-Access-Client-Secret`。Access の `kumodana-cli` ポリシー（Service Auth）で通る。
     Worker に届く JWT は `common_name` を持つ
   - **ログイン（新規）**: `Authorization: Bearer <アクセストークン>`。アクセストークンは Managed OAuth が発行した不透明な値（`oauth:…`）。
     Access はトークンを確かめ、所有者のブラウザでのログインと同じ JWT（`email` を持つ）を `Cf-Access-Jwt-Assertion` に付けて Worker に渡す。
     トークンが出るのは `owner` ポリシーのメールアドレスでログインしたときだけ
2. **Worker**: 001 のまま。`Cf-Access-Jwt-Assertion` を検証し、`email` が所有者のメールアドレス（`OWNER_EMAIL`）なら所有者、`common_name` が
   CLI のクライアント ID（`CLI_CLIENT_ID`）なら CLI として許可する。ログインの経路は「所有者」として通る（research L2 で確認）。

CSRF 対策（`X-Kumodana-Client: cli` の必須、`Origin` と `Sec-Fetch-Site` の拒否）も 001 のまま。CLI はどちらの経路でも `X-Kumodana-Client: cli` を送る。

## Access が返す応答（Managed OAuth を有効にした後）

| 要求 | 応答 |
|---|---|
| ブラウザ以外から、資格情報なし、または期限切れ・取り消し済みのアクセストークン | `401`、`WWW-Authenticate: Bearer realm="OAuth", error="invalid_token", …, resource_metadata="…/.well-known/cloudflare-access-protected-resource/…"`。本文は JSON でない |
| ブラウザらしい要求（`Accept: text/html` など）で、ログインしていない | `302`（Access のログイン画面へ。001 のまま） |
| 誤ったサービストークン | `401`（Strict service token authentication。001 の runbook §12 のまま） |

- 001 の「ヘッダーがない → `401 unauthenticated`」は Worker の応答で、Access を通った後の話なので変わらない。

## Access が提供するエンドポイント（Managed OAuth、新規）

管理用 Worker の URL で、Access が直接応答する（Worker には届かない）。認証は要らない。

| パス | 内容 |
|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728。`{ "resource": "<Base URL>/", "authorization_servers": [ … ] }` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414。`authorization_endpoint`、`token_endpoint`、`revocation_endpoint`、`registration_endpoint`、`code_challenge_methods_supported`（`S256`）、`token_endpoint_auth_methods_supported`（`none` を含む）など |

メタデータが指す各エンドポイント（kumo CLI の使い方は research L5〜L8、L12）:

| エンドポイント | 使い方 |
|---|---|
| 登録（`registration_endpoint`） | `POST`、JSON。公開クライアント（`token_endpoint_auth_method: none`）、転送先 `http://127.0.0.1:<port>/callback`。201 で `client_id` が返る。`registration_access_token` は返らず、クライアントを消す API はない |
| 認可（`authorization_endpoint`） | ブラウザで開く。`response_type=code`、`client_id`、`redirect_uri`、`state`、`code_challenge`（S256）、`resource`。所有者がログインすると、転送先に `code` と `state` が返る。ループバックのポートは登録時と違ってよい |
| トークン（`token_endpoint`） | `POST`、`application/x-www-form-urlencoded`。`authorization_code`（`code_verifier`、`resource` 付き）と `refresh_token`。応答は `access_token`、`refresh_token`（毎回変わる。古いものも使える）、`expires_in`、`token_type: bearer` |
| 取り消し（`revocation_endpoint`、`/cdn-cgi/access/oauth/revoke`） | `POST`、`token`（リフレッシュトークン）、`token_type_hint`、`client_id`。取り消すと許可全体が消え、アクセストークンもすぐ使えなくなる |

## Access の設定（`oauth_configuration`）

最終的な値は research L3（アクセストークン 15 分、許可 1 週間、ループバックだけ）。設定の手順と、実際に入った値は runbook §6 に残す（#9）。
`cf`（1.0.0-beta.13）の生成コマンドには `oauth_configuration` がないので、ダッシュボードで設定するか、`cf zero-trust access applications update --body`
（PUT。全体を送る）で設定する。

## 変えないもの

- 001 のすべてのエンドポイント、応答、エラーコード、CSRF 対策
- 管理用 Worker のシークレット（`OWNER_EMAIL`、`CLI_CLIENT_ID`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`）と `apps/admin/src/auth.ts` の判定
- Access のポリシー（`owner`、`kumodana-cli`）
