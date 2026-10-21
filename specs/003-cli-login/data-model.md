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
| `adminUrl` | ログインした管理 API の URL | 末尾の `/` を除いた形。`https:` だけ（下の「URL の検証」） |
| `resource` | トークンの要求に付ける `resource` | `/.well-known/oauth-protected-resource` の値のまま（research L4）。`adminUrl` と同じオリジン |
| `endpoints` | 認可、トークン、取り消し、登録の URL | `/.well-known/oauth-authorization-server` の値。すべて `https:` だけ（下の「URL の検証」） |
| `client.clientId` | 動的登録で得た OAuth のクライアント ID（**サービストークンの `clientId` とは別物**） | この PC で 1 回だけ作る（research L5）。ログアウトしても消さない |
| `client.registeredAt` | 登録した日時 | ISO 8601（UTC） |
| `session` | 今の許可の資格情報。ログインしていなければ `null` | ログアウトで `null` にする |
| `session.accessToken` | アクセストークン | 出力に表示しない（research L14） |
| `session.accessTokenExpiresAt` | アクセストークンの期限 | 受け取った時刻 ＋ `expires_in` |
| `session.refreshToken` | リフレッシュトークン | 出力に表示しない。更新のたびに置き換える |
| `session.loggedInAt` | ブラウザでログインした日時 | 許可の期間の起点の目安（research L2 の未確認）。更新では変えない |
| `session.refreshedAt` | 最後にアクセストークンを取得・更新した日時 | 省略できる |

- 読み込みの検証（レビューの指摘 9）: 次のどれかに当たる場合は `login_invalid`（終了コード 2）。資格情報の値は表示せず、`kumo login` でログインし直す
  よう案内する。`kumo login` は壊れた `login.json` を無視して作り直す（登録もし直す）。
  - JSON として読めない、最上位がオブジェクトでない、`version` が `1` でない
  - 必須の項目（`adminUrl`、`resource`、`endpoints` の 4 つ、`client.clientId`、`client.registeredAt`）がない、文字列でない、URL の検証に通らない
  - `session` が `null` でもオブジェクトでもない。`session` がオブジェクトのとき、`accessToken`・`refreshToken`・`accessTokenExpiresAt`・`loggedInAt` が
    空でない文字列でない、または日時として読めない。`refreshedAt` はあれば文字列
- 読み込みのエラー（レビューの指摘 5）: `ENOENT` は「記録なし」。`EPERM`・`EACCES`・`EBUSY` は、50・100・200 ミリ秒待って最大 3 回やり直し、
  それでも失敗したら `login_read_failed`（終了コード 1）。JSON や形式の誤りだけを `login_invalid` にする。
- URL の検証（レビューの指摘 8）: `adminUrl`・`resource`・`endpoints` は `https:` だけを受け付ける。テストは偽の認可サーバーを `http://127.0.0.1` で
  動かすため、検証の関数に「ループバックの `http:` を許す」指定を渡す。指定は CLI の実行時の設定（`createRuntime` などの差し替え口）からだけ渡せ、
  環境変数や引数からは変えられない。本番のコマンドは常に `https:` だけを受け付ける。

## CLI の中だけで使う値（保存しない）

### 資格情報の選択の結果（`Credentials`）

| `method` | 条件（research L10） | 持つ値 |
|---|---|---|
| `env_service_token` | 環境変数 `KUMODANA_CLIENT_ID` か `KUMODANA_CLIENT_SECRET` がある | `adminUrl`、`clientId`、`clientSecret`（今の `CliConfig`。足りない項目があってもよく、その名前の一覧 `missing` を持つ） |
| `login` | 上でなく、`login.json` に `session` がある | `adminUrl`、`login.json` の内容 |
| `config_service_token` | 上でなく、`config.json` に `clientId` か `clientSecret` がある | `adminUrl`、`clientId`、`clientSecret`、`missing`（同上） |
| `none` | どれもない | なし（管理操作は `config_missing`） |

- 方法は「条件」だけで決め、値がそろっているかは確かめない（レビューの指摘 1）。管理操作は、方法がサービストークンで `missing` があれば `config_missing`
  にする（今の `loadConfig` と同じ文言）。`kumo login --status` は `missing` を `notes` に出し、誤りにしない。

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

- アクセストークンの更新で書くときは、書く前に `login.json` を読み直し、`adminUrl` と `session.loggedInAt` が読み込んだときと同じ場合だけ書く。
  その間に `kumo login` が新しい `session` を書いた、または `kumo logout` が `session` を消した場合は、書かない（古い `session` を書き戻さない。
  レビューの指摘 4）。読み直しと置き換えの間のごく短い間の重なりは残るが、そのときも次の管理操作が `login_required` になるだけで、ログインし直せば直る。
- 「使えないログイン」は CLI からは管理操作のときにしか分からない。CLI は `session` を自動では消さず、`login_required` で `kumo login` を案内する
  （ほかの `kumo` が同時にログインし直している場合に、新しい記録を消さないため）。
- `kumo login` は、どの状態からでも新しい `session` に置き換える。前の `session` があれば、その許可を取り消す（research L13）。
