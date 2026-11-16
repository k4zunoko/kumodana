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

## 3. サービストークン

サービストークンは、用途ごとに別々に発行する。どちらも管理用 Worker では同じ `cli` の主体（所有者と同じ操作ができる）として受け付けるが、
Access のポリシー（§6）、管理用 Worker のシークレット（§4）、期限、`rotate`、取り消しは、トークンごとに別である。

| トークン | 用途 | シークレットの置き場 | 管理用 Worker のシークレット |
|---|---|---|---|
| `kumodana-cli` | kumo CLI の退路（Issue #10） | どこにも保存しない（使うときに `rotate` する） | `CLI_CLIENT_ID` |
| `kumodana-jolly`（名前の例） | 常駐エージェント Muse（Jolly）の専用（Issue #16） | Muse の資格情報ストア（登録済み接続）だけ | `AGENT_CLIENT_ID` |

### CLI 用（退路）: `kumodana-cli`

```sh
npx cf zero-trust access service-tokens create --name kumodana-cli --duration 8760h
```

- ふだんの CLI の利用は、ブラウザでのログイン（`kumo login`、§7）で行う。サービストークンは、ブラウザのない環境で使うときや、
  Access の Managed OAuth（ベータ）が使えなくなったときの**退路**として残す（Issue #10 の決定、2026-10-21）
  - 残すもの: Access のサービストークン `kumodana-cli` とポリシー（§6）、管理用 Worker の `CLI_CLIENT_ID`（§4）と CLI の判定、
    CLI の環境変数と `config.json` の経路。憲法 IV も変えない
  - ただし、**ふだん使う PC にはシークレットを置かない**。シークレットはどこにも保存しない。退路として使うときに `rotate` で再発行し、
    使う環境の環境変数に一時的に設定して、使い終わったら消す（§7「サービストークンで使う（退路）」）
- 出力の `client_id` は `.secrets.production.json` の `CLI_CLIENT_ID`（§4）に使う。**`client_secret` はこのときしか表示されない**が、控えは取らない。
  要るときは §7 の手順で `rotate` して得る（`client_id` は変わらないので、Worker の再デプロイは要らない）
- 有効期限（作成から 1 年。今のトークンは 2027-10-16）をカレンダーなどに記録する。退路を残すため、期限の前に延ばす。延長（シークレットは
  変わらない）は `npx cf zero-trust access service-tokens refresh <TOKEN_ID>`。期限の通知（Expiring Service Token Alert）は自動で作られている（§8）

### エージェント用: `kumodana-jolly`

ブラウザのない Linux の VM に常駐する、所有者の個人エージェント Muse（Jolly）専用のトークン（Issue #16 の決定、2026-11-16。
[specs/004-agent-service-token](../specs/004-agent-service-token/spec.md)）。退路用の `kumodana-cli` は流用せず、`rotate` も共有しない。
権限は絞らない（管理用 Worker の `cli` の主体と同じ）。2026-11-16 の時点では、まだ発行していない。

```sh
npx cf zero-trust access service-tokens create --name kumodana-jolly --duration 8760h
```

発行の手順は `kumodana-cli` と同じで、違うのは次の点。

- 出力の `client_id` は、`.secrets.production.json` の `AGENT_CLIENT_ID`（§4）に入れて、管理用 Worker を再デプロイする（§5）。
  Access アプリには、このトークンの Service Auth ポリシーを足す（§6「エージェント用サービストークンのポリシー」）
- **`client_secret` は、Muse の資格情報ストア（登録済み接続）にだけ登録する**（§7「常駐エージェントで使う」）。エージェント側の平文ファイル、
  チャット、リポジトリ、所有者の PC のファイルには置かない。ほかに控えも取らない（失くしたら `rotate` して登録し直す）
- これは、上の「シークレットはどこにも保存しない」に対する、保管先を Muse の資格情報ストアに限った**例外**である。常駐するエージェントは、
  使うたびに `rotate` できないため。**退路用 `kumodana-cli` の方針（どこにも保存しない）は変わらない**
- `client_id` は識別子として、ヘルパー（エージェントが管理 API を呼ぶプログラム。このリポジトリの外）が要求に付ける。リポジトリには書かない
- 期間は `8760h`（作成から 1 年）。発行したら、期限の日付をここと §10 に書き、カレンダーなどにも記録する。期限の前に `refresh` で延ばす
  （シークレットは変わらないので、Muse 側の登録はそのままでよい）。§8 の期限の通知が、このトークンも対象にしているか（すべてのトークンか、
  特定のトークンか）を確かめる

## 4. シークレットファイル

リポジトリのルートに `.secrets.production.json` を作る（`.gitignore` 済み。**コミットしない**）。
形式は `secrets.production.example.json` を参照。

| キー | 値 |
|---|---|
| `OWNER_EMAIL` | 自分のメールアドレス（Access でログインするもの） |
| `CLI_CLIENT_ID` | 手順 3 の `kumodana-cli` の `client_id` |
| `AGENT_CLIENT_ID` | 手順 3 の `kumodana-jolly`（エージェント用）の `client_id`。空（`""`）なら `CLI_CLIENT_ID` だけが通る |
| `ACCESS_TEAM_DOMAIN` | `https://<チーム名>.cloudflareaccess.com` |
| `ACCESS_AUD` | 手順 6 で作る Access アプリの AUD。初回は仮の値（例: `pending`）でよい（すべて拒否される） |

`AGENT_CLIENT_ID` は、ほかのキーと同じく `bindings.secret()`（必須のシークレット）で宣言している（004）。キーを省くと、デプロイが
「required secrets have not been set」で止まる見込みなので、エージェント用サービストークンを発行する前にデプロイするときも、キーは残して
`""` にする。

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
ログイン方法）を使う。`kumo login` のための Managed OAuth の設定は、下の「Managed OAuth（`kumo login` 用）」にある。
エージェント用サービストークン（§3）のポリシー `kumodana-jolly` は、下の「エージェント用サービストークンのポリシー」で足す（Issue #16。
2026-11-16 の時点では、まだ足していない）。

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

### エージェント用サービストークンのポリシー（`kumodana-jolly`）

§3 のエージェント用サービストークンを発行した後に、`kumodana-admin` に、このトークンだけを含む Service Auth ポリシーを足す
（Issue #16、[specs/004-agent-service-token](../specs/004-agent-service-token/spec.md)）。既存のポリシー（`owner`・`kumodana-cli`）と、
Managed OAuth の設定は変えない。

1. Zero Trust → Access controls → Applications → `kumodana-admin` → 編集（⋯ → Edit）
2. ポリシーを追加する。名前: `kumodana-jolly`、Action: **Service Auth**、Include: **Service Token** = `kumodana-jolly`
3. 保存し、`npx cf zero-trust access applications get <app-id>` で、ポリシーが `owner`・`kumodana-cli`・`kumodana-jolly` の 3 つになり、
   `oauth_configuration` とアプリのセッション（24h）が変わっていないことを確かめる

API で足す場合は、下の「Managed OAuth」の「API で設定する」と同じ手順（`get` で控える → 控えに足す → `--dry-run` → `update` →
もう一度 `get` して比べる）で、`policies` に次の 1 件を足す。`<AGENT_TOKEN_ID>` は `npx cf zero-trust access service-tokens list` で確かめる。
この経路は、まだ試していない（2026-11-16 時点）。

```json
{ "name": "kumodana-jolly", "decision": "non_identity", "include": [{ "service_token": { "token_id": "<AGENT_TOKEN_ID>" } }] }
```

- 入口（このポリシー）と処理の本体（管理用 Worker の `AGENT_CLIENT_ID`、§4）がそろって、初めて通る。ポリシーだけでは、管理用 Worker が
  `403 forbidden` を返す
- このポリシーを外すと、このトークンだけが入口で拒否される（取り消しの方法の 1 つ。§7「常駐エージェントで使う」）

### Managed OAuth（`kumo login` 用）

`kumo login`（§7）は、このアプリの Managed OAuth（ベータ）を使う。2026-10-20 に検証用の値で有効にし（Issue #4）、2026-10-21 に
下の値にした（Issue #9）。値を決めた理由の詳細は [specs/003-cli-login/research.md](../specs/003-cli-login/research.md) の L3 にある。

| ダッシュボードの項目（日本語の表示。2026-10-21 時点） | API の項目（`oauth_configuration` の下） | 値 | 理由 |
|---|---|---|---|
| マネージドOAuth | `enabled` | on | |
| ループバック | `dynamic_client_registration.allow_any_on_loopback` | on | `kumo login` は、PC の `127.0.0.1` の空いているポートでログインの結果を受け取る。ポートは毎回変わってよい |
| localhost | `dynamic_client_registration.allow_any_on_localhost` | off | `localhost` は、名前解決の結果が環境で変わりうる（RFC 8252 §8.3） |
| 許可されたリダイレクト URI | `dynamic_client_registration.allowed_uris` | なし | `https` の転送先は要らない |
| アクセストークンの有効期間 | `grant.access_token_lifetime` | 15 minutes（API では `15m`） | 取り消しはアクセストークンにもすぐ効くので、これより短くしても安全面の得は少ない。更新は管理操作のときに自動で行われる |
| グラントセッション期間（§7 の「許可の期間」） | `grant.session_duration` | 1 week（API では `168h`） | リフレッシュトークンは更新した後も古いものが使えるので、漏れたときに使われうる期間がこの長さになる。Cloudflare の推奨（1〜2 週間）の短い側にした。ブラウザでのログインは週 1 回で済む |

`dynamic_client_registration.enabled` も `true` にする（動的登録。`kumo login` は PC ごとに 1 回だけ登録する）。

#### ダッシュボードで設定する

1. Zero Trust → Access controls → Applications → `kumodana-admin` → 編集（⋯ → Edit）
2. **Advanced settings** → **マネージドOAuth** を on にし、上の表の値にする。2 つの期間は、どちらもドロップダウンの選択肢から選ぶ
3. 保存し、下の「API で確かめる」で実際に入った値を確かめる

#### API で設定する

`cf`（1.0.0-beta.13）の `applications update` には `oauth_configuration` の項目がないため、本文全体を `--body` で送る。
更新は PUT なので、送らなかった項目は消える。必ず今の設定を取得し、それに足して送る。

1. `npx cf zero-trust access applications list` で `kumodana-admin` の `<app-id>` を確かめる
2. `npx cf zero-trust access applications get <app-id>` の出力を、作業用のファイル（リポジトリの外。例: `%TEMP%` の `access-app-before.json`）に控える
3. 控えを写して `access-app-after.json` を作り、`oauth_configuration` を足す（または直す）

   ```json
   "oauth_configuration": {
     "enabled": true,
     "dynamic_client_registration": { "enabled": true, "allow_any_on_loopback": true, "allow_any_on_localhost": false, "allowed_uris": [] },
     "grant": { "access_token_lifetime": "15m", "session_duration": "168h" }
   }
   ```

4. 送る内容を `--dry-run` で確かめてから、送る

   ```sh
   npx cf zero-trust access applications update <app-id> --body "@C:\path\to\access-app-after.json" --dry-run
   npx cf zero-trust access applications update <app-id> --body "@C:\path\to\access-app-after.json"
   ```

5. もう一度 `get` し、変更前の控えと比べる。`oauth_configuration` と `updated_at` 以外に差分がないこと（ポリシーの ID と中身を含む）を確かめる
6. 控えのファイルには、所有者のメールアドレスや各種の ID が入る。リポジトリに置かず、作業が済んだら削除する

#### API で確かめる

`npx cf zero-trust access applications get <app-id>` の出力の `oauth_configuration` を見る。2026-10-21 の値は次のとおり
（ダッシュボードでは 15 minutes と 1 week と表示される）。ポリシー（`owner`・`kumodana-cli`。エージェント用を足した後は `kumodana-jolly` も）と
アプリのセッション（24h）も、変わっていないことを確かめる。

```json
{"enabled":true,"grant":{"session_duration":"168h","access_token_lifetime":"15m"},"dynamic_client_registration":{"enabled":true,"allowed_uris":[],"allow_any_on_localhost":false,"allow_any_on_loopback":true}}
```

#### 注意

- **ダッシュボードの選択肢にない値**（例: API で入れた `5m`）は、空欄（「選択する…」）と表示される。その状態で保存し直すと、値が消えたり既定値に
  戻ったりするおそれがある。値はドロップダウンの選択肢から選ぶ（`15m` と `168h` は、選択肢の 15 minutes と 1 week に当たる）
- **Managed OAuth はベータ**で、振る舞いが変わる可能性がある。設定を変えたときは、`kumo` が頼っている次の振る舞いを確かめる。
  `APPDATA` を一時フォルダーに向けると、今の PC のログインの記録に触れずに確かめられる（§11 の「確かめ方」）
  - `kumo login` でログインでき、`kumo usage` が成功する。`kumo login --status` のアクセストークンの期限が、設定どおり（発行から 15 分）になっている
  - 取り消しのエンドポイントが、無効なトークン（取り消し済み、期限切れ、未知）に `400 invalid_grant` を返す。`kumo logout` はこの応答を
    「許可はすでに無効」とみなし、終了コード 0 で終わる。確かめ方: ログインして `login.json` を写し、`kumo logout` の後に写しを戻して、
    もう一度 `kumo logout` を実行する。「この PC の許可はすでに無効でした」と出れば変わっていない。`revoke_failed`（終了コード 1）になったら、
    応答が変わっているので、`kumo` を直す（specs/003-cli-login/research.md L12）
- Managed OAuth を有効にすると、ブラウザ以外から認証なしで送ったときの応答が、302（ログイン画面へ）から 401（`WWW-Authenticate: Bearer`）に
  変わる。ブラウザでのログインと、サービストークンでの利用は変わらない（Issue #4）
- **使えなくなったとき**（ベータの終了など）は、ダッシュボードで off にするか、上の API の手順で `"oauth_configuration": { "enabled": false }` にする。
  `kumo` はサービストークン（§3・§7）で使い続けられる
- 動的登録したクライアント（PC ごとに 1 つ）は、API から消せない。数の上限は分かっていない。検証と確認のために登録したものが、いくつか残っている

## 7. CLI の設定

```sh
npm install -g ./apps/cli    # kumo コマンドを登録（ビルド不要。Node.js の型除去で直接動く）
kumo login https://kumodana-admin.<subdomain>.workers.dev
kumo usage                   # 使用量が表示されれば設定は完了
```

- `kumo login` は既定のブラウザで Access のログイン画面を開く。所有者のアカウント（§6 の `owner` ポリシー）でログインすると、
  CLI がトークンを受け取って `login.json` に保存し、使用量を表示する。`config.json` を手で書く必要はない
- ブラウザが開かないときは、表示された URL を**同じ PC のブラウザ**で開く（ログインの結果は、この PC の `127.0.0.1` で受け取る）。
  `--no-open` を付けると、開かずに URL だけを表示して待つ。5 分で時間切れになる
- 2 回目からは URL を省略できる（`KUMODANA_ADMIN_URL`、前回ログインした URL、`config.json` の `adminUrl` の順に使う）。
  ログインし直すと、この PC の前の許可は取り消される。この PC の登録（クライアント）は使い回す
- 許可の期間（Access の Managed OAuth の設定。2026-10-21 から 1 週間。値と設定の手順は §6）のあいだは、ブラウザを開かずに使える。
  アクセストークン（15 分）は、管理操作のときに自動で更新される
- `kumo login --status` で、管理操作に使われる資格情報（ログイン、サービストークン）と、ログインした日時、アクセストークンの期限を
  確かめられる（通信しない）。実際に使えるかは `kumo usage` で確かめる
- `login.json` は `config.json` と同じフォルダー（Windows では `%APPDATA%\kumodana\login.json`、それ以外では
  `$XDG_CONFIG_HOME/kumodana/login.json`）にある。平文で、Windows ではユーザーのプロファイルの権限で、それ以外では 600 で守る。
  CLI は `config.json` を書き換えない

### ログインし直すとき

- 管理操作が「`kumo login` を実行してください」（`login_required`）で失敗したら、`kumo login` を実行する。許可の期間が過ぎたか、
  許可が取り消された
- ブラウザにクライアント（client）のエラーが表示され、CLI が時間切れ（`login_timeout`）になったときは、この PC の登録が使えなくなっている。
  `login.json` を削除してから `kumo login` を実行する
- ログインし直した直後の確かめが `login_required` で失敗したときは、`kumo logout` の後に `kumo login` を実行する
  （前の許可の取り消しが、新しい許可にも効いた場合。2026-10-21 の確認では起きなかった。Access の振る舞いが変わったときの備え）

### PC を使わなくなるとき、PC をなくしたとき

- 使わなくなる PC では `kumo logout` を実行する。この PC の許可を取り消し、`login.json` からトークンを消す（URL と登録は残る）。
  取り消しはすぐ効く。通信できずに取り消せなかったとき（`revoke_failed`）は、トークンは消えるが許可は残るので、下の方法で取り消す
- 許可の期間が切れた後や、下の方法で取り消された後に `kumo logout` を実行すると、「この PC の許可はすでに無効でした」と出て、終了コード 0 で
  終わる（トークンは消える）。Access が、無効なトークンの取り消しに `400 invalid_grant` を返すため（§6 の注意）
- PC をなくした、`login.json` が漏れたかもしれないときは、別の PC から次のどちらかで取り消す。どちらもサービストークンには影響しない。
  反映には 1 分ほどかかる

  ```sh
  npx cf zero-trust access applications list                    # kumodana-admin の <app-id> を確認
  npx cf zero-trust access applications revoke-tokens <app-id>   # このアプリのすべての許可（ほかの PC の分も）を消す
  npx cf zero-trust access users revoke --email <owner>          # 所有者のすべてのセッション（ほかのアプリやブラウザの分も）を消す
  ```

  ほかの PC では、次の管理操作が `login_required` になるので、`kumo login` し直す。ダッシュボードには、Worker 単位のアプリの
  「Revoke existing tokens」が見当たらない（2026-10-20 時点）ため、取り消しは上のコマンドで行う

### サービストークンで使う（退路）

ブラウザのない環境で一時的に使うときや、Managed OAuth が使えなくなったときは、§3 の CLI 用サービストークン（`kumodana-cli`）を、使う環境の
環境変数に一時的に設定して使う。シークレットはどこにも保存していないので、使うたびに再発行する（Issue #10 の決定、2026-10-21）。
ブラウザのない環境に常駐するエージェントは、これではなく、下の「常駐エージェントで使う」の専用のトークンを使う。

1. シークレットを再発行する。前のシークレットはすぐ使えなくなる

   ```sh
   npx cf zero-trust access service-tokens list                       # kumodana-cli の <service_token_id> を確認
   npx cf zero-trust access service-tokens rotate <service_token_id>  # 出力の client_secret は、このときしか表示されない
   ```

   `client_id`（管理用 Worker の `CLI_CLIENT_ID`）は変わらないので、Worker の再デプロイは要らない
2. 使う環境で、環境変数を一時的に設定して使う（PowerShell の例。そのシェルの中だけで効く）

   ```powershell
   $env:KUMODANA_ADMIN_URL = "https://kumodana-admin.<subdomain>.workers.dev"
   $env:KUMODANA_CLIENT_ID = "<client_id>"
   $env:KUMODANA_CLIENT_SECRET = "<client_secret>"
   kumo usage
   ```

   環境変数のサービストークンは、ログイン（`login.json`）より優先される。`kumo login --status` では「サービストークン（環境変数）」と出る
3. 使い終わったら、環境変数を消す。シークレットは控えない（次に要るときは、また `rotate` する）

   ```powershell
   Remove-Item Env:KUMODANA_CLIENT_ID, Env:KUMODANA_CLIENT_SECRET, Env:KUMODANA_ADMIN_URL
   ```

管理操作に使う資格情報は、次の順に選ばれる。

1. 環境変数 `KUMODANA_CLIENT_ID`・`KUMODANA_CLIENT_SECRET`（どちらか一方でもあれば、ログインより優先される）
2. ログイン（`login.json`）
3. `config.json` の `clientId`・`clientSecret`

- `config.json`（Windows では `%APPDATA%\kumodana\config.json`）にシークレットを書く経路も CLI に残っているが、**ふだん使う PC には置かない**
  （シークレットはどこにも保存しない）。所有者の PC の `config.json` は、2026-10-21 に `clientId`・`clientSecret` を削除し、`adminUrl` だけにした。
  ほかの PC の `config.json` にシークレットが書いてあれば、削除する（ログインしている間は使われない）
- `config.json` の `adminUrl` は、`kumo login` で URL を省略したときの候補として使われる
- ログインを使うときに `KUMODANA_ADMIN_URL` を設定しておく場合は、ログインした URL と同じにする。違うと、トークンを送らずに
  `admin_url_mismatch` で止まる

### シークレットの保管と再発行

`clientSecret` は発行時に一度しか表示されない。退路用 `kumodana-cli` のシークレットは**どこにも保存しない**（§3。エージェント用は
下の「常駐エージェントで使う」）。要るときは、上の手順で `rotate` して得て、使い終わったら消す。
漏れたかもしれないときも `rotate` する（前のシークレットはすぐ使えなくなる）。期限（2027-10-16）が近いときは、シークレットが変わらない
§3 の `refresh` で延ばす。どちらも `clientId` は変わらないため、Worker の再デプロイは要らない。

### 常駐エージェントで使う（エージェント用サービストークン）

ブラウザのない環境に常駐するエージェント（所有者の個人エージェント Muse / Jolly）は、`kumo login` でも退路の `kumodana-cli` でもなく、
§3 のエージェント用サービストークン（`kumodana-jolly`）で管理 API を使う（Issue #16 の決定、2026-11-16。
[specs/004-agent-service-token](../specs/004-agent-service-token/spec.md)）。`kumo` CLI は変えていない。エージェントは、管理 API を直接呼ぶ
ヘルパー（このリポジトリの外）から使う。使い始めるまでの順序は、§3 で発行 → §6 でポリシーを足す → §4 の `AGENT_CLIENT_ID` に入れて
§5 で再デプロイ → 下の「保管」で Muse に登録。

#### ヘルパーが送るもの

すべての `/api/*` の要求に、次のヘッダーを付ける。エンドポイントと、アップロードに要るヘッダー（`X-Kumodana-Sha256` など）は、
[001 の contracts/admin-api.md](../specs/001-share-shelf-mvp/contracts/admin-api.md) にある。

| ヘッダー | 値 |
|---|---|
| `CF-Access-Client-Id` | `kumodana-jolly` の `client_id`（識別子。ヘルパーが付ける） |
| `CF-Access-Client-Secret` | `kumodana-jolly` の `client_secret`（Muse の資格情報ストアから取り出す） |
| `X-Kumodana-Client` | `cli`（管理 API の CSRF 対策。ないと `403 cross_site_request`） |

- `Origin` は付けない（付けると `403 cross_site_request`）。`client_secret` は、出力、ログ、エラーに出さない
- 確かめ方: `GET /api/usage` が 200 で使用量を返せば、入口（Access）と処理の本体（管理用 Worker）の両方を通っている
  - 401 か 403 で、本文が管理 API のエラーの JSON（`{"error": …}`）でない: 入口で拒否された。シークレット、期限、§6 のポリシーを確かめる
  - 403 で `{"error":{"code":"forbidden", …}}`: 入口は通ったが、管理用 Worker が受け付けていない。§4 の `AGENT_CLIENT_ID` と、§5 の
    再デプロイを確かめる
- 置くもの: 憲法 IV・VII は、ヘルパーから置くものにも及ぶ。Markdown 文書とテキストは、`kumo preview <file> -o <path>`（管理 API を
  使わない）で HTML に変換してから置く。画像と SVG は、メタデータ（位置情報など）を取り除いたものだけを置く。取り除く手段がない間は、
  ヘルパーで画像と SVG を置かない

#### 保管

- `client_secret` は、Muse の資格情報ストア（登録済み接続）にだけ登録する。エージェント側の平文ファイル、チャット、リポジトリには
  置かない（§3 の例外。退路用 `kumodana-cli` の方針は変わらない）
- `client_id` は、識別子としてヘルパーの設定に置く。Muse の資格情報ストアに置くのは `client_secret` だけ
- 発行や `rotate` のときに表示された `client_secret` は、登録が済んだら控えずに捨てる

#### 延長・入れ直し・取り消し

```sh
npx cf zero-trust access service-tokens list                        # kumodana-jolly の <service_token_id> を確認
npx cf zero-trust access service-tokens refresh <service_token_id>  # 延長（1 年。シークレットは変わらない）
npx cf zero-trust access service-tokens rotate <service_token_id>   # 入れ直し（前のシークレットはすぐ使えなくなる）
npx cf zero-trust access service-tokens delete <service_token_id>   # 取り消し（トークンを消す）
```

- **延長**: 期限の前に `refresh` する。シークレットは変わらないので、Muse 側の登録はそのままでよい。新しい期限を §3 と §10 に書く
- **入れ直し**: 漏れたかもしれないときは `rotate` し、出力の `client_secret` を Muse の資格情報ストアに登録し直す。登録し直すまで、
  エージェントは入口で拒否される。`client_id` は変わらないので、管理用 Worker の再デプロイは要らない
- **取り消し**: エージェントを止めるときや、VM や資格情報ストアが漏れたかもしれないときは、`delete` でトークンを消すか、§6 の
  ポリシー `kumodana-jolly` を外す。Strict service token authentication（§6 の 5）が有効なとき、Access は Cookie（`CF_Authorization`）を
  返さず、要求のたびにヘッダーで確かめるので、次の要求から入口で拒否される見込み（実地では未確認。§12）。続けて、Muse の
  資格情報ストアの登録を消す。作り直さないなら、`AGENT_CLIENT_ID` を `""` にして再デプロイし、処理の本体でも受け付けないようにする
- どれも `kumodana-jolly` だけが対象で、所有者の PC のログイン（`kumo login`）と退路用 `kumodana-cli` には影響しない。逆に、
  `kumodana-cli` を `rotate` しても、エージェントは止まらない
- 作り直した（消して新しく発行した）ときは、`client_id` が変わるので、`AGENT_CLIENT_ID` を更新して再デプロイし、§6 のポリシーも
  新しいトークンに向ける。ヘルパーの設定の `client_id` も入れ替える

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
| ログインの確認 | `kumo login --status`（使われる資格情報とログインの状態。通信しない）。使えるかは `kumo usage` |
| ログインし直す | `kumo login`（許可の期間が過ぎたとき、取り消されたとき。§7） |
| PC の許可を手放す | その PC で `kumo logout`。PC をなくしたときは §7 の `revoke-tokens` か `users revoke` |
| CLI 用サービストークン（退路、`kumodana-cli`）の更新 | 期限（2027-10-16）の前に、§3 の `refresh` で延ばす（シークレットは変わらない。退路を残すため）。シークレットは保存しないので、退路として使うときに §7 の `rotate` で再発行する。トークンを作り直した場合は `CLI_CLIENT_ID` を更新して再デプロイ |
| エージェント用サービストークン（`kumodana-jolly`）の延長 | 期限（発行から 1 年。発行したら日付を §3 とここに書く）の前に、§7「常駐エージェントで使う」の `refresh` で延ばす（シークレットは変わらないので、Muse 側の登録はそのまま）。漏れたかもしれないときは `rotate` して、Muse の資格情報ストアに登録し直す（再デプロイは要らない） |
| エージェント用サービストークン（`kumodana-jolly`）の取り消し | `delete` でトークンを消すか、§6 のポリシー `kumodana-jolly` を外す（§7）。Muse の登録も消す。所有者のログインと `kumodana-cli` には影響しない。作り直さないなら `AGENT_CLIENT_ID` を `""` にして再デプロイ |
| Markdown の変換器の更新 | `markdown-it` と `@mdit/plugin-tasklist`（`apps/cli` の依存）のセキュリティ修正は、公開から 7 日経ってから `npm install -w kumodana-cli --save-exact markdown-it@<版>` で上げ、`npm test` を通して `npm install -g ./apps/cli` し直す。Worker のデプロイは要らない。置いた文書は自動では変わらない（置き直すと別のファイルになる） |

## 11. 検証の記録（research.md の確認事項。001 の T030・T082、003 の T038）

| 項目 | 結果 | 日付 |
|---|---|---|
| R9: EXIF 削除で Orientation と ICC_Profile が残る | 確認済み（`apps/cli/test/exif.test.ts`、JPEG と PNG） | 2026-10-16 |
| R16: 型除去での CLI 実行（Windows、`npm install -g ./apps/cli`、`@kumodana/shared` の読み込みを含む） | 確認済み（`kumo --version`、`kumo --help`） | 2026-10-16 |
| R15: `--mode stopped` で workers.dev の公開が止まる | 本番で確認済み。`npm run stop` の約 10 秒後から `error code: 1042`（workers.dev 無効）になり、`npm run resume` で約 10 秒後に復旧 | 2026-10-16 |
| 003 L2: 前の許可の取り消しは、同じクライアントの新しい許可に効かない | 本番で確認済み。ログインし直した直後の `kumo usage` が成功した（T035） | 2026-10-21 |
| 003 L2: 古い（更新される前の）リフレッシュトークンで取り消しても、許可全体が消える | 本番で確認済み。取り消しの後、最新の記録（アクセストークンは期限前）での `kumo usage` が `login_required` になった（T035） | 2026-10-21 |
| 003 L2・L12: 無効なトークンの取り消しの応答 | 本番で確認済み。取り消し済みのトークンと未知のトークンには `400 invalid_grant`（RFC 7009 の 200 ではない）、未知のクライアントには `401 invalid_client` が返る。値を 15 分・1 週間に変えた後も同じ（T035・T036。確認のために動的登録を 1 つ使った） | 2026-10-21 |
| 003 L3: Managed OAuth の最終的な値 | ダッシュボードの選択肢の 15 minutes・1 week で設定し、API では `15m`・`168h` と読めた（§6）。ポリシーとアプリのセッション（24h）は変わらない。新しい値でのログインで、アクセストークンの期限は発行から 15 分だった（T036） | 2026-10-21 |
| 003 L7: Windows で、`&` を含む長い URL がそのままブラウザに渡る | 確認済み。`&` を 7 つ含む 604 文字の URL が、`%SystemRoot%\System32\rundll32.exe` 経由で、そのままローカルのサーバーに届いた（T034） | 2026-10-21 |
| 003 L2: 許可の期間（1 週間）の起点（ログイン時から数えるか、更新で延びるか） | **未確認**。下の「003 の未確認の項目の確かめ方」 | — |
| 003 L2: 1 つの PC の許可の取り消しが、別の PC の許可に影響しないこと | **未確認**（同じクライアントの別の許可に効かないことは確認済み）。下の「003 の未確認の項目の確かめ方」 | — |
| 003 L2: アクセストークンの期限が切れた後の応答（401 `invalid_token` の見込み） | 未確認。`kumo` は期限の前に更新するので、ふだんの使い方では起きない（期限の 77 秒後の `kumo usage` も、先に更新して成功した）。401 でも更新してやり直すので、`kumo` の動きには影響しない | — |

### 003 の未確認の項目の確かめ方

今の PC のログインの記録に触れずに確かめるには、PowerShell で `APPDATA` を一時フォルダーに向ける（新しいシェルでも、同じフォルダーを設定し直す）。
この方法でも、PC の登録（消せない）が 1 つ増える。

```powershell
$env:APPDATA = Join-Path $env:TEMP "kumo-check"
Remove-Item Env:KUMODANA_CLIENT_ID, Env:KUMODANA_CLIENT_SECRET, Env:KUMODANA_ADMIN_URL -ErrorAction SilentlyContinue
kumo login https://kumodana-admin.<subdomain>.workers.dev
kumo login --status    # 「ログインした日時」を控える
```

- **許可の期間の起点**
  1. ログインした後の 7 日間、少なくとも 1 日に 1 回 `kumo usage` を実行する（そのたびにアクセストークンが更新される）
  2. ログインから 7 日を過ぎた後に、`kumo usage` を実行する
  3. `login_required` になれば、起点はログイン時で、更新しても延びない（spec の想定どおり）。成功し続ければ、更新で延びている。
     その場合は、spec の Assumptions、research L2・L3、§7 の説明を直す
- **別の PC の許可への影響**: `APPDATA` を別々の一時フォルダーに向けた 2 つのシェルで、それぞれログインする。一方で `kumo logout` を実行した後、
  もう一方で `kumo usage` が成功することを確かめる
- 終わったら、それぞれのシェルで `kumo logout` を実行し、一時フォルダーを削除する。結果は上の表に書く

## 12. 本番検証の記録（quickstart.md。001 の T084、003 の T035・T036）

### 001: 初回デプロイ（2026-10-16）

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

### 003: kumo login / logout（T035・T036、2026-10-21）

T035 は、所有者の PC で `APPDATA` を一時フォルダーに向けて行った（Access は検証用の値: アクセストークン 5 分、許可 24 時間）。T036 は、最終的な値
（15 分、1 週間。§6）にした後の確認。ブラウザでのログインは所有者が行った。トークンの値は記録していない。SC の番号は
[003 の spec](../specs/003-cli-login/spec.md) のもの。

| 項目 | 結果 |
|---|---|
| SC-001 | `kumo login <adminUrl>` でブラウザが開き、所有者のログインの後に使用量が出るまで 101 秒（ログイン画面の操作を含む）。`login.json` だけができ、`config.json` は作られない |
| `kumo login --status` | 方法（ログイン）、ログインした日時、アクセストークンの期限が出た。トークンの値は出ない。記録がないとき、環境変数のサービストークンが不完全なとき、`config.json` が壊れているときも、案内や注意を出して終了コード 0 |
| `kumo login --no-open` | URL を表示して待ち、その URL を開くとログインできた。PC の登録はし直さない（`client.clientId` は変わらない） |
| ログインし直し | 直後の `kumo usage` が成功した（前の許可の取り消しは、新しい許可に効かない） |
| SC-002 | アクセストークンの期限の 77 秒後の `kumo usage` が、ブラウザを開かずに成功した。`refreshedAt` が新しくなり、`loggedInAt` は変わらない |
| SC-006 | 期限が切れた後に `kumo usage` を 2 つ同時に実行し、両方とも成功した。その後の `login.json` も JSON として読めた |
| SC-004 | `usage`・`ls`・`login --status`（それぞれ `--json` の有無）の出力に、`oauth:` を含む行は 0 |
| SC-003 | `kumo logout` で許可が取り消され、`session` は `null` になった（URL と登録は残る）。直後の `kumo usage` は `config_missing`。ログアウト前の記録を戻すと、期限前のアクセストークンでも `login_required` |
| SC-005 | 古いリフレッシュトークンで取り消した後、最新の記録での `kumo usage` は `login_required`（「`kumo login` を実行してください」） |
| すでに無効な許可での `kumo logout` | 最初の実装は `revoke_failed`（終了コード 1）で「許可は期間が切れるまで有効です」と誤って案内した。Access が `400 invalid_grant` を返すためで、PR #12 で「この PC の許可はすでに無効でした」（終了コード 0）に直した。2 回目の `kumo logout` は「ログインしていません。」（終了コード 0） |
| SC-007 | `APPDATA` を元に戻すと、`config.json` のサービストークンで `kumo usage` が成功した（T035 の時点。その後、#10 の決定で `config.json` からシークレットを削除した）。ブラウザらしい要求は、今までどおり Access のログイン画面へ 302 |
| 最終的な値（T036） | 新しい値でログインすると、アクセストークンの期限は発行から 15 分だった。`kumo usage` は成功し、`kumo logout` は「この PC の許可を取り消しました」で終了コード 0 |

### 004: エージェント用サービストークン

未実施（接続の実装後に記録）。

## 13. 既知の問題

- **`apps/admin` で `cf build` / `cf dev` が失敗する**（cf 1.0.0-beta.13）。npm workspaces で
  `@cloudflare/vite-plugin` がルートに置かれると「declared ... but is not installed」と表示される。
  回避のため、スクリプトは `vite build` と `cf deploy --prebuilt --mode production` を使う。
- **開発用の依存に `sharp` の脆弱性が報告されている**（`npm audit`）。`@cloudflare/vite-plugin` と
  `@cloudflare/vitest-plugin` が使う miniflare の依存で、デプロイされる Worker には含まれない。
  公開から 7 日経った修正版が出たら更新する。
