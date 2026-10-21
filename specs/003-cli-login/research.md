# Research: kumo CLI にブラウザでログインする（kumo login / logout）

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-20

全体の決定は Issue #3、本番での検証は #4、この仕様で決める論点は #5 にある。ここでは決定と、その理由を短くまとめる。
001 の research（R1〜R16）、002 の research（M1〜M12）と区別するため、番号は L を付ける。

個人を特定できる値（workers.dev のサブドメイン、Zero Trust のチーム名、メールアドレス、アカウント・アプリ・トークン・クライアントの各 ID、AUD）は
書かない。必要な箇所は `<subdomain>`、`<team>`、`<owner>`、`<app-id>` のように書く。

## L1. 方式: Access の Managed OAuth を使ったブラウザでのログイン

- **Decision**: 管理用 Worker の Access アプリ（Worker 単位、`self_hosted`）で Managed OAuth（ベータ）を有効にし、kumo CLI は OAuth 2.0 の
  公開クライアントとして、認可コードフロー（PKCE S256、`state`、RFC 8707 の `resource`）でトークンを得る。クライアントは動的登録（RFC 7591）で作る。
  管理 API には `Authorization: Bearer <アクセストークン>` を付けて送る。Access はトークンを確かめ、所有者の JWT（`email` 入り）に変えて Worker に渡す。
- **Rationale**:
  - サービストークンのシークレットを PC に配る必要がなくなる。シークレットは一度しか表示されず、2 台目の設定には `rotate` が要り、そのとき 1 台目が使えなくなる（#3）。
  - Worker の認証（`apps/admin/src/auth.ts`）は変えずに済む。OAuth のトークンでの要求は、ブラウザでのログインと同じく、所有者の `email` を持つ JWT として届く（#4 で確認）。
  - Node.js の標準機能（`fetch`、`node:http`、`node:crypto`、`node:child_process`）だけで書ける（#4 の検証スクリプトで確認）。依存を増やさない（憲法 VII）。
  - Access のポリシーをそのまま使う。トークンが出るのは `owner` ポリシーのメールアドレスでログインしたときだけで、更新のたびにポリシーが評価し直される。
- **Alternatives considered**:
  - 案 A（サービストークンを対話で入力する `kumo login`）: シークレットを持ち運ぶ問題が残り、体験も変わらない（#3 で不採用）。
  - `cloudflared access login`（`cloudflared` の `authentication_methods`）: 別のバイナリの導入と更新が要る。
  - デバイスコードフロー: Managed OAuth の文書と、#3・#4 で確かめたメタデータの範囲には出てこない。
  - OS の資格情報ストアにサービストークンを置く: 配る問題は残り、依存が増える（L9）。
- **ベータ版を使うこと（憲法 VII）**: Managed OAuth はベータで、版を固定できない。仕様が変わったり提供が止まったりしたときは、
  既存のサービストークン（環境変数・`config.json`）で使い続ける（spec FR-021）。サービストークンを残すかどうかは #10 で決める。
  CLI は Access が返すメタデータの値（エンドポイント、`resource`）を使い、URL を決め打ちしないことで、軽い変更には追従できるようにする（L4）。

## L2. 本番での検証の結果（#4、2026-10-20）

本番の Access アプリ `kumodana-admin` で Managed OAuth を有効にし、使い捨てのスクリプト（リポジトリの外。コミットしていない）で一連の流れを確かめた。
トークンの値は記録していない（先頭の数文字と長さだけ）。

### 設定と既存の経路

- `oauth_configuration` は、Worker 単位の Access アプリと Zero Trust の Free プランで有効にできた。
- 設定は `cf zero-trust access applications update <app-id> --body @…`（PUT）で行った。変更前の設定を GET して控え、同じ内容に `oauth_configuration` を
  加えて送り、GET し直して `oauth_configuration` と `updated_at` 以外に差分がないこと（ポリシーの ID と中身を含む）を確かめた。`--dry-run` で、
  `cf`（1.0.0-beta.13）でも `oauth_configuration` がそのまま送られることを確認した。
- 検証用の値（今もこの値で有効になっている）:

  ```json
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": { "enabled": true, "allow_any_on_loopback": true, "allow_any_on_localhost": false, "allowed_uris": [] },
    "grant": { "access_token_lifetime": "5m", "session_duration": "24h" }
  }
  ```

- 既存の経路は変わらない。サービストークンでの `kumo usage` は成功する。ブラウザらしい要求（`Accept: text/html`、ブラウザの UA）には、今までどおり
  302（ログイン画面へ）が返る。
- ダッシュボード（Advanced settings の「マネージド OAuth（ベータ）」）では、localhost: off、ループバック: on、許可されたリダイレクト URI: なし、
  グラントセッション期間: 24 hours と表示される。**アクセストークンの有効期間は「選択する…」（空欄）と表示される**。`5m` がドロップダウンの
  選択肢にないためとみられる。ダッシュボードで保存し直すと、値が消えたり既定値に戻ったりするおそれがある。

### 探索と登録

- ブラウザ以外から認証なしで送ると、`401` と
  `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token", …, resource_metadata="…/.well-known/cloudflare-access-protected-resource/…"` が返る
  （有効にする前は 302）。
- アプリのドメイン（管理用 Worker の URL）の `/.well-known/oauth-authorization-server` が Access から返り、`registration_endpoint` を含む
  （有効にした後は、チームドメイン側のメタデータにも出る）。`code_challenge_methods_supported` は `S256`、
  `token_endpoint_auth_methods_supported` に `none` を含む。
- `/.well-known/oauth-protected-resource` は `{ resource, authorization_servers }` を返す。保護されたリソースのメタデータの `authentication_methods` は
  `cloudflared` と `oauth` の 2 つになった。
- 動的登録（`token_endpoint_auth_method: none`、転送先 `http://127.0.0.1:<port>/callback`）は 201 を返す。応答の項目は `client_id`、`redirect_uris`、
  `client_name`、`grant_types`、`response_types`、`token_endpoint_auth_method`、`registration_client_uri`、`client_id_issued_at`。
  **`registration_access_token` と期限の項目はない**。登録したクライアントを API から消す手段はなく、数の上限は不明。

### 認可・交換・更新・取り消し

| 手順 | 結果 |
|---|---|
| 認可（PKCE S256、`state`、`resource`） | ループバックに `code` が返る |
| **ポートの不一致**（あるポートで登録し、別のポートで受ける） | `code` が届き、交換もできた。`allow_any_on_loopback` が有効なら、待ち受けのポートは毎回変えてよい |
| コードの交換 | 200。`access_token` と `refresh_token` はどちらも不透明な `oauth:…`。`token_type: bearer`、`expires_in: 300`（設定した 5m のとおり）、`scope: ""`、`resource` は末尾が `/` の管理用 Worker の URL。リフレッシュトークンの期限の項目はない |
| `Authorization: Bearer` ＋ `X-Kumodana-Client: cli` で `GET /api/usage` | **200**。Worker の JWT 検証（`aud` と所有者の `email`）を、`auth.ts` を変えずに通った |
| 更新（`grant_type=refresh_token`） | 200。**リフレッシュトークンは毎回変わる**。アクセストークンも新しくなる |
| 更新前のアクセストークン | 更新した後も 200（期限までは使える） |
| **古いリフレッシュトークンの再利用** | **200（使える）**。使い捨てではなく、再利用を検知して無効にする動きもない |
| 取り消し（`/cdn-cgi/access/oauth/revoke`、最新のリフレッシュトークン） | 200 |
| 取り消し後の更新 | 400 `invalid_grant`（"Grant not found"）。許可全体が消えたとみられる |
| **取り消し後のアクセストークン** | **すぐ 401**（`WWW-Authenticate: Bearer … error="invalid_token"`）。期限を待たずに使えなくなる |
| アプリ単位の取り消し（`cf zero-trust access applications revoke-tokens <app-id>`）の約 1 分後 | 期限内のアクセストークンでも 401。更新は 400 `invalid_grant`（"This grant has been revoked"）。サービストークンは影響を受けない |
| ユーザー単位の取り消し（`cf zero-trust access users revoke --email <owner>`）の約 1 分後 | 同上 |
| 社内プロキシ経由（`NODE_USE_ENV_PROXY=1`、`HTTPS_PROXY`） | メタデータの取得、登録、交換、更新、取り消しのすべてができた |

- 2 回目のログインは、ブラウザのログイン状態（Access のセッション）が残っていたため、約 10 秒で終わった（再ログインなし）。
- ダッシュボードには「Revoke existing tokens」のボタンが見当たらなかった（Worker 単位のアプリでは表示されないか、場所が変わっている）。
  取り消しは API（上の 2 つの `cf` コマンド）で行う。反映には 20〜30 秒ほどかかるため、確認は取り消しの約 1 分後に行った。
- 検証で発行した許可はすべて取り消し、スクリプトと保存したトークンは削除した。登録したクライアント（4 つ）は消せないため残っている。

### 本番での確認（T035、2026-10-21）

実装（PR #12）を、所有者の PC で本番の Access に対して確かめた（Access は検証用の値のまま）。quickstart §2 の US1〜US4 と既存の経路は、すべて期待どおりだった。
この節には、実装の決定に関わる振る舞いだけを書く（結果の記録は #9 で runbook §11・§12 に残す）。

| 手順 | 結果 |
|---|---|
| ログインし直した直後の `kumo usage` | 成功。前の許可の取り消しは、同じクライアントの新しい許可には効かない |
| 古い（2 回更新される前の）リフレッシュトークンで取り消し、最新の記録で `kumo usage` | `login_required`。古いリフレッシュトークンで取り消しても許可全体が消え、すぐに効く |
| **取り消し済みの許可のリフレッシュトークンで、もう一度取り消す**（`kumo logout`） | **`400 invalid_grant`（"Invalid refresh token"）**。RFC 7009 の 200 ではない。許可の期間が切れたトークンでも同じになるとみられる。実装は、これを「許可はすでに無効」として扱うように直した（L12） |
| アクセストークンの期限の 77 秒後の `kumo usage` | ブラウザを開かずに成功。`refreshedAt` が新しくなり、`loggedInAt` は変わらない |

### 未確認（実装と運用の中で確かめる）

| 項目 | 確かめる場面 |
|---|---|
| アクセストークンの期限切れの応答（取り消し後と同じ 401 `invalid_token` の見込み） | #9 の本番確認（T035 では、期限の後も先回りの更新で成功したため、401 は見ていない） |
| 許可の期間切れの応答（更新が `invalid_grant` になる見込み）と、許可の期間の起点（ログイン時か、更新で延びるか） | #9 の本番確認 |
| 1 つの PC の許可の取り消しが、別の PC の許可に影響しないこと（同じクライアントの別の許可に効かないことは、T035 で確かめた） | #9 の本番確認 |
| ダッシュボードの選択肢（アクセストークンの有効期間、グラントセッション期間）と、選んだ値が API でどう返るか | #9 で設定するとき |
| 登録したクライアントの数の上限 | 調べない（PC ごとに 1 回だけ登録するので影響が小さい） |

## L3. Access の Managed OAuth の設定値

- **Decision**（spec の Clarifications、FR-023）:
  - `dynamic_client_registration`: `enabled: true`、`allow_any_on_loopback: true`、`allow_any_on_localhost: false`、`allowed_uris: []`（#4 の値のまま）
  - `grant.access_token_lifetime`: **15 分**（既定）
  - `grant.session_duration`: **1 週間**。ダッシュボードの選択肢になければ、1 週間以下でいちばん長い値
  - 値はダッシュボードのドロップダウンから選んで保存し、その後 API で GET して、実際に入った値を手順書（runbook §6）に記録する（#9）。
    ダッシュボードの表示と API の値を一致させ、保存し直しても変わらないようにするため。
- **Rationale**:
  - Cloudflare の推奨（CLI 向けにアクセストークン 5〜15 分、許可 1〜2 週間）の範囲に入る。
  - リフレッシュトークンは再利用できる（L2）ので、漏れたときに使われうる期間は許可の期間と同じ。推奨の短い側の 1 週間にする。
    ブラウザでのログインは週 1 回で済む。
  - 取り消しはアクセストークンにもすぐ効く（L2）ので、アクセストークンを 15 分より短くしても、安全面の得はほとんどない。短くすると、更新と
    `login.json` の書き換えが増える。
  - 転送先はループバック（`127.0.0.1`）だけにする。`localhost` は名前解決の結果が環境で変わりうる（RFC 8252 §8.3）。`https` の転送先は要らない。
- **Alternatives considered**: 許可 24 時間（毎日ログインが要る）、許可 1 か月（漏れたときに最長 1 か月使われうる）、アクセストークン 5 分
  （ダッシュボードの選択肢になく、空欄と表示される）。

## L4. 接続先の情報の取得（探索）

- **Decision**: `kumo login` のとき、管理用 Worker の URL（`adminUrl`）に対して次の 2 つを取得する。
  1. `<adminUrl>/.well-known/oauth-protected-resource`（RFC 9728）: `resource` を得る。トークンの要求に付ける `resource` は、この値をそのまま使う
  2. `<adminUrl>/.well-known/oauth-authorization-server`（RFC 8414）: `authorization_endpoint`、`token_endpoint`、`revocation_endpoint`、
     `registration_endpoint` を得る。`code_challenge_methods_supported` に `S256` があり、各エンドポイントが `https:` であることを確かめる
  - `resource` は、`adminUrl` と同じオリジンであることだけを確かめる。
  - メタデータの `issuer` は確かめない。Cloudflare の文書の例では `issuer` が `https://` の付かない `<team>.cloudflareaccess.com` で、RFC 8414 の
    とおりに厳しく確かめるとログインできなくなるため（レビューの指摘 12）。エンドポイントは `https:` であることと、メタデータを `adminUrl` から
    取得したことで足りるとする。
  - URL の検証は `https:` だけを受け付ける。テストは偽の認可サーバーを `http://127.0.0.1` で動かすため、検証の関数に「ループバックの `http:` を許す」
    指定を渡す。この指定は `createRuntime` などの差し替え口からだけ渡せ、環境変数や引数からは変えられない（レビューの指摘 8）。
  - 得た値は `login.json` に保存し、更新と取り消しでは取得し直さない（L9）。
  - 取得に失敗した、JSON でない、必要な項目がない場合は `login_unavailable` とし、「管理用 Worker の Access で Managed OAuth が有効になっているか」と、
    サービストークンで使い続けられることを案内する。
- **Rationale**: どちらもアプリのドメインで Access が返すことを確かめた（L2）。`resource` は末尾の `/` の有無で別物として扱われうるので、自分で作らず
  メタデータの値を使う。401 の `WWW-Authenticate` からたどる方法（`resource_metadata`）も標準だが、要求が 1 回増えるだけで得られる情報は同じ。
- **Alternatives considered**: エンドポイントの URL の決め打ち（ベータの変更に弱い）、401 の `WWW-Authenticate` からの探索。

## L5. クライアントの登録

- **Decision**: 動的登録（`registration_endpoint` への POST）で、次の内容の公開クライアントを作る。
  `{ "client_name": "kumo CLI", "redirect_uris": ["http://127.0.0.1:<port>/callback"], "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"], "token_endpoint_auth_method": "none" }`。
  - 登録は PC ごとに 1 回だけ行い、`client_id` を `login.json` に保存して、以後のログインで使い回す（spec FR-006）。ログアウトしても消さない。
  - 登録には転送先のポートが要るので、先に待ち受けを始めてから（L6）、そのポートの転送先で登録する（レビューの指摘 2）。後のログインで違うポートで
    受けてもよい（L2）。
  - 登録し直すのは、`login.json` に登録がないとき、ログインする `adminUrl` が保存したものと違うとき、コードの交換が `invalid_client` で拒否されたとき
    （1 回だけ。新しい登録で認可からやり直す）。
  - 認可の画面での `invalid_client`（登録が消えたなど）は、RFC 6749 §4.1.2.1 のとおり転送先に戻らず、ブラウザにエラーが表示されるだけで、CLI には
    届かない。CLI は `login_timeout` で終わるので、その案内に「ブラウザにクライアントのエラーが表示された場合は、`login.json` を削除してから
    `kumo login` を実行してください」を含める（レビューの指摘 3）。自動で登録し直すのは、交換の `invalid_client` のときだけ。
  - 保存の時期: `login.json` に `session` がなければ、登録した直後に保存する。ログインがその後で時間切れや中断になっても、登録は残す
    （資格情報ではない）。`session` があるとき（別の `adminUrl` でのログインし直し、`invalid_client` での登録し直し）は、交換の後に新しい `session` と
    まとめて保存する。途中で失敗しても、前の `session` と、それを発行した `client`・`endpoints` の組が崩れないようにするため。
  - `client_name` に PC 名やユーザー名を入れない。
- **Rationale**: 登録したクライアントは API から消せず、上限も不明（L2）。ログインのたびに登録すると、消せないクライアントが増え続ける。
  転送先のポートは登録時と違ってよい（L2）ので、毎回空いているポートで待ち受けても登録し直す必要はない。

## L6. ブラウザからの受け取り（ループバック）と、認可の要求

- **Decision**:
  - `node:http` で `127.0.0.1` のポート 0（OS が空いているポートを選ぶ）で待ち受け、転送先は `http://127.0.0.1:<port>/callback` とする。
  - 認可の要求に付けるもの: `response_type=code`、`client_id`、`redirect_uri`、`state`、`code_challenge`、`code_challenge_method=S256`、`resource`。
    `scope` は付けない（#4 と同じ。応答の `scope` は空）。
  - PKCE: `code_verifier` は 32 バイトの乱数を base64url にした 43 文字。`code_challenge` は SHA-256 の base64url。チャレンジの先頭が英数字に
    なるまで作り直す（#6 の注意）。`state` は 32 バイトの乱数の base64url。どれも `node:crypto` で作る。
  - 待ち受けで受け付けるのは、`Host` が `127.0.0.1:<port>` の `GET /callback` だけ。ほかのパスは 404。
    - `state` が一致しない: 400 のページ（「この応答は、いま実行中の kumo login のものではありません」）を返し、待ち続ける
    - `state` が一致し、`error` がある: エラーのページを返し、`login_denied`（`error` と `error_description` を表示）で終わる
    - `state` が一致し、`code` がある: 完了のページ（「ログインしました。このタブを閉じてください」）を返し、待ち受けを閉じて交換に進む
  - 返すページは小さな HTML で、外部の資源を読まない。`Cache-Control: no-store`、`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`、
    `Referrer-Policy: no-referrer` を付ける。
  - 待つのは最長 5 分。時間切れは `login_timeout`。待ち受けを閉じ、資格情報は何も保存しない。Ctrl+C で中断したときも、交換の前なので何も保存されない。
  - `127.0.0.1` で待ち受けられないとき（ループバックがないなど）は `callback_unavailable`。
- **Rationale**:
  - ループバックへの転送は、ネイティブアプリ向けの標準の方法（RFC 8252 §7.3）。認可コードは、ログインした人の PC の中にしか届かない。
  - 同じ PC のほかのプログラムがコードを横取りしても、`code_verifier` がなければ交換できない（PKCE）。`state` で、このログインの応答であることを確かめる。
  - `state` の不一致で終わらせずに待ち続けるのは、古いタブや別のページからの要求で、実行中のログインを止められないようにするため。
  - `Host` の確認は、DNS リバインディングで外部のページから待ち受けに要求させる攻撃への備え。
- **Alternatives considered**: 固定のポート（ほかのプログラムと衝突する）、`localhost`（L3）、URL を手で貼り付ける方式（体験が悪い）。

## L7. ブラウザの起動

- **Decision**: 認可の URL を、まず標準エラー出力に表示し、続けて既定のブラウザで開く。シェルを通さずに起動する（`spawn`、`shell: false`）。
  - Windows: `%SystemRoot%\System32\rundll32.exe url.dll,FileProtocolHandler <url>`（絶対パスで起動する。`SystemRoot` がないときや、絶対パスでないとき（空、空白だけ、相対パス）は `C:\Windows`）
  - macOS: `open <url>`、それ以外: `xdg-open <url>`
  - 起動に失敗しても（コマンドがないなど）、URL は表示済みなので、そのまま待つ。`--no-open` のときは開かずに待つ。
  - 開く関数は差し替え可能にし、テストでは「ブラウザと Access の役」をする関数に替える。
- **Rationale**: `cmd /c start` は URL の `&` をシェルの区切りとして解釈し、URL が途中で切れる。シェルを通さなければ `&` は文字のまま渡る。
  `rundll32 url.dll,FileProtocolHandler` は、URL を既定のブラウザで開くために広く使われている方法（Go の `pkg/browser` など）。
  `kumo preview` はファイルを開くため `explorer.exe` を使っている。こちらも絶対パス（`%SystemRoot%\explorer.exe`）で起動するようにした。
  - 絶対パスにするのは、Windows の Node.js（libuv）が、パスのないコマンド名を PATH より先に**今のフォルダー**から探すため。
    `kumo` を実行したフォルダーに `rundll32.exe` という名前のファイルがあると、所有者の権限でそれが動く（CWE-427。PR #12 のレビュー）。
- **Alternatives considered**: `cmd /c start`（`&` の問題）、`explorer.exe <url>`（URL も開けるが、引数を独自の規則で解釈する）、
  PowerShell の `Start-Process`（起動が遅い）、npm の `open`（依存が増える）。
- **実装時の確認事項**: Windows で、`&` を含む長い URL（500 文字程度）がそのまま既定のブラウザに渡ることを確かめる。

## L8. コードの交換と、アクセストークンの更新

- **Decision**:
  - 交換: `token_endpoint` に `application/x-www-form-urlencoded` で `grant_type=authorization_code`、`code`、`redirect_uri`（認可の要求と同じ）、
    `client_id`、`code_verifier`、`resource` を送る。
  - 更新: `grant_type=refresh_token`、`refresh_token`、`client_id`、`resource` を送る。応答に `refresh_token` があれば置き換え、なければ前のものを使い続ける。
  - アクセストークンの期限は「受け取った時刻 ＋ `expires_in`」として保存する。
  - 更新の時期:
    1. 管理 API を呼ぶ前に、期限まで 60 秒を切っていれば更新する。この先回りの更新が一時的な理由（`network_error`・`refresh_failed`）で失敗し、
       アクセストークンの期限がまだ過ぎていなければ、警告を出して今のトークンで送る（PR #12 のレビュー）。期限は、実際に送るトークンの
       session のもので判断する（更新の途中で、ほかの `kumo` が書いた session に入れ替わることがあるため。PR #12 の再レビュー）。許可が消えているとき（`login_required`）は
       そのまま失敗にする
    2. 管理 API が 401 を返したら（`WWW-Authenticate: Bearer` か Worker の `unauthenticated`）、1 回だけ更新して同じ要求をやり直す
       （送る本文はバイト列か JSON で、もう一度送れる）。やり直しても 401 なら `login_required`
  - 更新が `invalid_grant`・`invalid_client`・`unauthorized_client` で拒否されたら、`login.json` を読み直す。ほかの `kumo` が新しいリフレッシュトークンを
    書いていれば、それで 1 回だけやり直す（そのアクセストークンが期限内なら、更新せずにそれを使う）。同じなら `login_required`（「`kumo login` を
    実行してください」）。それ以外の失敗（認可サーバーの 5xx など）は `refresh_failed`、通信の失敗は `network_error` にする。
  - 更新したトークンを書く前に、`login.json` を読み直し、`adminUrl` と `session.loggedInAt` が読み込んだときと同じ場合だけ書く（レビューの指摘 4）。
    その間に `kumo login` が新しい `session` を書いていた、または `kumo logout` が `session` を消していた場合は書かず、手元の新しいトークンで
    その操作だけを続ける。古い `session` を書き戻して、新しいログインを `login_required` にしたり、ログアウトを取り消したりしないため。
    読み直しと置き換えの間のごく短い間の重なりは残るが、そのときも次の管理操作が `login_required` になるだけで、ログインし直せば直る。
  - トークンの要求（交換・更新・取り消し・登録）は `redirect: "error"` で送り、転送に従わない。
- **Rationale**:
  - 期限の前に更新すれば、ふだんは 401 を待たずに済む。401 での更新とやり直しは、期限の計算のずれや、Access 側の事情への備え。
  - 古いリフレッシュトークンも使える（L2）ので、2 つの `kumo` が同時に更新しても両方成功する。ロックファイルは使わない（L9）。
  - ベータなので、再利用の検知が後から入る可能性がある。そのときは、同時の更新で許可が無効になりうるが、上の流れで最後には「`kumo login` を実行してください」
    に行き着く。
  - 転送に従わないのは、リフレッシュトークンを別の場所に送らないため。
- **Alternatives considered**: 更新のたびのロックファイル（Windows で残骸の扱いが難しく、L2 の結果から不要）、401 を待ってから更新する（毎回 1 往復増える）。

## L9. ログインの記録（`login.json`）の保存

- **Decision**（spec の Clarifications、FR-014）:
  - 場所は `config.json` と同じフォルダー。Windows では `%APPDATA%\kumodana\login.json`、それ以外では `$XDG_CONFIG_HOME/kumodana/login.json`
    （未設定なら `~/.config/kumodana/login.json`）。CLI が書き換えるのはこのファイルだけで、`config.json` は書き換えない。
  - 形式は [data-model.md](./data-model.md)。平文の JSON。
  - 書き込みは、同じフォルダーの一時ファイル（`login.json.<乱数>.tmp`）に書いてから `rename` で置き換える。途中で止まっても、`login.json` は前の内容か
    新しい内容のどちらかになる。
  - Windows で置き換えが `EPERM`・`EACCES`・`EBUSY` で失敗したら（ほかのプログラムが開いている、書いた直後のファイルをウイルス対策などが開いているなど）、
    50・100・200・400・800・1,000 ミリ秒の間隔で最大 6 回（合計で約 2.5 秒）やり直す。それでも失敗したら、一時ファイルを消す。アクセストークンの更新のときは、
    警告を出して処理を続ける（前のリフレッシュトークンも使える。L2）。`kumo login` の交換の後のときは、新しいリフレッシュトークンをできる範囲で
    取り消してから `login_write_failed` で終わる（記録のない許可を残さないため）。
  - 最初は 50・100・200 ミリ秒（合計 350 ミリ秒）だったが、Windows で、同じファイルへの書き込みと置き換えを続けると、置き換えられるまで最長で
    約 750 ミリ秒かかり、テストと `kumo login` が失敗しうることが分かった（PR #12 のレビュー）。
  - 読み込みも、`EPERM`・`EACCES`・`EBUSY` なら同じ間隔でやり直す。Windows では、ほかの `kumo` が置き換えている最中の読み込みが失敗しうる
    ため（レビューの指摘 5）。それでも失敗したら `login_read_failed`（終了コード 1）。`login_invalid`（終了コード 2）にするのは、JSON や形式の
    誤りだけ。
  - Windows 以外では、フォルダーを作るときは 700、一時ファイルは 600 で作る（置き換えた後の `login.json` も 600 になる）。
  - Windows では権限を変えない。`%APPDATA%` はユーザーのプロファイルの中にあり、既定でそのユーザー（と SYSTEM・管理者）だけが読める。
- **Rationale**:
  - アクセストークンの更新のたびに（15 分ごと）、複数の `kumo` から書き換わる。所有者が手で書く `config.json` と分ければ、手で書いた内容を壊さない。
    権限とログアウト時の削除も、このファイルだけで済む。
  - OS の資格情報ストアは依存（ネイティブのモジュール）が増える（憲法 VII）。今 `config.json` に平文で置いているサービストークン（期限 1 年、取り消しは
    再発行だけ）と比べ、許可は 1 週間で切れ、ログアウトや API ですぐ取り消せるので、漏れたときの影響は小さい。
- **Alternatives considered**: `config.json` に同居（手で書いたファイルを CLI が頻繁に書き換える）、OS の資格情報ストア（依存が増える）、
  PowerShell の DPAPI（`ConvertFrom-SecureString`）で暗号化（起動が遅く、Windows だけ。守れるのは別のユーザーからだけで、ファイルの権限と変わらない）。

## L10. 資格情報の選び方と、管理 API の URL

- **Decision**（spec の Clarifications、FR-009・FR-013）: 管理操作のたびに、次の順で選ぶ。
  1. 環境変数 `KUMODANA_CLIENT_ID` か `KUMODANA_CLIENT_SECRET` の一方でもあれば、**サービストークン**（今の `loadConfig` と同じ。環境変数と `config.json` を
     項目ごとに組み合わせ、足りなければ `config_missing`）
  2. `login.json` に資格情報（`session`）があれば、**ログイン**。管理 API の URL は `login.json` の `adminUrl`。環境変数 `KUMODANA_ADMIN_URL` があって
     `adminUrl` と違えば、トークンを送らずに `admin_url_mismatch`（終了コード 2）
  3. `config.json` に `clientId` か `clientSecret` があれば、**サービストークン**（今と同じ。足りなければ `config_missing`）
  4. どれもなければ `config_missing`（終了コード 2）で、`kumo login <adminUrl>` を案内する
  - 方法は上の条件だけで決め、値がそろっているかは方法を決めた後に確かめる（レビューの指摘 1）。管理操作は、サービストークンの値が足りなければ今と同じ
    `config_missing` にする。`kumo login --status` は、足りない項目の名前を `notes` に出して終了コード 0 で終わる。
  - URL の比較は、末尾の `/` を除いた形で行う（今の `loadConfig` と同じ正規化）。
  - `config.json` の `adminUrl` は、サービストークンの経路と、`kumo login` で URL を省略したときの候補にだけ使う。ログインの経路では使わない
    （`login.json` と違っていても誤りにしない。`kumo login --status` で食い違いを知らせる）。
  - `kumo login` で URL を省略したときは、`KUMODANA_ADMIN_URL` → `login.json` の `adminUrl` → `config.json` の `adminUrl` の順に使う。
- **Rationale**: 環境変数は、そのシェルだけで明示的に上書きする手段で、自動処理や Managed OAuth が使えないときの退路になる。ふだんはログインを使い、
  `config.json` に残ったサービストークンは予備になる。トークンをログインした URL にだけ送るのは、別の URL（打ち間違いや古い設定）に資格情報を
  渡さないため（FR-013）。`config.json` の URL まで誤りにすると、古い `config.json` が残っている PC でログインしても使えなくなる。

## L11. エラーの案内（`toApiError` と `AUTH_HINT` の整理）

- **Decision**: 今の `AUTH_HINT`（サービストークン向け）を、使っている方法で出し分ける。
  - サービストークンのとき: 今の案内のまま（ID とシークレット、期限、Access のポリシー）。既存のテストの期待は変えない
  - ログインのとき: `login_required`（終了コード 1）「ログインの期限が切れたか、取り消されました。`kumo login` を実行してください」
  - Access の 401（`WWW-Authenticate: Bearer`、本文は JSON でない）: ログインなら L8 の更新とやり直しの後に `login_required`。サービストークンなら
    今の `access_denied` と同じ案内（Managed OAuth を有効にした後は、誤ったサービストークンにも 401 が返りうる）
  - Worker の 401 `unauthenticated`: 方法ごとの案内。403 `forbidden`: ログインなら「ログインしたアカウントが所有者のものか、管理用 Worker の
    `OWNER_EMAIL` と一致しているか」を案内する
  - Access の 403（本文が JSON でない）: サービストークンなら今の `access_denied`。ログインなら同じ `access_denied` で、「ログインしたアカウントが
    所有者のものか、Access の `owner` ポリシーを確かめてください」と案内する（レビューの指摘 6）
  - Access のログイン画面への 302: サービストークンなら今の `access_login_required`。ログインなら `login_required`
  - 更新・交換の `invalid_grant`: L8 の読み直しの後に `login_required`。`invalid_client`: 交換のときは登録し直し（L5）、更新のときは `login_required`
- **Rationale**: 方法に合わない案内（ログインしているのに「シークレットを確かめて」）は、直し方を誤らせる。`login_required` は、期限切れと取り消しを
  区別しない（CLI からは区別できず、対処も同じ）。

## L12. ログアウト

- **Decision**: `kumo logout` は次の順に行う。
  1. `login.json` を読む。トークンがなければ「ログインしていません」と表示して終了コード 0
  2. `revocation_endpoint` に `token=<リフレッシュトークン>`、`token_type_hint=refresh_token`、`client_id` を送る（RFC 7009）
  3. 成否にかかわらず、`login.json` からトークン（アクセストークン、期限、リフレッシュトークン、ログインした日時）を消す。`adminUrl`、エンドポイント、
     登録（`client_id`）は残す
  4. 取り消しの応答が `400 invalid_grant` なら、許可は**すでに無効**（取り消し済みか、許可の期間切れ）とみなし、「この PC の許可はすでに無効でした」と
     表示して終了コード 0。`--json` は `revoked: true`（許可はもう使えない）と `alreadyInvalid: true`（T035 の後に追加）
  5. それ以外の失敗（通信の失敗、5xx、`invalid_grant` 以外のエラー）は、許可が残っているかもしれないので、`revoke_failed`（終了コード 1）で、許可が
     期間まで有効なこと、取り消す方法（runbook §7 の `revoke-tokens` と `users revoke`。ほかの PC の許可も消える）を表示する
  6. 環境変数のサービストークンがあれば、それが引き続き使われることを警告する。`config.json` にサービストークンがあれば、今後はそれが使われることを知らせる
  - アクセストークンは別に取り消さない。リフレッシュトークンの取り消しで、アクセストークンもすぐ使えなくなる（L2）。
- **Rationale**: 取り消しを先に行うのは、トークンを消した後では取り消せないため。通信できないときにローカルの記録を残すと、使えない PC から消す手段がなくなる。
  Access は、取り消し済みや期限切れの許可のトークンの取り消しに `400 invalid_grant` を返す（T035。L2）。最初の実装はこれを `revoke_failed` にしていたため、
  許可の期間が切れた後の、ふつうの `kumo logout` でも「許可は期間が切れるまで有効です」と誤って案内し、終了コード 1 で終わっていた。
- **確認済み**（T035）: `login.json` のリフレッシュトークンが最新でない（ほかの `kumo` が更新した後の）場合も、取り消すと許可全体が消える。

## L13. ログインし直すとき

- **Decision**: ログイン済みの PC で `kumo login` を実行したときは、新しいトークンを保存した後に、前のリフレッシュトークンを取り消す（失敗したら警告。
  前の許可がすでに無効で `400 invalid_grant` が返ったときは、何もしなくてよいので警告しない。T035）。
  その後、新しいトークンで `GET /api/usage` を呼んで確かめる（spec FR-007・FR-008）。別の `adminUrl` でログインし直すときも同じで、前の記録は置き換える。
  前の許可の取り消しには、前の記録のエンドポイントと `client_id` を使う。
- **Rationale**: ログインのたびに許可が増えると、使われない許可が期間まで残る。取り消しを後にするのは、新しいログインが失敗したときに前の許可を失わないため。
  確かめを取り消しの後に行うので、取り消しが新しい許可にまで効いてしまう場合も気づける。本番（T035）では、効かないことを確かめた（L2）。
- **退路**（レビューの指摘 7）: 前の許可を取り消した後の確かめが `login_required` で失敗したときは、「`kumo logout` の後に `kumo login` を実行してください」と
  案内する。`kumo logout` で `session` が消えた後の `kumo login` は、前の許可がないので取り消しを行わない。T035 で効かないことを確かめたので、
  この退路は、Access の振る舞いが後で変わったときの備えとして残す。

## L14. 出力から隠す値

- **Decision**: アクセストークンとリフレッシュトークンを、読み込んだときと更新したときに `out.secrets` に加える（`redact` で `[REDACTED]` に置き換わる）。
  認可コード、`code_verifier`、`state` は出力に使わない。認可コードは、交換のエラーの説明に含まれた場合に備えて、受け取った直後に `out.secrets` にも
  加える（PR #12 のレビュー）。認可の URL（`state` と `code_challenge` を含む）は表示する。
  トークンの要求のエラーは、応答の `error` と `error_description` だけを表示し、要求の本文は表示しない。
- **Rationale**: 今のサービストークンのシークレットと同じ仕組みで、表示の経路をすべて覆える（001 の FR-033）。認可の URL は秘密ではなく、ブラウザを
  開けないときに所有者が使う。
- **確認**: すべてのコマンドを `--json` 付きと無しで実行し、偽の認可サーバーが発行したトークンが標準出力にも標準エラー出力にも現れないことをテストする。

## L15. 安全性の確認

| 心配 | 対策と、残るリスク |
|---|---|
| 動的登録が誰にでも開いている | 誰でもクライアントを作れるが、トークンが出るのは `owner` ポリシーのメールアドレスでログインしたときだけ。転送先はループバックだけなので（L3）、他人が作ったクライアントで所有者をだましてログインさせても、認可コードは所有者の PC の中にしか届かない。消せないクライアントが増えうるが、権限は持たない |
| 認可コードの横取り | PKCE（S256）により、`code_verifier` を持つこの `kumo` しか交換できない。`state` と `Host` を確かめる（L6）。コードは 1 回だけ使え、ブラウザの履歴に残っても使えない |
| トークンが出力に漏れる | L14。テストで確かめる |
| トークンが別のサーバーに送られる | アクセストークンはログインした `adminUrl` にだけ送る（L10）。リフレッシュトークンは、ログイン時に得た `token_endpoint` と `revocation_endpoint` にだけ送り、転送に従わない（L8） |
| `login.json` が漏れる | 許可の期間（1 週間）が切れるか取り消すまで、リフレッシュトークンが使われうる（再利用できるため。L2）。対処は `kumo logout`、または API での取り消し（アプリ単位・ユーザー単位）。Windows 以外は 600（L9） |
| プロセスの一覧から見える | コマンドの引数にトークンを渡さない。ブラウザに渡す URL は秘密を含まない |
| 今のフォルダーに置かれたプログラムが動く | Windows でブラウザを開くプログラム（`rundll32.exe`、`kumo preview` の `explorer.exe`）は、`SystemRoot` の下の絶対パスで起動する（L7。CWE-427） |
| Managed OAuth を有効にしたことによる影響 | ブラウザ以外への応答が 302 から 401 に変わるだけで、ブラウザでのログインとサービストークンは変わらない（L2）。配信用 Worker と閲覧者には関係しない |

## L16. テスト

- **Decision**: Vitest（Node.js、`apps/cli`）で、偽の認可サーバー兼管理 API（`node:http` のローカルサーバー。`apps/cli/test/auth-server.ts`）を使って確かめる。
  - 偽のサーバーは、2 つのメタデータ、登録、認可（ブラウザと Access の役。転送先に `code` と `state` を付けて 302 を返す）、交換、更新（毎回違う
    リフレッシュトークンを返し、古いものも受け付ける）、取り消し、`/api/usage` を持つ
  - ブラウザを開く関数を差し替え、認可の URL に `fetch` して転送先までたどる（転送先はテスト中の待ち受け）。時間切れの上限も差し替えて短くする
  - `login.json` は一時フォルダーに置く（`APPDATA` か `XDG_CONFIG_HOME` を差し替える）。権限（600）の確認は Windows 以外でだけ行う
  - 既存のテスト（サービストークンの経路を含む）は変えずに通す
- **Rationale**: 本物の Access はテストから使えない。HTTP の振る舞いは #4 の結果（L2）に合わせて作る。Worker の認証は変えないので、workerd のテストは
  変更不要（憲法 VI の必須項目は既存のテストのまま）。

## L17. 本番での確認

- **Decision**: 実装（#6〜#8）の後、[quickstart.md](./quickstart.md) の §2 の手順で、所有者が本番で確かめる。Access の最終的な設定値（L3）は #9 で
  ダッシュボードから設定し、その値と手順を runbook §6 に、結果と L2 の未確認の項目を runbook の検証の記録に残す（個人を特定できる値は書かない）。
  利用者向けの手順（README、runbook §7 のログイン・ログアウト・PC をなくしたときの対処など）は、#9 を待たずに実装の PR で書く。
- **Rationale**: 期限切れ、許可の期間、ほかの PC への影響は、本物の Access でしか確かめられない。
