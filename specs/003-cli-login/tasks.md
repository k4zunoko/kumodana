---

description: "Task list for 003-cli-login"
---

# Tasks: kumo CLI にブラウザでログインする（kumo login / logout）

**Input**: Design documents from `/specs/003-cli-login/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, contracts/admin-api.md, quickstart.md

**Tests**: 憲法 VI（認証と認可）と #6〜#8 の「テスト」に従い、ログイン・更新・取り消し・出力から隠すことのテストを書く。各ストーリーで、
テストを先に書いて失敗を確かめてから実装する。既存のテスト（サービストークンの経路を含む）は変えずに通す。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1〜US4)
- パスはリポジトリのルートからの相対パス（plan.md の Project Structure に従う）
- 各フェーズに、対応する Issue（#6〜#9）を書く。Phase 1〜7 は実装の PR（#6〜#8）、Phase 8 はその後の運用の作業（#9）
- 変えないもの: `apps/admin/**`、`apps/files/**`、`apps/admin/migrations/**`、`packages/shared/**`、`apps/cli/package.json` の依存
- 個人を特定できる値（サブドメイン、チーム名、メールアドレス、各種 ID、AUD）とトークンの値を、コード・テスト・文書・コミットに含めない

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: すべてのストーリーのテストが使う、偽の認可サーバーと設定の場所（#6・#7）

- [ ] T001 `apps/cli/test/helpers.ts` に偽の認可サーバー兼管理 API（`mockAuthServer`）を加える（research L16）: `/.well-known/oauth-protected-resource`（`resource` は末尾が `/` の URL）、`/.well-known/oauth-authorization-server`（`S256`、`none`、4 つのエンドポイント）、登録（201 で `client_id`。登録の回数を数える）、認可（ブラウザと Access の役。`redirect_uri` に `code` と `state` を付けて 302。`error` を返す設定も持つ）、トークン（交換と更新。更新のたびに違うリフレッシュトークンを返し、古いものも受け付ける。`invalid_grant`・`invalid_client` を返す設定も持つ）、取り消し（取り消したリフレッシュトークンの許可全体を無効にし、そのアクセストークンも 401 にする）、`GET /api/usage`（`Authorization: Bearer` を確かめ、無効なら `401` と `WWW-Authenticate: Bearer … error="invalid_token"`）。既存の `mockApi`・`testRuntime` は変えない
- [ ] T002 `apps/cli/src/config.ts` に `loginFilePath(env, platform)` を加える（`config.json` と同じフォルダーの `login.json`）。`apps/cli/test/config.test.ts` に Windows とそれ以外のパスのテストを足す。既存の `loadConfig` とそのテストは変えない

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: ログインの記録の保存、資格情報の選択、`AdminApi` の方法の切り替え（#7。#6 の確かめにも要る）

- [ ] T003 [P] `apps/cli/test/login-store.test.ts` を書く（data-model の `login.json`）: 書いて読める、ファイルがなければ「記録なし」、`"version"` が `1` 以外・JSON でない・必須の項目（`adminUrl`、`endpoints`、`client`）の型が違う・`session` があるのに `client` がない場合は `login_invalid`（終了コード 2、資格情報の値をメッセージに含めない）、`adminUrl` は末尾の `/` を除いた形で `https:`（テストだけ `http://127.0.0.1`）、`endpoints` はすべて `https:`（テストだけ `http://127.0.0.1`）、`session` を `null` にすると `adminUrl`・`endpoints`・`client` が残る、書き込みは一時ファイルから置き換える（途中で失敗しても前の内容が残る）、`rename` が `EPERM`・`EACCES`・`EBUSY` で失敗し続けたら一時ファイルを消して「保存できなかった」を返す（例外にしない）、Windows 以外ではファイルが 600・新しく作るフォルダーが 700
- [ ] T004 `apps/cli/src/login-store.ts` を実装する（research L9、data-model）: `readLogin`、`writeLogin`（同じフォルダーの `login.json.<乱数>.tmp` に書いて `rename`。`EPERM`・`EACCES`・`EBUSY` なら 50・100・200 ミリ秒待って最大 3 回やり直す）、`clearSession`
- [ ] T005 [P] `apps/cli/test/credentials.test.ts` に資格情報の選択のテストを書く（research L10、contracts/cli.md の「設定」）: 環境変数 `KUMODANA_CLIENT_ID` か `KUMODANA_CLIENT_SECRET` の一方でもあれば `env_service_token`（今の `loadConfig` と同じ組み合わせと `config_missing`）、次に `login.json` に `session` があれば `login`（URL は `login.json` の `adminUrl`。`KUMODANA_ADMIN_URL` が末尾の `/` を除いて違えば `admin_url_mismatch`、終了コード 2）、次に `config.json` に `clientId` か `clientSecret` があれば `config_service_token`、どれもなければ `config_missing`（終了コード 2、`kumo login <adminUrl>` を案内）。`config.json` の `adminUrl` が `login.json` と違っても `login` は誤りにしない
- [ ] T006 `apps/cli/src/credentials.ts` に `resolveCredentials(env, platform)` と、方法ごとの「ヘッダーを作る・隠す値を返す」部品を実装する（サービストークン: 今の `CF-Access-Client-Id`・`CF-Access-Client-Secret`、ログイン: `Authorization: Bearer`。更新は Phase 4 で足す）
- [ ] T007 `apps/cli/src/api.ts` と `apps/cli/src/runtime.ts` を、方法を受け取る形に変える。サービストークンの経路の振る舞いと案内（`AUTH_HINT`、`access_login_required`、`access_denied`）は変えない。`RuntimeOptions.loadConfig` の差し替え口は残し、既存の `apps/cli/test/*.test.ts` が変更なしで通ることを確かめる。読み込んだ資格情報（シークレット、アクセストークン、リフレッシュトークン）を `out.secrets` に加える

**Checkpoint**: 既存の CLI のテストがすべて通る。`login.json` の読み書きと、資格情報の選択が単体で動く

---

## Phase 3: User Story 1 - 新しい PC で、ブラウザでログインして使い始める (Priority: P1) 🎯 MVP（#6）

**Goal**: `kumo login <adminUrl>` で、ブラウザでログインして `login.json` に保存し、`GET /api/usage` で確かめられる

**Independent Test**: 偽の認可サーバーで、探索 → 登録 → 認可 → 交換 → 保存 → `GET /api/usage` が通り、出力にトークンが現れない

### Tests for User Story 1 ⚠️

- [ ] T008 [P] [US1] `apps/cli/test/oauth.test.ts` を書く（research L4〜L6・L8）: 2 つのメタデータの取得と検証（`S256` がない・エンドポイントが `https:` でない・JSON でない → `login_unavailable`）、動的登録の本文（`client_name: "kumo CLI"`、`redirect_uris`、`grant_types`、`response_types`、`token_endpoint_auth_method: "none"`）、PKCE（`code_verifier` は 43 文字の base64url、`code_challenge` は SHA-256 の base64url、チャレンジの先頭が英数字になるまで作り直す）、`state` は 32 バイトの乱数の base64url、認可の URL の項目（`scope` を付けない、`resource` はメタデータの値のまま）、交換の本文（`redirect_uri`・`code_verifier`・`resource`）、トークンの要求が転送に従わないこと、エラーの応答から `error` と `error_description` だけを取り出すこと
- [ ] T009 [P] [US1] `apps/cli/test/loopback.test.ts` を書く（research L6）: `127.0.0.1` の空いているポートで待つ、`GET /callback` で `state` が一致する `code` を受け取ると完了のページ（`Cache-Control: no-store`、`default-src 'none'` の CSP）を返して閉じる、`state` の不一致は 400 のページを返して待ち続ける、`error` は `login_denied`、ほかのパスは 404、`Host` が `127.0.0.1:<port>` でなければ拒否、時間切れは `login_timeout`（上限を差し替えて短くする）、待ち受けに失敗したら `callback_unavailable`（待ち受けの関数を差し替えて失敗させる）
- [ ] T010 [P] [US1] `apps/cli/test/login.test.ts` を書く（contracts/cli.md の `kumo login`）: 設定のない一時フォルダーで、開く関数を「認可の URL に `fetch` して転送先までたどる」関数に替えて成功し、`login.json` に `adminUrl`・`resource`・`endpoints`・`client`・`session` ができ、`config.json` は作られない、`ログインしました` と使用量、`--json` の形、認可の URL が標準エラー出力に出る、`--no-open` では開く関数を呼ばない、開く関数が失敗しても待ち続ける、2 回目のログインで登録し直さない（登録の回数が 1）・前のリフレッシュトークンを取り消す、別の `adminUrl` では登録し直す、`invalid_client` で 1 回だけ登録し直す、前の `session` がないときは登録の直後に保存し、あるときは交換の後に新しい `session` とまとめて保存する（時間切れでも前の `session` と `client` の組が崩れない）、メタデータが取れないときの `login_unavailable` の案内（サービストークンで使い続けられること、手順書）、壊れた `login.json` を無視して作り直す、時間切れ・`error` では `session` を書かない（登録は残る）、URL の検証（`https:` でない・パスがある → `invalid_argument`、終了コード 2）、URL を省略したときの探す順（`KUMODANA_ADMIN_URL` → `login.json` → `config.json`）、環境変数のサービストークン・`KUMODANA_ADMIN_URL` の食い違い・`config.json` のサービストークンについての警告、すべての出力（`--json` を含む）とエラーにアクセストークン・リフレッシュトークン・認可コードが現れない

### Implementation for User Story 1

- [ ] T011 [P] [US1] `apps/cli/src/oauth.ts` に、探索、動的登録、PKCE と `state`、認可の URL、コードの交換、取り消し（RFC 7009。前の許可の取り消しと `kumo logout` が使う）を実装する（research L4〜L6・L8・L12。`fetch` を差し替え可能にし、トークンの要求は `redirect: "error"`）
- [ ] T012 [P] [US1] `apps/cli/src/loopback.ts` に受け取りの待ち受けを実装する（research L6。時間切れの上限を差し替え可能にする）
- [ ] T013 [P] [US1] `apps/cli/src/browser.ts` に `openUrl` を実装する（research L7。Windows は `rundll32.exe url.dll,FileProtocolHandler <url>`、macOS は `open`、それ以外は `xdg-open`。`spawn` でシェルを通さない）
- [ ] T014 [US1] `apps/cli/src/commands/login.ts` に `kumo login [<adminUrl>] [--no-open]` を実装する（contracts/cli.md の手順 1〜9。登録の保存の時期は research L5、前の許可は新しいトークンの保存後に取り消し、最後に新しいトークンで `GET /api/usage`。開く関数と時間切れの上限は差し替え可能にする）
- [ ] T015 [US1] `apps/cli/src/commands/index.ts` に `registerLogin` を加える（`usage` の後）

**Checkpoint**: 新しい環境で `kumo login` だけで管理操作が使える（アクセストークンの期限内）

---

## Phase 4: User Story 2 - ログインしたまま、ブラウザを開かずに使い続ける (Priority: P2)（#7）

**Goal**: アクセストークンを自動で更新し、期限切れや取り消しでは「`kumo login` を実行してください」と案内する

**Independent Test**: 期限切れのアクセストークンを持つ `login.json` で管理操作が成功し、`login.json` が更新される。許可を取り消すと `login_required` になる

### Tests for User Story 2 ⚠️

- [ ] T016 [P] [US2] `apps/cli/test/api.test.ts` にログインの経路のテストを足す（research L8・L11、contracts/cli.md の「エラーの案内の変更」）: `Authorization: Bearer` と `X-Kumodana-Client: cli` を送り、サービストークンのヘッダーを送らない、期限まで 60 秒を切っていたら要求の前に更新する、401（`WWW-Authenticate: Bearer`、本文が JSON でない）と Worker の `unauthenticated` では 1 回だけ更新してやり直す（2 回目の 401 は `login_required`、終了コード 1）、JSON の本文の要求もやり直せる、更新の `invalid_grant` では `login.json` を読み直し、別のリフレッシュトークンがあれば 1 回だけやり直す、同じなら `login_required`、Access のログイン画面への 302 は `login_required`、403 `forbidden` は所有者のアカウントを確かめる案内。既存のサービストークンの期待（`access_login_required`、`access_denied`、`AUTH_HINT`）は変えない
- [ ] T017 [P] [US2] `apps/cli/test/credentials.test.ts` に更新と保存のテストを足す: 更新した `refresh_token`・`accessTokenExpiresAt`（受け取った時刻 ＋ `expires_in`）・`refreshedAt` を保存し、`loggedInAt` は変えない、応答に `refresh_token` がなければ前のものを使い続ける、保存に失敗したら `警告: ログインの記録を保存できませんでした` を出して操作は成功する、2 つの更新を同時に行っても両方成功し `login.json` が JSON として読める、更新したトークンも `out.secrets` に加わる
- [ ] T018 [P] [US2] `apps/cli/test/login.test.ts` に、ログインの経路で `kumo usage`・`kumo ls`・`kumo put` を `--json` 付きと無しで実行し、更新をまたいでもトークンがどの出力にも現れないことを確かめるテストを書く（SC-004）

### Implementation for User Story 2

- [ ] T019 [US2] `apps/cli/src/oauth.ts` に更新（`grant_type=refresh_token`、`client_id`、`resource`）を実装する
- [ ] T020 [US2] `apps/cli/src/credentials.ts` のログインの方法に、期限前の更新、401 での更新、`invalid_grant` での読み直し、保存（`login-store.ts`）、隠す値の追加を実装する（research L8）
- [ ] T021 [US2] `apps/cli/src/api.ts` で 401 のときに 1 回だけ更新してやり直し、`toApiError` の案内を方法で出し分ける（research L11）。`login_required` と `admin_url_mismatch` を加える

**Checkpoint**: 許可の期間内は、ブラウザを開かずに管理操作を続けられる

---

## Phase 5: User Story 3 - ログアウトして、この PC の許可を無効にする (Priority: P3)（#8）

**Goal**: `kumo logout` で許可を取り消し、`login.json` の資格情報を消す

**Independent Test**: ログインした状態でログアウトすると取り消しの要求が届き、`session` が `null` になり、同じトークンでの管理操作が `login_required` になる

### Tests for User Story 3 ⚠️

- [ ] T022 [P] [US3] `apps/cli/test/logout.test.ts` を書く（contracts/cli.md の `kumo logout`）: 取り消しの本文（`token`、`token_type_hint=refresh_token`、`client_id`）、成功で `session` が `null` になり `adminUrl`・`endpoints`・`client` が残る、取り消した後の管理操作は `login_required`、取り消しの失敗（通信の失敗、エラーの応答）でも `session` を消して `revoke_failed`（終了コード 1、取り消す方法の案内）、環境変数のサービストークンがあれば警告、`config.json` のサービストークンがあれば知らせる、ログインしていなければ `ログインしていません` で終了コード 0、壊れた `login.json` は `login_invalid`（終了コード 2）、`--json` の形、出力にトークンが現れない

### Implementation for User Story 3

- [ ] T023 [US3] `apps/cli/src/commands/logout.ts` に `kumo logout` を実装する（research L12。取り消しは T011 の `oauth.ts` を使う。成否にかかわらず `clearSession`）
- [ ] T024 [US3] `apps/cli/src/commands/index.ts` に `registerLogout` を加える（`login` の後）

**Checkpoint**: ログアウトで、この PC の許可がすぐ使えなくなる

---

## Phase 6: User Story 4 - ログインの状態を確かめる (Priority: P4)（#6）

**Goal**: `kumo login --status` で、使われる方法とログインの状態を、通信せずに表示する

**Independent Test**: 4 つの方法（ログイン、環境変数、`config.json`、なし）で表示が正しく、`fetch` が一度も呼ばれない

### Tests for User Story 4 ⚠️

- [ ] T025 [P] [US4] `apps/cli/test/login.test.ts` に `--status` のテストを書く（contracts/cli.md の `kumo login --status`）: 4 つの方法の表示と `--json` の `method`・`adminUrl`・`login`・`notes`、方法がログインでないときの「使われていない記録」、`config.json` と `login.json` の `adminUrl` の食い違いの知らせ、`fetch` を呼ばない、終了コード 0（壊れた `login.json` だけ `login_invalid`、終了コード 2）、`<adminUrl>` や `--no-open` と同時に使うと `invalid_argument`（終了コード 2）、トークンが現れない

### Implementation for User Story 4

- [ ] T026 [US4] `apps/cli/src/commands/login.ts` に `--status` を実装する（`resolveCredentials` と `readLogin` だけを使う。日時はローカル時刻、`--json` は ISO 8601）

**Checkpoint**: すべてのストーリーが独立に動く

---

## Phase 7: Polish & Cross-Cutting Concerns（実装の PR、#6〜#8）

- [ ] T027 [P] `apps/cli/src/main.ts` の説明文と、`kumo login`・`kumo logout` のヘルプの文を整える
- [ ] T028 [P] `specs/001-share-shelf-mvp/contracts/cli.md`（「設定」）、`specs/001-share-shelf-mvp/contracts/admin-api.md`（「認証（2 段）」）、`specs/001-share-shelf-mvp/research.md`（R3）に、003 で経路を加えたことを日付付きで注記する
- [ ] T029 `npm run typecheck` と `npm test` を実行し、すべて成功することを確かめる
- [ ] T030 `git diff --stat main -- apps/admin apps/files packages/shared` が空で、`apps/cli/package.json` の依存が変わっていないことを確かめる（FR-022、憲法 VII）
- [ ] T031 Windows で、`&` を含む 500 文字程度の URL が `openUrl` で既定のブラウザにそのまま渡ることを確かめる（research L7 の実装時の確認事項。偽のサーバーの URL を使う）
- [ ] T032 （所有者が実施）本番での quickstart §2（US1〜US4、既存の経路）を PR の確認時に行う。#4 から移した確認（アクセストークンの期限切れの応答、許可の期間切れの応答と期間の起点、ほかの PC の許可に影響しないこと、古いリフレッシュトークンでの取り消し）の結果を、PR と #3 に記録する（research L2 の未確認）

---

## Phase 8: 運用（#9。実装の PR のマージ後）

**Purpose**: Access の最終的な設定、手順書と README の更新、本番での確認の記録（憲法の「Cloudflare 側の設定は手順書に残す」）

- [ ] T033 （所有者が実施）ダッシュボードの `kumodana-admin` の Advanced settings で、Managed OAuth のアクセストークンの有効期間を 15 分（既定）、グラントセッション期間を 1 週間（選択肢になければ 1 週間以下でいちばん長い値）にして保存する（research L3）。その後 `cf zero-trust access applications get <app-id>` で `oauth_configuration` を確かめ、実際に入った値を控える
- [ ] T034 `docs/runbook.md` §6 に Managed OAuth の設定（値とその理由、ダッシュボードの手順、`cf zero-trust access applications update --body` の手順と PUT で全体を送る注意、ダッシュボードで選択肢にない値は空欄と表示され保存し直すと変わるおそれ）を加える
- [ ] T035 `docs/runbook.md` §7 を `npm install -g ./apps/cli` → `kumo login <adminUrl>` → `kumo usage` の流れに書き直す。`kumo login --status`、許可の期限が切れたとき（`kumo login`）、PC をなくしたとき（`cf zero-trust access applications revoke-tokens <app-id>` はアプリのすべての許可を、`cf zero-trust access users revoke --email <owner>` は所有者のすべてのセッションを消す。どちらもサービストークンには影響しない。ダッシュボードには「Revoke existing tokens」が見当たらない）を書く。環境変数のサービストークンの説明は #10 の結論に合わせる（まだ決まっていなければ、今の位置づけ（予備）で書き、#10 で直す）
- [ ] T036 `docs/runbook.md` §3・§7・§10 のサービストークンの記述の食い違い（シークレットの保管方針、`refresh` と `rotate`）を、ログインが主でサービストークンは予備という位置づけに合わせて直す
- [ ] T037 [P] `README.md` の「使い方」に `kumo login`、`kumo login --status`、`kumo logout` を加え、初期設定の参照先を更新する
- [ ] T038 本番での確認の結果（T032 と、T033 の設定後の 15 分・1 週間での動き）を `docs/runbook.md` の検証の記録に残す（個人を特定できる値は書かない）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし
- **Foundational (Phase 2)**: Setup の後。すべてのストーリーの前提（`login.json`、資格情報の選択、`AdminApi` の方法）
- **User Stories (Phase 3〜6)**: Foundational の後
- **Polish (Phase 7)**: Phase 3〜6 の後。ここまでが実装の PR（#6〜#8）
- **運用 (Phase 8)**: 実装の PR のマージ後（#9）。T033 は所有者が行い、T034〜T038 はその値を使う

### User Story Dependencies

- **US1 (P1)**: Foundational の後。ほかのストーリーに依存しない（アクセストークンの期限内なら管理操作も使える）
- **US2 (P2)**: Foundational の後。テストで `login.json` を直接作れば US1 なしで確かめられる。実際の流れは US1 で作った記録を使う
- **US3 (P3)**: Foundational と、US1 の `oauth.ts` の取り消し（T011）の後
- **US4 (P4)**: Foundational（`resolveCredentials`、`readLogin`）と、US1 の `commands/login.ts` の後

### Within Each User Story

- テストを先に書き、失敗を確かめてから実装する
- 部品（`oauth.ts`・`loopback.ts`・`browser.ts`・`credentials.ts`）→ コマンド（`commands/login.ts`・`commands/logout.ts`）の順

### Parallel Opportunities

- T003 と T005 はファイルが違うので並行できる（T004・T006・T007 は順に）
- T008・T009・T010、T011・T012・T013 はそれぞれ並行できる
- T016・T017・T018 は並行できる
- Polish の T027・T028 は並行できる。Phase 8 の T037 は T034〜T036 と並行できる

---

## Parallel Example: User Story 1

```bash
# テストを並行して書く
Task: "oauth.ts のテストを apps/cli/test/oauth.test.ts に書く"
Task: "受け取りのテストを apps/cli/test/loopback.test.ts に書く"
Task: "kumo login のテストを apps/cli/test/login.test.ts に書く"

# 部品を並行して作ってから、コマンドにつなぐ
Task: "apps/cli/src/oauth.ts に探索・登録・PKCE・交換を実装する"
Task: "apps/cli/src/loopback.ts に受け取りを実装する"
Task: "apps/cli/src/browser.ts に openUrl を実装する"
Task: "apps/cli/src/commands/login.ts に kumo login を実装する"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1（偽の認可サーバー）と Phase 2（保存・選択・`AdminApi`）を終える
2. Phase 3（US1）で `kumo login` を作る
3. **STOP and VALIDATE**: 偽の認可サーバーでのログインと、既存のテストがすべて通ることを確かめる

### Incremental Delivery

1. US1: ブラウザでログインして使い始められる（MVP）
2. US2: 期限をまたいで使い続けられ、切れたら案内される
3. US3: ログアウトで許可を手放せる
4. US4: どの資格情報が使われるか確かめられる
5. どの段階でも、サービストークンの経路は変わらない。Managed OAuth が使えなくなっても、サービストークンで使い続けられる

---

## Notes

- [P] tasks = different files, no dependencies
- 意味のまとまりごとに commit する（テストの道具、保存と選択、ログイン、更新、ログアウト、状態の表示、文書）
- 完了したタスクは `[X]` にする
- #10（CLI 用サービストークンを残すか廃止するか）は、この tasks の範囲外。#9 の後に決める
