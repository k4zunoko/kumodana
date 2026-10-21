# Quickstart: kumo login / logout の検証手順

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/cli.md](./contracts/cli.md)、[contracts/admin-api.md](./contracts/admin-api.md)

実装が仕様どおりに動くことを確かめる手順。変わるのは kumo CLI だけで、Worker のデプロイは要らない。Access の設定（Managed OAuth の期間の値）は
#9 で変える。

## 前提

- Node.js 22.18 以上
- 本番での確認（§2）は、001 の初期設定が済み、管理用 Worker の Access アプリで Managed OAuth が有効になっていること（#4 で有効にした）
- この変更を含む CLI を使う: `npm ci` の後、`npm install -g ./apps/cli`（001 の research R16）
- 記録には、サブドメイン、チーム名、メールアドレス、各種 ID、AUD、トークンの値を書かない

## 1. ローカルでの検証（自動テスト）

```sh
npm ci
npm run typecheck
npm test
git diff --stat main -- apps/admin apps/files packages/shared   # 空であること（Worker と共有の型を変えていない）
```

期待結果: すべて成功する。CLI のテストは、偽の認可サーバー兼管理 API を使って次を確かめる（research L16）。

- `kumo login`: 探索 → 登録 → 認可 → 交換 → 保存 → `GET /api/usage` の流れ。2 回目のログインで登録し直さないこと、前の許可を取り消すこと
- 受け取り: `state` の不一致（待ち続ける）、`error` の応答、時間切れ、`Host` の違い、ほかのパス
- 保存: `login.json` の内容、Windows 以外での権限 600、壊れた `login.json`、置き換えの失敗で警告して続けること
- 管理操作: 期限前の更新、401 での 1 回だけの更新とやり直し、`invalid_grant` での読み直し、`login_required`、2 つの更新が同時でも両方成功すること
- 優先順位: 環境変数のサービストークン → ログイン → `config.json` のサービストークン。`KUMODANA_ADMIN_URL` の食い違いでトークンを送らないこと
- `kumo logout`: 取り消しの成功と失敗、`session` だけが消えて `adminUrl` と登録が残ること、環境変数があるときの警告、ログインしていないとき
- `kumo login --status`: 4 つの方法の表示、通信しないこと
- すべてのコマンドの出力（`--json` を含む）とエラーに、アクセストークン・リフレッシュトークン・認可コードが現れないこと
- 既存のテスト（サービストークンの経路を含む）が変更なしで通ること

## 2. 本番での確認

所有者の PC で、PowerShell を使う例。新しい PC の代わりに、`APPDATA` を一時フォルダーに向けて確かめる（`config.json` も `login.json` もない状態になる）。
この方法でも、この PC のクライアントが 1 つ登録される（消せない。research L5）。

```powershell
$env:APPDATA = Join-Path $env:TEMP "kumo-login-check"
Remove-Item Env:KUMODANA_CLIENT_ID, Env:KUMODANA_CLIENT_SECRET, Env:KUMODANA_ADMIN_URL -ErrorAction SilentlyContinue
```

### US1: 新しい PC でログインして使い始める（SC-001）

```powershell
Measure-Command { kumo login https://kumodana-admin.<subdomain>.workers.dev | Out-Default }
```

- 期待: URL が表示され、既定のブラウザでログインの画面が開く。所有者のアカウントでログインすると、ブラウザに「ログインしました」と表示され、
  CLI に `ログインしました` と使用量が出る。インストールからここまで 3 分以内
- 期待: `"$env:APPDATA\kumodana\login.json"` ができていて、`config.json` はない
- 期待: `kumo login --no-open` は URL を表示するだけで待つ。その URL を手でブラウザに貼るとログインできる
- 期待: もう一度 `kumo login` を実行すると、登録し直さずに（`login.json` の `client.clientId` が変わらない）ログインし直せる
- 期待: ブラウザで何もせずに 5 分待つと `login_timeout` で終わり、`session` は書き換わらない

### US2: ブラウザを開かずに使い続ける（SC-002、SC-005、SC-006）

- 期待: アクセストークンの期限（今の設定では 5 分、#9 の後は 15 分）を過ぎてから `kumo usage` を実行すると、ブラウザを開かずに成功し、
  `login.json` の `session.refreshedAt` が新しくなる
- 期待: `Start-Job { kumo usage }` などで 2 つを同時に実行しても両方成功し、`login.json` が JSON として読める
- 期待: `cf zero-trust access applications revoke-tokens <app-id>` で取り消し、約 1 分後に `kumo usage` を実行すると、`login_required`（「`kumo login` を
  実行してください」）で終了コード 1 になる。`kumo login` でまた使えるようになる。（この操作はほかの PC の許可も消す）
- 期待: 許可の期間（今の設定では 24 時間、#9 の後は 1 週間）を過ぎてから `kumo usage` を実行すると `login_required` になる。ログインからの期間か、
  最後の更新からの期間かを記録する（research L2 の未確認）
- 期待: `kumo usage --json` などの出力に、`oauth:` で始まる値が現れない

### US3: ログアウト（SC-003）

```powershell
kumo logout
kumo usage
```

- 期待: `ログアウトしました` と表示され、`kumo usage` は `config_missing`（`kumo login` の案内）になる。`login.json` の `session` は `null` で、
  `adminUrl` と `client` は残る
- 期待: ログアウトの前に `login.json` を別の場所に写しておき、ログアウトの後に写しを `login.json` に戻して `kumo usage` を実行すると、
  アクセストークンの期限前でも `login_required` になる（取り消しがその時点から効いている。写しは確認の後すぐに削除し、もう一度 `kumo logout` する）
- 期待: もう一度 `kumo logout` を実行すると `ログインしていません` で終了コード 0
- 期待: ネットワークを切ってログアウトすると、`revoke_failed` で終了コード 1 になり、取り消す方法が表示される。`session` は消えている
  （この許可は `cf zero-trust access users revoke --email <owner>` などで取り消しておく）
- 期待: 2 つの環境（`APPDATA` を変えた 2 つのシェル）でログインし、一方でログアウトしても、もう一方の `kumo usage` は成功する（research L2 の未確認）

### US4: 状態の確認

- 期待: `kumo login --status` が、方法・URL・ログインした日時・アクセストークンの期限を表示する。ネットワークを切っても同じ結果になる
- 期待: `$env:KUMODANA_CLIENT_ID = "x"` を設定すると、方法が `サービストークン（環境変数）` になり、足りない項目（`KUMODANA_CLIENT_SECRET`、
  `KUMODANA_ADMIN_URL`）が知らされる。終了コードは 0（確認の後に `Remove-Item Env:KUMODANA_CLIENT_ID`）
- 期待: 壊れた `config.json`（中身が `{ broken` など）を置いても、`kumo login --status` は「config.json を読み込めません」を知らせて
  終了コード 0 で終わる（確認の後にその `config.json` を消す）

### 既存の経路（SC-007）

- 期待: `APPDATA` を元に戻し（新しいシェルを開く）、`config.json` のサービストークンで `kumo usage` が今までどおり成功する
- 期待: ブラウザで管理用 Worker の URL を開くと、今までどおり Access のログイン画面が出る

### 後片付け

- 一時フォルダー（`$env:TEMP\kumo-login-check`）を、`kumo logout` の後に削除する
- 結果を runbook に残す（#9 の T038。quickstart の結果は §12、research L2 の未確認の項目の結果は §11。個人を特定できる値は書かない）
