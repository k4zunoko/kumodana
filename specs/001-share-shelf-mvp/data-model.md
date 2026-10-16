# Data Model: 共有棚 MVP

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-15

メタデータは D1（SQLite）に置き、ファイルの実体は R2 に置く。D1 を正とする（憲法 III）。
時刻はすべて UNIX エポックのミリ秒（`INTEGER`）で保存し、API では ISO 8601 で返す。
整理の手段はタグだけで、アルバムやフォルダは持たない（憲法 VII、FR-027）。

## エンティティ

### File（`files`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | TEXT | PK | 10 文字の Crockford Base32（小文字） |
| `r2_key` | TEXT | NOT NULL, UNIQUE | R2 のキー。`files/<id>` |
| `name` | TEXT | NOT NULL, 1〜255 文字 | 元のファイル名（パスを含まない） |
| `content_type` | TEXT | NOT NULL | 許可された形式のいずれか（下記） |
| `size` | INTEGER | NOT NULL, 1 以上 99999999 以下（100MB 未満を 10 進で解釈） | バイト数 |
| `sha256` | TEXT | NOT NULL | 保存する内容（EXIF 削除後）の SHA-256（小文字 16 進 64 文字） |
| `status` | TEXT | NOT NULL, `pending` / `ready` / `deleting` | 状態 |
| `created_at` | INTEGER | NOT NULL | 作成日時 |
| `updated_at` | INTEGER | NOT NULL | 状態を最後に変えた日時（作成時は `created_at` と同じ） |

- インデックス:
  - `UNIQUE (sha256) WHERE status != 'deleting'`（部分一意インデックス。削除中のものと同じ内容は置き直せる）
  - `(status, updated_at)`（後始末用）
  - `(created_at)`（一覧用）
- 許可する `content_type`: `image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/avif`、`image/svg+xml`、
  `text/html`、`text/html; charset=utf-8`。

### Tag（`file_tags`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `file_id` | TEXT | FK → files.id ON DELETE CASCADE | |
| `tag` | TEXT | NOT NULL, 1〜64 文字 | 正規化済みのタグ |

- 主キー: `(file_id, tag)`。インデックス: `(tag)`。
- 正規化: NFC → 前後の空白を除去 → 小文字化。制御文字とカンマを含むものは拒否する。
- タグ自体の表は持たない。タグの一覧は `file_tags` を `ready` のファイルについて集計して作る。

### Link（`links`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `token` | TEXT | PK, 22 文字の Base64URL | 128 ビットの乱数 |
| `file_id` | TEXT | FK → files.id ON DELETE CASCADE | 対象ファイル |
| `label` | TEXT | NULL 可, 0〜200 文字 | 渡した相手などのメモ |
| `created_at` | INTEGER | NOT NULL | 発行日時 |
| `revoked_at` | INTEGER | NULL 可 | 取り消し日時。NULL なら有効 |

- インデックス: `(file_id)`。
- 配信用 Worker が使う検索は、`links` と `files` を結合し、`revoked_at IS NULL` かつ `status = 'ready'` の
  1 行だけを主キーで引く。

### Usage（派生値、テーブルなし）

- `usedBytes = SELECT COALESCE(SUM(size), 0) FROM files`（`pending` と `deleting` を含む。R2 に実体が残りうるため）
- `limitBytes` は設定値 `STORAGE_LIMIT_BYTES`（本番 8000000000）
- `remainingBytes = max(0, limitBytes - usedBytes)`

### Tag list（派生値、テーブルなし）

- `SELECT tag, COUNT(*) FROM file_tags JOIN files ON files.id = file_tags.file_id WHERE files.status = 'ready'
  GROUP BY tag`。並びはファイル数の多い順、同数ならタグ名の順。

## 状態遷移

### File

```text
(なし) ──上限内なら作成──▶ pending ──R2 保存成功──▶ ready ──削除の指示──▶ deleting ──▶ (なし)
                              │                                              │
                              ├─ R2 保存失敗 ─▶ (なし)  ※その場で行を削除      ├─ キャッシュ削除に成功 ─▶ その場で R2 と行を削除
                              ├─ 同じ内容が置き直され、更新から 10 分超 ─▶ (なし)   └─ 失敗 ─▶ 60 分後に定期実行で R2 と行を削除
                              └─ 更新から 30 分超 ─▶ (なし)  ※定期実行で R2 と行を削除
```

- `ready` のファイルだけが一覧・タグの一覧・リンク発行・配信・取得の対象になる。
- **不変条件**: `ready` のファイルには、必ず R2 のオブジェクトが存在する。R2 のオブジェクトを消すのは、
  `pending` か `deleting` のファイルに限る（憲法 III）。
- **削除の手順**:
  1. D1 のバッチ（1 トランザクション）で、有効なリンクをすべて取り消し、ファイルを `deleting` にする
  2. そのファイルにリンクを発行したことがあれば、配信用のキャッシュを削除する（タグ `f:<id>`）
  3. 成功すれば、R2 のオブジェクトを消してから行を消す（タグとリンクは連鎖削除）
  4. 失敗した場合は `deleting` のまま残し、所有者に知らせる。エッジのキャッシュは最長 1 時間で切れるため、
     定期実行は `deleting` になってから 60 分を過ぎたものを、キャッシュを削除せずに片付ける
  5. 同じ削除をやり直すと、手順 2 から続ける
- **中断したアップロードの置き直し**: 同じ `sha256` の `pending` があり、`updated_at` から 10 分を過ぎていれば、
  その R2 オブジェクト（あれば）と行を消してから新しく作る。10 分以内なら `409 upload_in_progress` を返す。

### Link

```text
(なし) ──発行──▶ 有効（revoked_at = NULL） ──取り消し──▶ 取り消し済み（revoked_at = 日時）
```

- 取り消し済みは終端の状態で、有効には戻らない。
- 取り消しは冪等で、取り消し済みのリンクをもう一度取り消すと、キャッシュの削除だけをやり直す。

## 検証ルール（要件との対応）

| ルール | 要件 |
|---|---|
| 形式は許可リストのみ、サイズは 1〜99999999 バイト | FR-002, FR-003 |
| 同じ `sha256` は `deleting` 以外で 1 件だけ（部分一意インデックス） | FR-007 |
| 中断から 10 分を過ぎた `pending` は置き直しで置き換える | FR-008 |
| 上限判定は `pending` と `deleting` を含む合計で、1 文で行う | FR-009 |
| `ready` 以外は一覧・タグの一覧・リンク・配信・取得の対象外 | FR-008, FR-028, FR-030 |
| トークンは 128 ビットの乱数 | FR-014 |
| 取り消し済み・不存在・削除済みは同じ 404 | FR-021 |
| 複数タグでの絞り込みは、指定したすべてのタグを持つファイル（AND） | FR-024 |
| ファイルの削除はタグとリンクを連鎖削除 | FR-028 |

## マイグレーション

- 置き場所: `apps/admin/migrations/`。ファイル名は `NNNN_<説明>.sql`。
- 適用: `cf d1 migrations apply <DATABASE_ID> --dir apps/admin/migrations`。
- 初回は `0001_init.sql` で上記のテーブルとインデックスをすべて作成する。
