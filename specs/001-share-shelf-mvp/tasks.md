---

description: "Task list for 001-share-shelf-mvp"
---

# Tasks: 共有棚 MVP（画像と HTML をリンクで共有する）

**Input**: Design documents from `/specs/001-share-shelf-mvp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 憲法 VI により、認証と認可、CSRF、容量の上限、リンクの解決と取り消し、配信ヘッダーのテストは必須。
各ストーリーで、テストを先に書いて失敗を確認してから実装する。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1〜US4)
- パスはリポジトリのルートからの相対パス（plan.md の Project Structure に従う）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: モノレポと 4 つのワークスペースの初期化

- [ ] T001 Create root `package.json`（`"private": true`、`"type": "module"`、`"workspaces": ["packages/*", "apps/*"]`、全ワークスペースを実行する `typecheck` と `test` スクリプト）and `tsconfig.base.json`（`strict`、`module: "preserve"`、`moduleResolution: "bundler"`、`allowImportingTsExtensions`、`verbatimModuleSyntax`、`erasableSyntaxOnly`、`noEmit`）at repository root
- [ ] T002 Create `.npmrc`（`save-exact=true`、`min-release-age=7`）and `.gitignore`（`node_modules/`、`.cloudflare/`、`.env`、`.dev.vars*`、`.secrets.*.json`、`coverage/`）at repository root
- [ ] T003 [P] Create shared package `packages/shared/package.json`（name `@kumodana/shared`、`"type": "module"`、`exports` で `./src/*.ts` を公開）and `packages/shared/tsconfig.json`
- [ ] T004 [P] Create delivery Worker project `apps/files/package.json`（devDependencies: `cf`、`vite`、`@cloudflare/vite-plugin`、`typescript`、`vitest`、`@cloudflare/vitest-plugin`、`@kumodana/shared`）, `apps/files/vite.config.ts`（`cloudflare()` プラグイン）, `apps/files/tsconfig.json`（include: `src`、`test`、`cloudflare.config.ts`、`.cloudflare/types`）
- [ ] T005 [P] Create admin Worker project `apps/admin/package.json`（dependencies: `hono`、`zod`、`jose`、`@kumodana/shared`; devDependencies は T004 と同じ）, `apps/admin/vite.config.ts`, `apps/admin/tsconfig.json`
- [ ] T006 [P] Create CLI project `apps/cli/package.json`（name `kumodana-cli`、`"bin": { "kumo": "./bin/kumo.js" }`、dependencies: `commander`、`exiftool-vendored`、`@kumodana/shared`; devDependencies: `typescript`、`vitest`）, `apps/cli/bin/kumo.js`（`#!/usr/bin/env node` で `../src/main.ts` を import）, `apps/cli/tsconfig.json`
- [ ] T007 Run `npm install` at repository root so every package resolves to the newest version published 7+ days ago and is pinned exactly; commit `package-lock.json`; confirm `npx cf --version` works in `apps/admin`
- [ ] T008 [P] Configure Vitest: `apps/admin/vitest.config.ts` and `apps/files/vitest.config.ts`（`cloudflareTest({ experimental: { newConfig: true } })`、mode `test`、setup ファイルを指定）, `apps/cli/vitest.config.ts` and `packages/shared/vitest.config.ts`（Node 環境）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: すべてのストーリーが前提にするスキーマ、共有の型、2 つの Worker の骨組み、認証、CSRF 対策、CLI の土台

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### スキーマと共有パッケージ

- [ ] T009 Create D1 migration `apps/admin/migrations/0001_init.sql` per data-model.md: `files`（`id TEXT PRIMARY KEY`、`r2_key TEXT NOT NULL UNIQUE`、`name TEXT NOT NULL`（1〜255 文字）、`content_type TEXT NOT NULL`、`size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 99999999)`、`sha256 TEXT NOT NULL UNIQUE`、`status TEXT NOT NULL CHECK (status IN ('pending','ready'))`、`created_at INTEGER NOT NULL`）、`file_tags`（PK `(file_id, tag)`、`file_id` FK ON DELETE CASCADE、`tag` 1〜64 文字）、`albums`（`name TEXT NOT NULL UNIQUE COLLATE NOCASE`、1〜100 文字）、`album_files`（PK `(album_id, file_id)`、両 FK ON DELETE CASCADE、`position INTEGER NOT NULL`）、`links`（`token TEXT PRIMARY KEY`（22 文字）、`file_id` FK ON DELETE CASCADE、`label TEXT` NULL 可 0〜200 文字、`created_at INTEGER NOT NULL`、`revoked_at INTEGER` NULL 可）and indexes `files(status, created_at)`、`files(created_at)`、`file_tags(tag)`、`album_files(album_id, position)`、`links(file_id)`
- [ ] T010 [P] Implement API types in `packages/shared/src/api-types.ts`: `FileSummary`、`Link`、`Usage`、`PurgeResult`、`ErrorBody`, and the `ErrorCode` union listing every code in contracts/admin-api.md
- [ ] T011 [P] Implement limits in `packages/shared/src/limits.ts`: `ALLOWED_CONTENT_TYPES`（`image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/avif`、`image/svg+xml`、`text/html`、`text/html; charset=utf-8`）、`MAX_FILE_BYTES = 99_999_999`
- [ ] T012 [P] Implement IDs in `packages/shared/src/ids.ts` using `crypto.getRandomValues`: file/album ID = 10-char lowercase Crockford Base32（50 bits、`^[0-9a-hjkmnp-tv-z]{10}$`）、link token = 16 random bytes as 22-char Base64URL（`^[A-Za-z0-9_-]{22}$`）, with validators
- [ ] T013 [P] Implement name rules in `packages/shared/src/names.ts`: tag = NFC → trim → lowercase, 1〜64 chars, reject control characters and commas; album name = trim, 1〜100 chars
- [ ] T014 [P] Unit tests in `packages/shared/test/ids.test.ts` and `packages/shared/test/names.test.ts`

### 配信用 Worker の骨組み

- [ ] T015 Create `apps/files/cloudflare.config.ts`: name `kumo`、`workersDev: mode !== "stopped"`（緊急停止用モード）、`previewUrls: false`、`cache: { enabled: true }`、bindings `DB`（d1 `kumodana`）and `BUCKET`（r2 `kumodana`）
- [ ] T016 [P] Implement `apps/files/src/headers.ts`: headers for all responses（`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow, noarchive`）and 200-only cache headers exactly as contracts/delivery.md
- [ ] T017 Implement skeleton `apps/files/src/index.ts`: default export class extending `WorkerEntrypoint`; `fetch` returns `404 Not Found` with common headers and `Cache-Control: no-store`, and `405` with `Allow: GET, HEAD` for other methods

### 管理用 Worker の骨組みと保護

- [ ] T018 Create `apps/admin/cloudflare.config.ts`: name `kumodana-admin`、`workersDev: true`、`previewUrls: false`; bindings `DB`、`BUCKET`、`FILES`（`bindings.worker({ worker: "kumo" })`、mode `test` では省略）、`FILES_BASE_URL`（text `https://kumo.meshnode.workers.dev`）、`STORAGE_LIMIT_BYTES`（text `"8000000000"`、mode `test` では `"1000"`）、`OWNER_EMAIL`・`CLI_CLIENT_ID`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`（`bindings.secret()`、mode `test` では固定のテスト値の `bindings.text()`）
- [ ] T019 [P] Implement `apps/admin/src/errors.ts`: error response `{ error: { code, message, details } }` with Japanese messages and `Cache-Control: no-store`
- [ ] T020 Implement `apps/admin/src/auth.ts`: verify `Cf-Access-Jwt-Assertion` with jose `jwtVerify`（`algorithms: ["RS256"]`、issuer = `ACCESS_TEAM_DOMAIN`、audience = `ACCESS_AUD`）using an injectable key resolver（本番は `<team>/cdn-cgi/access/certs` の `createRemoteJWKSet` をアイソレートごとに再利用）; allow only `email === OWNER_EMAIL` or `common_name === CLI_CLIENT_ID`; `401 unauthenticated` / `403 forbidden`
- [ ] T021 [P] Implement `apps/admin/src/csrf.ts`: require `X-Kumodana-Client: cli`; reject when `Origin` is present or `Sec-Fetch-Site` is not `same-origin`/`none` → `403 cross_site_request`
- [ ] T022 Create Hono app factory `apps/admin/src/app.ts`（`createApp(deps)`: CSRF → 認証 → ルート、全応答に `Cache-Control: no-store`、未定義ルートは `404 not_found`、例外は `500 internal_error`）and entry `apps/admin/src/index.ts`（本番用の deps で `fetch` を公開、`scheduled` は空）
- [ ] T023 Create admin test helpers `apps/admin/test/helpers.ts`: RS256 key pair and local JWKS, `signAccessJwt({ email | common_name, aud, iss, exp })`, request helper that adds `X-Kumodana-Client` and the JWT, D1 reset helper
- [ ] T024 Create test setup applying `apps/admin/migrations` to D1 in `apps/admin/test/setup.ts` and `apps/files/test/setup.ts`（`readD1Migrations`/`applyD1Migrations` を使う。`newConfig` と併用できない場合は SQL ファイルを読み込んで `DB.exec` する）
- [ ] T025 [P] Auth tests in `apps/admin/test/auth.test.ts`: no JWT → 401, bad signature → 401, wrong `aud` → 401, wrong `iss` → 401, expired → 401, other email → 403, owner email → OK, CLI `common_name` → OK
- [ ] T026 [P] CSRF tests in `apps/admin/test/csrf.test.ts`: missing `X-Kumodana-Client` → 403, `Origin` present → 403, `Sec-Fetch-Site: cross-site` / `same-site` → 403, `Sec-Fetch-Site: none` → OK

### CLI の土台

- [ ] T027 [P] Implement `apps/cli/src/config.ts`: env `KUMODANA_ADMIN_URL`・`KUMODANA_CLIENT_ID`・`KUMODANA_CLIENT_SECRET` override the file `%APPDATA%\kumodana\config.json`（Windows）or `$XDG_CONFIG_HOME/kumodana/config.json`（未設定なら `~/.config/kumodana/config.json`）; missing keys produce an error naming the keys, never the secret
- [ ] T028 [P] Implement `apps/cli/src/output.ts`: human output to stdout, warnings/errors to stderr, `--json` mode, exit codes `0`/`1`/`2`, error format「何が起きたか＋どうすればよいか＋エラーコード」, secret redaction
- [ ] T029 Implement `apps/cli/src/api.ts`: `fetch` client adding `CF-Access-Client-Id`、`CF-Access-Client-Secret`、`X-Kumodana-Client: cli`; parse error bodies into a typed `ApiError`; network errors mention proxy settings（`NODE_USE_ENV_PROXY`、`HTTPS_PROXY`）
- [ ] T030 Implement `apps/cli/src/main.ts`（commander の `kumo` プログラム、全体オプション `--json`、`--version`）and verify on Windows that `npm install -g ./apps/cli` makes `kumo --version` run via Node type stripping, including imports of `@kumodana/shared`（research R16）
- [ ] T031 [P] CLI tests in `apps/cli/test/config.test.ts` and `apps/cli/test/output.test.ts`: env precedence, missing-key message, the secret never appears in any output

**Checkpoint**: 型検査とテストが通り、認証・CSRF が機能する。ここからストーリーに着手できる

---

## Phase 3: User Story 1 - ファイルを置いてリンクで共有する (Priority: P1) 🎯 MVP

**Goal**: 画像や HTML を 1 コマンドで置き、リンクを発行し、閲覧者がログインなしで見られる。EXIF は既定で削除

**Independent Test**: 画像 1 枚と HTML 1 枚を `kumo put --link` で置き、ログインしていないブラウザで開けること、
画像に位置情報がないこと、原本が変わらないことを確認する

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T032 [P] [US1] Upload API tests in `apps/admin/test/upload.test.ts`: 201 on create; 200 `duplicate: true` for an existing `ready` file with the same SHA-256（本文を保存しない）; 409 `upload_in_progress` for a `pending` duplicate; 415 `unsupported_type` with `allowed`; 411 `length_required`; 413 `file_too_large` for `Content-Length` ≥ 100000000; 400 `invalid_request` for a bad SHA-256 or filename; 422 `checksum_mismatch` leaves no row; 413 `quota_exceeded` when the limit is exceeded
- [ ] T033 [P] [US1] Link creation and owner retrieval tests in `apps/admin/test/links-create.test.ts`（201、22 文字のトークン、`url` は `FILES_BASE_URL` 基準、`label` は 0〜200 文字、存在しない・`pending` のファイルは 404）and `apps/admin/test/content.test.ts`（内容と `Content-Disposition: attachment; filename*=UTF-8''...`）
- [ ] T034 [P] [US1] Delivery tests in `apps/files/test/delivery.test.ts`: 200 with body and every header in contracts/delivery.md; `HEAD` without body; identical 404 for unknown, revoked, `pending`, and deleted; 404 for `/` and extra path segments; 405 for `POST`
- [ ] T035 [P] [US1] Sniffing tests in `apps/cli/test/sniff.test.ts`: each allowed format, HEIC rejected with its own message, MP4/ZIP rejected, HTML charset rule（research R10）
- [ ] T036 [P] [US1] EXIF tests in `apps/cli/test/exif.test.ts` with fixture `apps/cli/test/fixtures/gps-rotated.jpg`: GPS removed, `Orientation` and `ICC_Profile` kept, original bytes and mtime unchanged, `--keep-exif` keeps GPS
- [ ] T037 [P] [US1] CLI tests against a local HTTP mock in `apps/cli/test/put.test.ts`: size pre-check（≥100MB を送信前に拒否）, duplicate pre-check, output of ID and URL, exit code `1` on partial failure; `get` refuses to overwrite an existing file

### Implementation for User Story 1

- [ ] T038 [US1] Implement file queries in `apps/admin/src/db/files.ts`: `insertPendingWithinQuota`（1 文の `INSERT ... SELECT ... WHERE (SELECT COALESCE(SUM(size), 0) FROM files) + ? <= ?`、`meta.changes = 0` は上限超過、`sha256` の一意制約違反は重複）、`markReady`、`deleteRow`、`findBySha256`、`getFileSummary`（タグ、アルバム、有効なリンク数を含む）
- [ ] T039 [US1] Implement `PUT /api/files` in `apps/admin/src/routes/files.ts` per contracts/admin-api.md: validate headers（`Content-Type` は許可リスト、`Content-Length` は 1〜99999999、`X-Kumodana-Sha256` は小文字 16 進 64 文字、`X-Kumodana-Filename` はデコード後 1〜255 文字でパスを含まない）→ duplicate check（`ready` は本文を読まずに 200、`pending` は 409）→ `insertPendingWithinQuota` → `BUCKET.put("files/<id>", request.body, { sha256, httpMetadata: { contentType } })` → 失敗時は行を削除して 422/502 → `markReady` → 201
- [ ] T040 [US1] Implement `GET /api/files?sha256=` (exact match) and `GET /api/files/:id/content` in `apps/admin/src/routes/files.ts`
- [ ] T041 [US1] Implement link creation: `createLink(fileId, label)` in `apps/admin/src/db/links.ts`（トークンは `@kumodana/shared` の ids）and `POST /api/files/:id/links` in `apps/admin/src/routes/links.ts`（`label` は 0〜200 文字、`ready` のファイルのみ）
- [ ] T042 [US1] Implement delivery in `apps/files/src/index.ts`: token pattern `^[A-Za-z0-9_-]{22}$`; one D1 query joining `links` and `files` with `revoked_at IS NULL AND status = 'ready'`; stream the R2 object with `Content-Type`、`Content-Length`、`ETag: "<sha256>"`、`Content-Disposition: inline; filename*=UTF-8''...`、`Cache-Control: public, max-age=60`、`Cloudflare-CDN-Cache-Control: public, max-age=86400`、`Cache-Tag: l:<token>,f:<fileId>`; `HEAD` without body; missing R2 object → 404
- [ ] T043 [P] [US1] Implement `apps/cli/src/sniff.ts` per research R10（マジックバイト、HEIC の判別、SVG/HTML のテキスト判定、HTML の charset）
- [ ] T044 [P] [US1] Implement `apps/cli/src/exif.ts`: copy to a temp file under `os.tmpdir()`, run exiftool-vendored `deleteAllTags` retaining `Orientation` and `ICC_Profile`, delete the temp file afterwards, call `exiftool.end()` on exit
- [ ] T045 [US1] Implement `kumo put <path...> [--link] [--label] [--keep-exif]` in `apps/cli/src/commands/put.ts` per contracts/cli.md steps 1〜6（タグとアルバム以外）: SHA-256 with `node:crypto`, read into a Buffer so `Content-Length` is fixed, continue on per-file failure and exit `1`
- [ ] T046 [P] [US1] Implement `kumo get <id> [--output <path>]` in `apps/cli/src/commands/get.ts`（既存ファイルは上書きしない）
- [ ] T047 [P] [US1] Implement `kumo link create <id> [--label <text>]` in `apps/cli/src/commands/link.ts`

**Checkpoint**: US1 単独で、置く・リンクを発行する・閲覧する・取り出すが動く

---

## Phase 4: User Story 2 - リンクを管理し、取り消す (Priority: P2)

**Goal**: 相手ごとにリンクを発行・一覧し、取り消すとエッジのキャッシュも含めて見られなくなる

**Independent Test**: 1 つのファイルに 2 本のリンクを発行し、1 本だけ取り消して、取り消した方は 1 分以内に
「見つからない」、もう一方は表示されることを確認する

### Tests for User Story 2 ⚠️

- [ ] T048 [P] [US2] Purge RPC tests in `apps/files/test/purge.test.ts`: tags other than `l:<token>`/`f:<fileId>` → `invalid_tag`; more than 100 tags → `invalid_tag`; `ctx.cache` undefined → `cache_unavailable`; fake `ctx.cache.purge` success and failure mapped to `PurgeResult`
- [ ] T049 [P] [US2] Redirect test in `apps/files/test/redirect.test.ts`: `/<token>?fbclid=x` → 301 with `Location: /<token>` and `Cache-Control: no-store`, without file content
- [ ] T050 [P] [US2] Revoke and list tests in `apps/admin/test/links-revoke.test.ts`: revoke sets `revoked_at`; purge is called with `l:<token>`; purge failure → 200 with `purge.ok = false` and the revoke recorded; revoking again only retries the purge; `GET /api/links` filters by `fileId` and `includeRevoked`, newest first; unknown token → 404
- [ ] T051 [P] [US2] CLI link tests in `apps/cli/test/link.test.ts`: token extraction from a URL, `ls --all`, `revoke` exits `1` with a retry hint when purge fails

### Implementation for User Story 2

- [ ] T052 [US2] Implement RPC `purge(tags)` in `apps/files/src/index.ts` per contracts/files-rpc.md（`this.ctx.cache.purge({ tags })`、例外を投げずに `PurgeResult` を返す）
- [ ] T053 [US2] Implement the query-string redirect in `apps/files/src/index.ts`（正規のパスへ 301、`no-store`）
- [ ] T054 [US2] Implement `apps/admin/src/purge.ts`: call `env.FILES.purge(tags)`; missing binding → `{ ok: false, error: "binding_unavailable" }`; catch exceptions; injectable for tests
- [ ] T055 [US2] Implement `DELETE /api/links/:token` and `GET /api/links` in `apps/admin/src/routes/links.ts` with queries `revokeLink` and `listLinks` in `apps/admin/src/db/links.ts`
- [ ] T056 [US2] Implement `kumo link ls [<id>] [--all]` and `kumo link revoke <token|url>` in `apps/cli/src/commands/link.ts`

**Checkpoint**: US1 と US2 が独立して動く

---

## Phase 5: User Story 3 - 保存量の上限を守る (Priority: P3)

**Goal**: 上限を超えるアップロードを理由付きで拒否し、使用量を確認でき、途中で失敗した分の容量が解放される

**Independent Test**: 上限 `1000` バイトのテスト環境で、超過の拒否、同時アップロードでも超えないこと、
処理中のまま残った分が片付くことを確認する

### Tests for User Story 3 ⚠️

- [ ] T057 [P] [US3] Quota tests in `apps/admin/test/quota.test.ts`（上限 `"1000"`）: exceeding → 413 with `details.usedBytes`、`details.limitBytes`、`details.requestedBytes`; `pending` files are counted; two concurrent uploads that together exceed the limit → exactly one succeeds
- [ ] T058 [P] [US3] Usage and cleanup tests in `apps/admin/test/usage.test.ts`（`GET /api/usage` の各値）and `apps/admin/test/cleanup.test.ts`（30 分を超えた `pending` は R2 のオブジェクトと行を削除、それ以外の `pending` と `ready` は残す）
- [ ] T059 [P] [US3] CLI usage test in `apps/cli/test/usage.test.ts`

### Implementation for User Story 3

- [ ] T060 [US3] Implement `getUsage()` in `apps/admin/src/db/usage.ts`（`SELECT COALESCE(SUM(size), 0), COUNT(*) FROM files`）and add quota `details` to the 413 response in `apps/admin/src/routes/files.ts`
- [ ] T061 [US3] Implement `GET /api/usage` in `apps/admin/src/routes/usage.ts`（`remainingBytes = max(0, limitBytes - usedBytes)`）
- [ ] T062 [US3] Implement `apps/admin/src/cleanup.ts`, wire it to `scheduled` in `apps/admin/src/index.ts`, and add `triggers.scheduled({ schedule: "*/15 * * * *" })` to `apps/admin/cloudflare.config.ts`
- [ ] T063 [US3] Implement `kumo usage` in `apps/cli/src/commands/usage.ts`

**Checkpoint**: US1〜US3 が独立して動く

---

## Phase 6: User Story 4 - 棚を整理する (Priority: P4)

**Goal**: 一覧、タグ、アルバム、削除で棚を整理できる

**Independent Test**: 複数のファイルにタグを付けてアルバムにまとめ、絞り込みの結果が正しいこと、
削除するとリンクが開けなくなり使用量が減ることを確認する

### Tests for User Story 4 ⚠️

- [ ] T064 [P] [US4] Listing tests in `apps/admin/test/list.test.ts`: newest first, `ready` only, filters by `tag` and `album`, cursor pagination, `limit` 1〜200（既定 50）, every `FileSummary` field, `GET /api/files/:id` includes revoked links
- [ ] T065 [P] [US4] Tag and album tests in `apps/admin/test/tags.test.ts` and `apps/admin/test/albums.test.ts`: tag normalization and `invalid_tag`; `album_exists` ignoring case; files appended in the given order with `position` = max + 1; re-adding does nothing; deleting an album keeps files and links
- [ ] T066 [P] [US4] Deletion tests in `apps/admin/test/delete.test.ts`: active links revoked; `f:<id>` purged only if the file ever had a link; R2 object removed; related rows cascade; usage decreases; purge failure → 502 `purge_failed` with links revoked and the file kept; retrying completes the deletion
- [ ] T067 [P] [US4] CLI tests in `apps/cli/test/organize.test.ts`: `ls` rendering, `+tag`/`-tag` parsing, album name → ID resolution, `rm` stops at a purge failure, `put --tag --album` creates a missing album and also applies to duplicates

### Implementation for User Story 4

- [ ] T068 [US4] Implement `listFiles`（タグ・アルバムでの絞り込み、`(created_at, id)` によるカーソル、`limit`）in `apps/admin/src/db/files.ts`, and `GET /api/files` with all filters plus `GET /api/files/:id` in `apps/admin/src/routes/files.ts`
- [ ] T069 [US4] Implement `apps/admin/src/db/tags.ts` and `PATCH /api/files/:id/tags` in `apps/admin/src/routes/tags.ts`（`add` と `remove` の合計 1〜50 件、`@kumodana/shared` の names で正規化）
- [ ] T070 [US4] Implement `apps/admin/src/db/albums.ts` and `apps/admin/src/routes/albums.ts`: `GET`/`POST /api/albums`, `DELETE /api/albums/:id`, `POST /api/albums/:id/files`（1〜100 件、指定順に末尾へ追加、既存は無視）, `DELETE /api/albums/:id/files/:fileId`
- [ ] T071 [US4] Implement `DELETE /api/files/:id` in `apps/admin/src/routes/files.ts` following the deletion order in data-model.md, using `apps/admin/src/purge.ts`（depends on T054）
- [ ] T072 [P] [US4] Implement `kumo ls [--tag] [--album] [--limit]` in `apps/cli/src/commands/ls.ts`
- [ ] T073 [P] [US4] Implement `kumo tag <id> <+tag|-tag>...` in `apps/cli/src/commands/tag.ts`
- [ ] T074 [P] [US4] Implement `kumo album ls|create|rm|add|remove` in `apps/cli/src/commands/album.ts`
- [ ] T075 [US4] Implement `kumo rm <id...>` in `apps/cli/src/commands/rm.ts`（キャッシュの削除に失敗したら止め、やり直しの方法を表示）
- [ ] T076 [US4] Add `--tag` and `--album` to `kumo put` in `apps/cli/src/commands/put.ts`（アルバムがなければ作成し、重複時も既存のファイルに適用）

**Checkpoint**: すべてのストーリーが独立して動く

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 運用の手順、デプロイ、全体の検証

- [ ] T077 [P] Write `docs/runbook.md`: create D1 `kumodana`（APAC）and R2 `kumodana` and record IDs in both `cloudflare.config.ts`; apply migrations; deploy order（`kumo` → `kumodana-admin`）; `.secrets.production.json` keys; Zero Trust setup; service token creation and renewal（`cf zero-trust access service-tokens create` / `refresh`、期限の記録）; Worker-level Access application（destination type `worker`、所有者のメールを許可＋サービストークンの Service Auth）; strict service token authentication; budget alert（$1）and R2 usage notification; emergency stop（`cf workers triggers deploy --mode stopped` と復旧）; `npx wrangler tail`
- [ ] T078 Add deploy scripts: `deploy` in `apps/files/package.json` and `apps/admin/package.json`（型検査 → テスト → `cf deploy --dry-run` → `cf deploy`、admin は `--secrets-file ../../.secrets.production.json`）and root `deploy` in `package.json`（`kumo` → `kumodana-admin` の順）
- [ ] T079 [P] Create `docs/verification/isolation-check.html` for SC-006: tries `fetch` to the admin API with `credentials: "include"`, `document.cookie` read/write, `localStorage`, and reading another link, and displays each result
- [ ] T080 [P] Write `README.md`: purpose, repository structure, CLI setup, links to quickstart.md and `docs/runbook.md`
- [ ] T081 Verify the open items in research.md（R9: `retain` で Orientation と ICC_Profile が残る、R15: `--mode stopped` で workers.dev の公開が止まる、R16: 型除去での実行）and record results in `docs/runbook.md`
- [ ] T082 Run `npm run typecheck` and `npm test` at repository root and fix all failures
- [ ] T083 Run the quickstart.md validation against production: SC-001（5MB の画像で 15 秒以内）, SC-003（取り消しから 1 分以内）, `cf-cache-status: HIT`, isolation page, emergency stop drill

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3〜6)**: Depend on Foundational. Sequential in priority order is recommended（1 人で開発するため）
- **Polish (Phase 7)**: Depends on all user stories. T077〜T080 can start once US1 is done

### User Story Dependencies

- **US1 (P1)**: Foundational のみに依存
- **US2 (P2)**: Foundational のみに依存（取り消しの対象となるリンクはテストのデータで用意できる）
- **US3 (P3)**: Foundational と、US1 のアップロード（T038、T039）に依存。上限付きの `INSERT` 自体は US1 で実装する
- **US4 (P4)**: Foundational と、US2 の `apps/admin/src/purge.ts`（T054）に依存（ファイル削除でキャッシュを消すため）

### Within Each User Story

- テストを先に書き、失敗を確認してから実装する
- DB のクエリ → ルート → CLI の順
- 同じファイルを編集するタスク（`apps/files/src/index.ts`、`apps/admin/src/routes/files.ts`、`apps/cli/src/commands/put.ts`、`apps/cli/src/commands/link.ts`）は並行させない

### Parallel Opportunities

- Setup: T003〜T006、T008
- Foundational: T010〜T014、T016、T019、T021、T025、T026、T027、T028、T031
- 各ストーリーのテストタスク（[P]）はすべて並行できる
- US1: T043、T044、T046、T047 は Worker 側の実装と並行できる
- US4: T072〜T074 は並行できる

---

## Parallel Example: User Story 1

```bash
# テストをまとめて書く
Task: "Upload API tests in apps/admin/test/upload.test.ts"
Task: "Delivery tests in apps/files/test/delivery.test.ts"
Task: "Sniffing tests in apps/cli/test/sniff.test.ts"
Task: "EXIF tests in apps/cli/test/exif.test.ts"

# Worker と CLI の部品を並行して実装する
Task: "Implement apps/cli/src/sniff.ts"
Task: "Implement apps/cli/src/exif.ts"
Task: "Implement delivery in apps/files/src/index.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1（Setup）と Phase 2（Foundational）を終える
2. Phase 3（US1）を終える
3. **STOP and VALIDATE**: US1 のテストと独立テストを確認する
4. デプロイする前に、T077（runbook）の初期設定と、予算アラート・緊急停止の手順を用意する（憲法 V）

### Incremental Delivery

1. Setup + Foundational → 土台の完成
2. US1 → 検証 → デプロイ（MVP）
3. US2 → 検証 → デプロイ（取り消し）
4. US3 → 検証 → デプロイ（使用量と後始末）
5. US4 → 検証 → デプロイ（整理）
6. Polish → quickstart.md の全体検証

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- 各タスクまたは論理的なまとまりごとにコミットする
- 依存パッケージは公開から 7 日以上経った版に完全固定する（憲法の技術・運用上の制約）
