# Data Model: kumo CLI にブラウザでログインする（kumo login / logout）

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-20

## 管理用 Worker・D1・R2

**変更なし**。テーブル、R2 のオブジェクト、マイグレーション、シークレット（`OWNER_EMAIL`、`CLI_CLIENT_ID`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`）は
001 の [data-model.md](../001-share-shelf-mvp/data-model.md) と runbook のまま。ログインの経路でも、Worker が受け取るのは所有者の `email` を持つ
Access の JWT で、`apps/admin/src/auth.ts` の判定（`Principal` の `owner`）で通る（research L2）。

## 所有者の PC に保存するもの

### `config.json`（変更なし）

001 の [contracts/cli.md](../001-share-shelf-mvp/contracts/cli.md) のまま（`adminUrl`、`clientId`、`clientSecret`）。所有者が手で書くファイルで、
CLI は読むだけ。`clientId` と `clientSecret` はサービストークンのもので、ログインの経路では使わない（優先順位は research L10）。

### `login.json`（新規）

- 場所: `config.json` と同じフォルダー（Windows は `%APPDATA%\kumodana\login.json`、それ以外は `$XDG_CONFIG_HOME/kumodana/login.json`、
  未設定なら `~/.config/kumodana/login.json`）
- 書くのは `kumo login`、`kumo logout`、管理操作の中でのアクセストークンの更新だけ。書き方と権限は research L9

```json
{
  "version": 1,
  "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev",
  "resource": "https://kumodana-admin.<subdomain>.workers.dev/",
  "endpoints": {
    "authorization": "https://…",
    "token": "https://…",
    "revocation": "https://…/cdn-cgi/access/oauth/revoke",
    "registration": "https://…"
  },
  "client": { "clientId": "…", "registeredAt": "2026-10-20T01:00:00.000Z" },
  "session": {
    "accessToken": "oauth:…",
    "accessTokenExpiresAt": "2026-10-20T01:15:00.000Z",
    "refreshToken": "oauth:…",
    "loggedInAt": "2026-10-20T01:00:00.000Z",
    "refreshedAt": "2026-10-20T01:00:00.000Z"
  }
}
```

| 項目 | 内容 | 規則 |
|---|---|---|
| `version` | 形式の版 | `1` だけを受け付ける |
| `adminUrl` | ログインした管理 API の URL | 末尾の `/` を除いた形。`https:`（テストだけ `http://127.0.0.1`） |
| `resource` | トークンの要求に付ける `resource` | `/.well-known/oauth-protected-resource` の値のまま（research L4） |
| `endpoints` | 認可、トークン、取り消し、登録の URL | `/.well-known/oauth-authorization-server` の値。すべて `https:`（テストだけ `http://127.0.0.1`） |
| `client.clientId` | 動的登録で得た OAuth のクライアント ID（**サービストークンの `clientId` とは別物**） | この PC で 1 回だけ作る（research L5）。ログアウトしても消さない |
| `client.registeredAt` | 登録した日時 | ISO 8601（UTC） |
| `session` | 今の許可の資格情報。ログインしていなければ `null` | ログアウトで `null` にする |
| `session.accessToken` | アクセストークン | 出力に表示しない（research L14） |
| `session.accessTokenExpiresAt` | アクセストークンの期限 | 受け取った時刻 ＋ `expires_in` |
| `session.refreshToken` | リフレッシュトークン | 出力に表示しない。更新のたびに置き換える |
| `session.loggedInAt` | ブラウザでログインした日時 | 許可の期間の起点の目安（research L2 の未確認）。更新では変えない |
| `session.refreshedAt` | 最後にアクセストークンを取得・更新した日時 | |

- 読み込みの検証: JSON として読めない、`version` が `1` でない、必須の項目（`adminUrl`、`endpoints`、`client`）の型が違う場合は `login_invalid`
  （終了コード 2）。資格情報の値は表示せず、`kumo login` でログインし直すよう案内する。`kumo login` は壊れた `login.json` を無視して作り直す
  （登録もし直す）。
- `session` があるのに `client` がない、などの組み合わせも `login_invalid` とする。

## CLI の中だけで使う値（保存しない）

### 資格情報の選択の結果（`Credentials`）

| `method` | 条件（research L10） | 持つ値 |
|---|---|---|
| `env_service_token` | 環境変数 `KUMODANA_CLIENT_ID` か `KUMODANA_CLIENT_SECRET` がある | `adminUrl`、`clientId`、`clientSecret`（今の `CliConfig`） |
| `login` | 上でなく、`login.json` に `session` がある | `adminUrl`、`login.json` の内容 |
| `config_service_token` | 上でなく、`config.json` に `clientId` か `clientSecret` がある | `adminUrl`、`clientId`、`clientSecret` |
| `none` | どれもない | なし（管理操作は `config_missing`） |

### ログインの途中の値（`PendingLogin`）

- `codeVerifier`、`codeChallenge`、`state`、`redirectUri`（`http://127.0.0.1:<port>/callback`）
- メモリの中だけに置き、ファイルにも出力にも書かない（`state` と `codeChallenge` は認可の URL の一部として表示される）

### トークンの応答（`TokenResponse`）

- `access_token`、`token_type`（`bearer`）、`expires_in`（秒）、`refresh_token`（更新では省略されうる）、`scope`、`resource`
- エラーの応答は `{ error, error_description? }`。表示するのはこの 2 つだけ

## 状態遷移

```text
            kumo login（成功）                 アクセストークンの更新
 [未ログイン] ─────────────────▶ [ログイン中] ◀───────────────┐
 （login.json がない、             │  │                     │
  または session が null）          │  └─────────────────────┘
      ▲                             │
      │ kumo logout                 │ 許可の期間切れ・取り消し（PC の外で起きる）
      │（取り消しの成否によらず      ▼
      │  session を消す）       [使えないログイン]
      └──────────────────────── （session は残るが、更新は invalid_grant）
                                    │
                                    └─ kumo login で [ログイン中] に置き換わる
```

- 「使えないログイン」は CLI からは管理操作のときにしか分からない。CLI は `session` を自動では消さず、`login_required` で `kumo login` を案内する
  （ほかの `kumo` が同時にログインし直している場合に、新しい記録を消さないため）。
- `kumo login` は、どの状態からでも新しい `session` に置き換える。前の `session` があれば、その許可を取り消す（research L13）。
