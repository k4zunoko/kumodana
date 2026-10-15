# Contract: 管理 API（`kumodana-admin`）

**Base URL**: `https://kumodana-admin.meshnode.workers.dev`
**利用者**: `kumo` CLI のみ（MVP）。関連: [data-model.md](../data-model.md)

## 共通事項

### 認証（2 段）

1. **Access（Cloudflare の入口）**: CLI は `CF-Access-Client-Id` と `CF-Access-Client-Secret` を送る。Access は検証後に
   `Cf-Access-Jwt-Assertion` を付けて Worker に渡す。
2. **Worker**: `Cf-Access-Jwt-Assertion` を検証する。
   - 署名: チームドメインの `/cdn-cgi/access/certs` の公開鍵（RS256）
   - `iss` = チームドメイン、`aud` に AUD を含む、`exp`/`nbf` が有効
   - 主体: `email` が所有者のメールアドレス、または `common_name` が CLI のクライアント ID
   - ヘッダーがない・検証に失敗 → `401 unauthenticated`。主体が許可されていない → `403 forbidden`

### CSRF 対策

- すべての `/api/*` で `X-Kumodana-Client: cli` を必須にする。ない場合は `403 cross_site_request`。
- `Origin` ヘッダーがある、または `Sec-Fetch-Site` が `same-origin`・`none` 以外 → `403 cross_site_request`。
- CORS は許可しない（`Access-Control-*` を返さない）。

### 応答

- すべての応答に `Cache-Control: no-store` を付ける。
- 成功時の本文は JSON（`content` の取得を除く）。日時は ISO 8601（UTC）。
- エラー時の本文:

```json
{ "error": { "code": "quota_exceeded", "message": "保存量の上限を超えるため保存できません。", "details": {} } }
```

### 型

```ts
type FileSummary = {
  id: string; name: string; contentType: string; size: number; sha256: string;
  createdAt: string; tags: string[]; albums: { id: string; name: string }[];
  activeLinkCount: number;
};
type Link = {
  token: string; fileId: string; url: string; label: string | null;
  createdAt: string; revokedAt: string | null;
};
type PurgeResult = { ok: true } | { ok: false; error: string };
type Usage = { usedBytes: number; limitBytes: number; remainingBytes: number; fileCount: number };
```

`Link.url` は `FILES_BASE_URL` + `/` + `token`（例: `https://kumo.meshnode.workers.dev/<token>`）。

## エンドポイント

### `GET /api/usage`

- 200: `Usage`

### `PUT /api/files` — アップロード

- 本文: ファイルの内容そのもの（multipart ではない）
- 必須ヘッダー:
  - `Content-Type`: 許可された形式のいずれか（data-model 参照）
  - `Content-Length`: 1〜99999999
  - `X-Kumodana-Sha256`: 内容の SHA-256（小文字 16 進 64 文字）
  - `X-Kumodana-Filename`: 元のファイル名（UTF-8 をパーセントエンコード）
- 処理順: ヘッダー検証 → 同一内容の確認 → 上限付きで `pending` 作成 → R2 へ保存（`sha256` で検証） → `ready` に更新
- 応答:
  - 201 `{ "file": FileSummary, "duplicate": false }`
  - 200 `{ "file": FileSummary, "duplicate": true }` — 同じ内容が `ready` で存在（本文は保存しない）
  - 400 `invalid_request` — ヘッダーの形式が不正
  - 409 `upload_in_progress` — 同じ内容が `pending`
  - 411 `length_required` — `Content-Length` がない
  - 413 `file_too_large` — `Content-Length` が上限以上
  - 413 `quota_exceeded` — `details: { usedBytes, limitBytes, requestedBytes }`
  - 415 `unsupported_type` — `details: { allowed: string[] }`
  - 422 `checksum_mismatch` — R2 が内容の不一致を検出（行は削除済み）
  - 502 `storage_error` — R2 への保存に失敗（行は削除済み）

### `GET /api/files`

- クエリ: `tag`（1 つ）、`album`（アルバム ID）、`sha256`、`limit`（1〜200、既定 50）、`cursor`
- `ready` のファイルだけを新しい順で返す
- 200: `{ "files": FileSummary[], "nextCursor": string | null }`

### `GET /api/files/{id}`

- 200: `{ "file": FileSummary, "links": Link[] }`（取り消し済みのリンクも含む）
- 404 `not_found`

### `GET /api/files/{id}/content` — 所有者による取得

- 200: ファイルの内容。`Content-Type` は保存時の値、
  `Content-Disposition: attachment; filename*=UTF-8''<元のファイル名>`
- 404 `not_found`

### `DELETE /api/files/{id}`

- 処理順: 有効なリンクをすべて取り消す → リンクを発行したことがあれば配信用のキャッシュを削除（タグ `f:<id>`） →
  R2 から削除 → 行を削除
- 200: `{ "deleted": "<id>", "revokedLinks": number }`
- 404 `not_found`
- 502 `purge_failed` — `details: { error }`。リンクの取り消しは記録済み。同じ要求をやり直すと続きから処理する

### `PATCH /api/files/{id}/tags`

- 本文: `{ "add": string[], "remove": string[] }`（どちらか一方は省略可、合計 1〜50 件）
- 200: `{ "tags": string[] }`（正規化済み）
- 400 `invalid_tag`、404 `not_found`

### `GET /api/albums`

- 200: `{ "albums": { id, name, fileCount, createdAt }[] }`（名前順）

### `POST /api/albums`

- 本文: `{ "name": string }`
- 201: `{ "album": { id, name, fileCount, createdAt } }`
- 409 `album_exists`

### `DELETE /api/albums/{id}`

- アルバムと所属情報だけを削除する（ファイルとリンクは残る）
- 200: `{ "deleted": "<id>" }`、404 `not_found`

### `POST /api/albums/{id}/files`

- 本文: `{ "fileIds": string[] }`（1〜100 件、指定順に末尾へ追加。既に含まれるものは何もしない）
- 200: `{ "added": number }`、404 `not_found`（アルバムまたはファイル）

### `DELETE /api/albums/{id}/files/{fileId}`

- 200: `{ "removed": true }`、404 `not_found`

### `POST /api/files/{id}/links`

- 本文: `{ "label"?: string }`（0〜200 文字）
- 201: `{ "link": Link }`、404 `not_found`

### `GET /api/links`

- クエリ: `fileId`（任意）、`includeRevoked`（`true`/`false`、既定 `false`）
- 200: `{ "links": Link[] }`（新しい順）

### `DELETE /api/links/{token}` — 取り消し

- 処理順: `revoked_at` を記録（取り消し済みなら維持） → 配信用のキャッシュを削除（タグ `l:<token>`）
- 200: `{ "link": Link, "purge": PurgeResult }` — 削除に失敗しても取り消し自体は成功として 200 を返し、
  `purge.ok = false` で知らせる。同じ要求をやり直すと、キャッシュの削除だけをやり直す
- 404 `not_found`

## 定期実行（`scheduled`）

- 15 分ごと。`pending` のまま 30 分を超えたファイルについて、R2 のオブジェクト（あれば）と行を削除する。

## エラーコード一覧

`unauthenticated`、`forbidden`、`cross_site_request`、`invalid_request`、`not_found`、`length_required`、
`file_too_large`、`unsupported_type`、`quota_exceeded`、`upload_in_progress`、`checksum_mismatch`、
`storage_error`、`purge_failed`、`invalid_tag`、`album_exists`、`internal_error`
