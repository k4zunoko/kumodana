# Contract: 配信（`kumo`）

**Base URL**: `https://kumo.meshnode.workers.dev`（設定値 `FILES_BASE_URL`。独自ドメインへ移行可能）
**利用者**: リンクを受け取った閲覧者（ログインなし）

## リクエストの扱い

| 要求 | 応答 |
|---|---|
| `GET`/`HEAD /{token}`（`token` は `^[A-Za-z0-9_-]{22}$`）で、有効なリンクかつ `ready` のファイル | `200` と内容 |
| 上記と同じパスにクエリ文字列が付いている | `301`、`Location: /{token}`（内容は返さない） |
| 取り消し済み・存在しない・削除済み・処理中（`pending`）・削除中（`deleting`）のファイル | `404`（本文は下の案内、すべて同一） |
| `/`、トークン形式でないパス、パスの後ろに余分な要素 | `404`（同上） |
| `GET`/`HEAD` 以外のメソッド | `405`、`Allow: GET, HEAD` |

- 2026-10-22 注記: `404` の本文を `Not Found`（`text/plain`）から、「このリンクは使えません。取り消されたか、URL が違います。」だけを
  表示する HTML（`Content-Type: text/html; charset=utf-8`。`viewport` の指定あり、スクリプトと外部の資源はなし）に変えた。
  スマートフォンでも読める大きさで、開けないことを伝えるため。どの理由の `404` も、本文とヘッダーは同一のまま（FR-021）。
- 有効なリンクの判定は D1 の 1 回の検索で行う（`links` と `files` を結合し、`revoked_at IS NULL` かつ `status = 'ready'`）。
- `Range` 要求と条件付き要求（`If-None-Match`）は Workers Cache が処理する。Worker は常に完全な `200` を返す。

## 応答ヘッダー

### すべての応答

| ヘッダー | 値 |
|---|---|
| `Content-Security-Policy` | `sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `X-Robots-Tag` | `noindex, nofollow, noarchive` |

### `200` のみ

| ヘッダー | 値 |
|---|---|
| `Content-Type` | 保存時の値 |
| `Content-Length` | ファイルのサイズ |
| `ETag` | `"<sha256>"` |
| `Content-Disposition` | `inline; filename*=UTF-8''<元のファイル名>` |
| `Cache-Control` | `public, max-age=60` |
| `Cloudflare-CDN-Cache-Control` | `public, max-age=3600, stale-if-error=0` |
| `Cache-Tag` | `l:<token>,f:<fileId>`（Cloudflare が取り除くため閲覧者には届かない） |

### `200` 以外

| ヘッダー | 値 |
|---|---|
| `Cache-Control` | `no-store` |

## キャッシュの前提

- `cloudflare.config.ts` で `cache: { enabled: true }`（Workers Cache）。`cross_version_cache` は使わない
  （デプロイごとにキャッシュは空から始まる）。
- キャッシュのキーはパスとクエリ文字列で決まり、ホスト名を含まない。このため `previewUrls: false` とし、
  配信用 Worker を公開するホストは 1 つに限る。
- エッジでの保持は最長 1 時間。取り消しや削除でキャッシュの削除に失敗しても、1 時間で必ず切れる（FR-019、FR-028）。
- `stale-if-error=0` により、Worker がエラーを返したときに期限切れの内容を返し続けることを防ぐ。
  取り消し済みのリンクが、この経路で見え続けないようにするため。
