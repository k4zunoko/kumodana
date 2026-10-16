# Contract: 管理 API（`kumodana-admin`）

**Base URL**: `https://kumodana-admin.meshnode.workers.dev`
**利用者**: kumo CLI のみ（MVP）。関連: [data-model.md](../data-model.md)

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

- すべての応答に `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、
  `Content-Security-Policy: sandbox` を付ける。
- 成功時の本文は JSON（`content` の取得を除く）。日時は ISO 8601（UTC）。
- エラー時の本文:

```json
{ "error": { "code": "quota_exceeded", "message": "保存量の上限を超えるため保存できません。", "details": {} } }
```

### 型

```ts
type FileSummary = {
  id: string; name: string; contentType: string; size: number; sha256: string;
  createdAt: string; tags: string[]; activeLinkCount: number;
};
type Link = {
  token: string; fileId: string; url: string; label: string | null;
  createdAt: string; revokedAt: string | null;
};
type PurgeResult = { ok: true } | { ok: false; error: string };
type Usage = { usedBytes: number; limitBytes: number; remainingBytes: number; fileCount: number };
type TagCount = { tag: string; fileCount: number };
```

- `Link.url` は `FILES_BASE_URL` + `/` + `token`（例: `https://kumo.meshnode.workers.dev/<token>`）。
- `ready` 以外のファイルは、どのエンドポイントでも「存在しない」として扱う（削除のやり直しを除く）。

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
- 処理順: ヘッダー検証 → 同じ内容の確認（下記） → 上限付きで `pending` を作成 → R2 へ保存（`sha256` で検証） →
  `ready` に更新
- 同じ内容の確認:
  - `ready` がある → 本文を読まずに 200（`duplicate: true`）
  - `pending` があり、更新から 10 分以内 → 409 `upload_in_progress`（`details: { retryAfterSeconds }`）
  - `pending` があり、更新から 10 分を超えている → その R2 オブジェクトと行を消してから続行
- 応答:
  - 201 `{ "file": FileSummary, "duplicate": false }`
  - 200 `{ "file": FileSummary, "duplicate": true }`
  - 400 `invalid_request` — ヘッダーの形式が不正
  - 409 `upload_in_progress` — `details: { retryAfterSeconds }`
  - 411 `length_required` — `Content-Length` がない
  - 413 `file_too_large` — `Content-Length` が上限以上
  - 413 `quota_exceeded` — `details: { usedBytes, limitBytes, requestedBytes }`
  - 415 `unsupported_type` — `details: { allowed: string[] }`
  - 422 `checksum_mismatch` — R2 が内容の不一致を検出（行は削除済み）
  - 502 `storage_error` — R2 への保存に失敗（行は削除済み）

### `GET /api/files`

- クエリ: `tag`（0〜10 個。複数指定時はすべてのタグを持つファイル）、`sha256`、`limit`（1〜200、既定 50）、`cursor`
- `ready` のファイルだけを新しい順で返す。該当がなければ空の配列
- 200: `{ "files": FileSummary[], "nextCursor": string | null }`
- 400 `invalid_tag` — タグの形式が不正

### `GET /api/files/{id}`

- 200: `{ "file": FileSummary, "links": Link[] }`（取り消し済みのリンクも含む）
- 404 `not_found`

### `GET /api/files/{id}/content` — 所有者による取得

- 200: ファイルの内容。`Content-Type` は保存時の値、
  `Content-Disposition: attachment; filename*=UTF-8''<元のファイル名>`（共通の防御用ヘッダーも付く）
- 404 `not_found`

### `DELETE /api/files/{id}`

- 処理は data-model.md の「削除の手順」に従う。`deleting` のファイルに対しては、やり直しとして手順 2 から続ける
- 200: `{ "deleted": "<id>", "revokedLinks": number, "purge": PurgeResult | null, "completed": boolean }`
  - `purge` はキャッシュの削除が不要（リンクを発行したことがない）なら `null`
  - `completed: false` は、キャッシュの削除に失敗して `deleting` のまま残ったことを示す（60 分以内に自動で完了）
- 404 `not_found`

### `PATCH /api/files/{id}/tags`

- 本文: `{ "add": string[], "remove": string[] }`（どちらか一方は省略可、合計 1〜50 件）
- 200: `{ "tags": string[] }`（正規化済み）
- 400 `invalid_tag`、404 `not_found`

### `GET /api/tags` — タグの一覧

- `ready` のファイルに付いているタグを、ファイル数の多い順（同数ならタグ名の順）で返す
- 200: `{ "tags": TagCount[] }`

### `POST /api/files/{id}/links`

- 本文: `{ "label"?: string }`（0〜200 文字）
- 201: `{ "link": Link }`、404 `not_found`

### `GET /api/links`

- クエリ: `fileId`（任意）、`includeRevoked`（`true`/`false`、既定 `false`）
- 200: `{ "links": Link[] }`（新しい順）

### `DELETE /api/links/{token}` — 取り消し

- 処理順: `revoked_at` を記録（取り消し済みなら維持） → 配信用のキャッシュを削除（タグ `l:<token>`）
- 200: `{ "link": Link, "purge": PurgeResult }` — 削除に失敗しても取り消し自体は成功として 200 を返し、
  `purge.ok = false` で知らせる。同じ要求をやり直すと、キャッシュの削除だけをやり直す。やり直さなくても、
  エッジのキャッシュは最長 1 時間で切れる
- 404 `not_found`

## 定期実行（`scheduled`）

- 15 分ごとに実行する。
  - `pending` のまま `updated_at` から 30 分を超えたファイル: R2 のオブジェクト（あれば）と行を削除する
  - `deleting` のまま `updated_at` から 60 分を超えたファイル: R2 のオブジェクト（あれば）と行を削除する
- どちらも、途中で失敗したものは次回に再び処理する。

## エラーコード一覧

`unauthenticated`、`forbidden`、`cross_site_request`、`invalid_request`、`not_found`、`length_required`、
`file_too_large`、`unsupported_type`、`quota_exceeded`、`upload_in_progress`、`checksum_mismatch`、
`storage_error`、`invalid_tag`、`internal_error`
