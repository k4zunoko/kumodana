# Contract: `kumo` CLI の変更（003）

001 の [contracts/cli.md](../../001-share-shelf-mvp/contracts/cli.md) に対する追加と変更。002 の変更（`kumo put`、`kumo preview`）はそのまま。
管理 API の変更は [admin-api.md](./admin-api.md)。

## 設定（001 の「設定」を置き換える）

管理操作で使う資格情報は、次の順に選ぶ（research L10、spec FR-009）。

| 順 | 方法 | 使う条件 | 管理 API の URL |
|---|---|---|---|
| 1 | 環境変数のサービストークン | `KUMODANA_CLIENT_ID` か `KUMODANA_CLIENT_SECRET` の一方でもある | 001 と同じ（`KUMODANA_ADMIN_URL` → `config.json` の `adminUrl`） |
| 2 | ログイン | `login.json` に資格情報（`session`）がある | `login.json` の `adminUrl`。`KUMODANA_ADMIN_URL` があって違えば `admin_url_mismatch` |
| 3 | `config.json` のサービストークン | `config.json` に `clientId` か `clientSecret` がある | 001 と同じ |
| — | なし | どれもない | `config_missing`（終了コード `2`）。`kumo login <adminUrl>` を案内する |

- 1 と 3 の経路は 001 と同じで、環境変数と `config.json` を項目ごとに組み合わせ、足りない項目があれば名前を示して `config_missing` にする。
- `config.json` は CLI が書き換えない。ログインの記録は同じフォルダーの `login.json` に保存する（[data-model.md](../data-model.md)）。
- URL は末尾の `/` を除いて比べる。
- 資格情報（サービストークンのシークレット、アクセストークン、リフレッシュトークン）は、どの出力（`--json` を含む）やエラーにも表示しない。
- 社内プロキシは、今と同じく `NODE_USE_ENV_PROXY=1` と `HTTPS_PROXY` に従う。ブラウザからの受け取りは `127.0.0.1` なので、プロキシを通らない。

## ログインの経路での管理操作（すべてのコマンド）

1. 管理 API を呼ぶ前に、アクセストークンの期限まで 60 秒を切っていれば更新し、`login.json` を置き換える（research L8・L9）
2. `Authorization: Bearer <アクセストークン>` と `X-Kumodana-Client: cli` を付けて送る（サービストークンのヘッダーは送らない）
3. 401 が返ったら、1 回だけ更新して同じ要求をやり直す。やり直しても 401 なら `login_required`
4. 更新が拒否されたら（`invalid_grant` など）、`login.json` を読み直し、ほかの `kumo` が書いた新しいリフレッシュトークンがあれば 1 回だけやり直す。
   なければ `login_required`
5. `login.json` を置き換えられなかったときは、`警告: ログインの記録を保存できませんでした（…）。` を出して処理を続ける

## `kumo login [<adminUrl>] [--no-open]`（新規）

ブラウザで所有者としてログインし、ログインの記録を保存する（research L4〜L8、L13）。

1. 管理 API の URL を決める: 引数 → `KUMODANA_ADMIN_URL` → `login.json` の `adminUrl` → `config.json` の `adminUrl`。なければ `invalid_argument`
   （終了コード `2`）。`https:` の URL（パスなし。末尾の `/` は除く）でなければ `invalid_argument`
2. `/.well-known/oauth-protected-resource` と `/.well-known/oauth-authorization-server` を取得する。使えなければ `login_unavailable`
3. この PC の登録（`login.json` の `client`）がない、または `adminUrl` が違えば、動的登録を行う。`login.json` に `session` がなければすぐに保存し、
   あれば手順 7 でまとめて保存する（research L5）
4. `127.0.0.1` の空いているポートで待ち受け、認可の URL を作る
5. 標準エラー出力に次を表示し、`--no-open` でなければ既定のブラウザで開く

   ```text
   ブラウザでログインしてください。開かない場合は、次の URL をこの PC のブラウザで開いてください（5 分で時間切れになります）。
   <認可の URL>
   ```

6. ブラウザからの応答を待つ（最長 5 分）。`state` が一致する `code` を受け取ったら、完了のページを返して待ち受けを閉じる
7. コードをトークンに交換し、`login.json` の `adminUrl`・`resource`・`endpoints`・`client`・`session` を置き換える
8. 前の `session` があれば、そのリフレッシュトークンを取り消す（失敗したら警告）
9. 新しいアクセストークンで `GET /api/usage` を呼び、結果を表示する

### オプション

| オプション | 内容 |
|---|---|
| `--no-open` | ブラウザを開かず、URL を表示して待つ |
| `--status` | ログインせずに、今の状態を表示する（下記）。`<adminUrl>` と `--no-open` とは同時に使えない（`invalid_argument`、終了コード `2`） |

### 出力（人向け）

```text
ログインしました: https://kumodana-admin.<subdomain>.workers.dev
使用量: 1.2 GB / 8.0 GB（15.0%）
```

- 警告（標準エラー出力）:
  - 環境変数のサービストークンがあるとき: `警告: 環境変数 KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET があるため、管理操作ではそちらが使われます。ログインを使うには、これらの環境変数を削除してください。`
  - `KUMODANA_ADMIN_URL` がログインした URL と違うとき: `警告: KUMODANA_ADMIN_URL（…）がログインした URL と違うため、管理操作は失敗します。…`
  - `config.json` にサービストークンがあるとき: `config.json の clientId・clientSecret は、ログインしている間は使われません。` と知らせる（削除は所有者に任せる）
  - 前の許可を取り消せなかったとき

### 出力（`--json`）

```json
{
  "method": "login",
  "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev",
  "loggedInAt": "2026-10-20T01:00:00.000Z",
  "accessTokenExpiresAt": "2026-10-20T01:15:00.000Z",
  "usage": { "usedBytes": 0, "limitBytes": 8000000000, "remainingBytes": 8000000000, "fileCount": 0 }
}
```

- 認可の URL と案内は、`--json` のときも標準エラー出力に出す。

### エラー

| `code` | 条件 | 終了コード |
|---|---|---|
| `invalid_argument` | URL がない、`https:` でない、パスやクエリがある、`--status` と同時に使えないものを指定した | `2` |
| `login_invalid` | `--status` のときに `login.json` が壊れている（`kumo login` 自体は壊れた記録を無視して作り直す） | `2` |
| `login_unavailable` | メタデータを取得できない、必要な項目がない、`S256` に対応していない、エンドポイントが `https:` でない、登録が拒否された | `1` |
| `callback_unavailable` | `127.0.0.1` で待ち受けられない | `1` |
| `login_timeout` | 5 分以内にブラウザからの応答がない | `1` |
| `login_denied` | ブラウザからの応答が `error`（`access_denied` など）。`error` と `error_description` を表示する | `1` |
| `login_failed` | コードの交換が拒否された（`invalid_grant` など）。登録が `invalid_client` のときは 1 回だけ登録し直してからログインをやり直す | `1` |
| `network_error` | 通信の失敗（001 と同じ） | `1` |

- 時間切れ・中断・失敗のときは、トークンを何も保存しない（登録は保存したまま）。
- 所有者以外のアカウントでログインしようとすると、Access がブラウザで拒否する。CLI には何も届かないので、`login_timeout` か Ctrl+C で終わる。
  `login_timeout` の案内に「所有者のアカウントでログインしたか確かめてください」を含める。

## `kumo login --status`（新規）

管理操作に使われる方法と、ログインの状態を表示する。管理 API にも認可サーバーにも接続しない（spec FR-020）。終了コードは常に `0`
（`login.json` が壊れているときだけ `login_invalid`、終了コード `2`）。

### 出力（人向け）

```text
方法: ログイン（login.json）
管理 API: https://kumodana-admin.<subdomain>.workers.dev
ログインした日時: 2026-10-20 10:00（許可は、ログインから Access で設定した期間で切れます）
アクセストークンの期限: 2026-10-20 10:15（期限が切れても、管理操作のときに自動で更新します）
```

- `方法` は `ログイン（login.json）`、`サービストークン（環境変数）`、`サービストークン（config.json）`、`なし` のいずれか。
- 日時はローカル時刻で表示する。
- 方法がログインでなくても、`login.json` に `session` があれば、その内容を「ログインの記録（使われていません）」として表示する。
- `なし` のときは `kumo login <adminUrl>` を案内する。
- `config.json` の `adminUrl` が `login.json` の `adminUrl` と違うときは、そのことを知らせる（誤りにはしない）。
- 実際に使えるか（許可が切れていないか、取り消されていないか）は表示しない。`kumo usage` で確かめるよう案内する。

### 出力（`--json`）

```json
{
  "method": "login",
  "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev",
  "login": {
    "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev",
    "loggedInAt": "2026-10-20T01:00:00.000Z",
    "accessTokenExpiresAt": "2026-10-20T01:15:00.000Z",
    "refreshedAt": "2026-10-20T01:00:00.000Z"
  },
  "notes": []
}
```

- `method` は `login`、`env_service_token`、`config_service_token`、`none` のいずれか。`adminUrl` は管理操作で使われる URL（`none` のときは `null`）。
- `login` は `login.json` に `session` があるときだけ値を持ち、なければ `null`。
- `notes` は、上の知らせ（食い違い、使われていない記録など）の文字列の配列。

## `kumo logout`（新規）

この PC の許可を取り消し、`login.json` から資格情報を消す（research L12、spec FR-016〜FR-019）。

1. `login.json` に `session` がなければ、`ログインしていません。` と表示して終了コード `0`
2. 取り消しのエンドポイントにリフレッシュトークンを送って取り消す
3. 成否にかかわらず、`login.json` の `session` を `null` にする（`adminUrl`、`endpoints`、`client` は残す）
4. 取り消せなかったら `revoke_failed`（終了コード `1`）

### 出力（人向け）

```text
ログアウトしました: https://kumodana-admin.<subdomain>.workers.dev（この PC の許可を取り消しました）
```

- 警告（標準エラー出力）:
  - 環境変数のサービストークンがあるとき: `警告: 環境変数 KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET があるため、今後もそのサービストークンで管理操作が行われます。`
  - `config.json` にサービストークンがあるとき: 今後はそのサービストークンが使われることを知らせる

### 出力（`--json`）

```json
{ "loggedOut": true, "revoked": true, "adminUrl": "https://kumodana-admin.<subdomain>.workers.dev" }
```

- ログインしていなかったときは `{ "loggedOut": false, "revoked": false, "adminUrl": null }`。

### エラー

| `code` | 条件 | 終了コード |
|---|---|---|
| `revoke_failed` | 取り消しに失敗した（通信の失敗、エラーの応答）。資格情報は消してある。案内: 許可は期間まで有効なこと、取り消す方法（runbook の `cf zero-trust access applications revoke-tokens <app-id>` と `cf zero-trust access users revoke --email <owner>`。どちらもほかの PC の許可も消える） | `1` |
| `login_invalid` | `login.json` が壊れている。案内: `login.json` を削除してよいこと、許可を取り消す方法（上と同じ） | `2` |

## エラーの案内の変更（すべてのコマンド。research L11）

| 場面 | サービストークンのとき（今のまま） | ログインのとき（新規） |
|---|---|---|
| Access の 401（本文が JSON でない） | `access_denied`。ID・シークレット・期限を確かめる案内 | 1 回更新してやり直し、だめなら `login_required` |
| Access のログイン画面への 302 | `access_login_required` | `login_required` |
| Worker の 401 `unauthenticated` | ID・シークレット・期限を確かめる案内 | 1 回更新してやり直し、だめなら `login_required` |
| Worker の 403 `forbidden` | `CLI_CLIENT_ID` と Access のポリシーを確かめる案内 | ログインしたアカウントが所有者のもの（`OWNER_EMAIL`）か確かめる案内 |
| 更新が `invalid_grant`・`invalid_client` | — | 読み直して 1 回やり直し、だめなら `login_required` |

| `code` | 意味 | 終了コード |
|---|---|---|
| `login_required` | 許可の期間切れ・取り消し・更新の拒否。案内: 「`kumo login` を実行してください」 | `1` |
| `admin_url_mismatch` | `KUMODANA_ADMIN_URL` がログインした URL と違う。トークンは送っていない。案内: 環境変数を消すか、その URL で `kumo login` する | `2` |
| `login_invalid` | `login.json` が壊れている、形式が違う。案内: `kumo login` でログインし直す | `2` |
| `config_missing` | どの資格情報もない（001 のコードを使い続ける）。案内に `kumo login <adminUrl>` を加える | `2` |

## 変えないもの

- 001・002 のすべてのコマンドの引数、出力、終了コード（資格情報の選び方と、上の案内を除く）
- サービストークンの経路の振る舞いと案内（既存のテストの期待を含む）
- `kumo preview` が管理 API と設定ファイルを使わないこと（`login.json` も使わない）
