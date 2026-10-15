# Contract: 配信用 Worker の RPC（管理用 → 配信用）

管理用 Worker `kumodana-admin` は、サービスバインディング `FILES`（対象 `kumo`）を通じて、配信用 Worker の
既定エントリポイント（`WorkerEntrypoint` を継承したクラス）の RPC メソッドを呼ぶ。RPC はインターネットからは
呼べない。RPC 呼び出しは Workers Cache を経由しない。

## `purge(tags: string[]): Promise<PurgeResult>`

```ts
type PurgeResult = { ok: true } | { ok: false; error: string };
```

- 引数: 1〜100 個のタグ。形式は `l:<token>` または `f:<fileId>` のみ。それ以外が含まれる場合は
  `{ ok: false, error: "invalid_tag" }` を返し、何もしない。
- 処理: `this.ctx.cache.purge({ tags })` を実行し、結果の `success` を `ok` に写す。失敗時は `errors` の内容を
  `error` にまとめる。
- `this.ctx.cache` が存在しない環境（ローカル実行など）では `{ ok: false, error: "cache_unavailable" }` を返す。
- 例外は投げず、必ず `PurgeResult` を返す。
- キャッシュの削除は、キャッシュを持つエントリポイント（既定エントリポイント）の中で実行する必要がある。
  管理用 Worker からは削除できない。

## 制限

- Workers Cache の削除は無料枠の制限（1 分あたり 5 回、バケット 25）に従う。制限に達した場合は `ok: false` になる。
- 管理用 Worker は、削除の失敗を利用者に返し、やり直せるようにする（[admin-api.md](./admin-api.md) の
  `DELETE /api/links/{token}` と `DELETE /api/files/{id}` を参照）。
