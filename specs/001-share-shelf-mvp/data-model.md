# Data Model: 共有棚 MVP

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-15

メタデータは D1（SQLite）に置き、ファイルの実体は R2 に置く。D1 を正とする（憲法 III）。
時刻はすべて UNIX エポックのミリ秒（`INTEGER`）で保存し、API では ISO 8601 で返す。

## エンティティ

### File（`files`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | TEXT | PK | 10 文字の Crockford Base32（小文字） |
| `r2_key` | TEXT | NOT NULL, UNIQUE | R2 のキー。`files/<id>` |
| `name` | TEXT | NOT NULL, 1〜255 文字 | 元のファイル名（パスを含まない） |
| `content_type` | TEXT | NOT NULL | 許可された形式のいずれか（下記） |
| `size` | INTEGER | NOT NULL, 1 以上 99999999 以下（100MB 未満を 10 進で解釈） | バイト数 |
| `sha256` | TEXT | NOT NULL, UNIQUE | 保存する内容（EXIF 削除後）の SHA-256（小文字 16 進 64 文字） |
| `status` | TEXT | NOT NULL, `pending` / `ready` | 状態 |
| `created_at` | INTEGER | NOT NULL | 作成日時 |

- インデックス: `(status, created_at)`（後始末用）、`created_at`（一覧用）。
- 許可する `content_type`: `image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/avif`、`image/svg+xml`、
  `text/html`、`text/html; charset=utf-8`。

### Tag（`file_tags`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `file_id` | TEXT | FK → files.id ON DELETE CASCADE | |
| `tag` | TEXT | NOT NULL, 1〜64 文字 | 正規化済みのタグ |

- 主キー: `(file_id, tag)`。インデックス: `tag`。
- 正規化: NFC → 前後の空白を除去 → 小文字化。制御文字とカンマを含むものは拒否する。

### Album（`albums`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | TEXT | PK | 10 文字の Crockford Base32 |
| `name` | TEXT | NOT NULL, UNIQUE COLLATE NOCASE, 1〜100 文字 | アルバム名（前後の空白を除去） |
| `created_at` | INTEGER | NOT NULL | 作成日時 |

### AlbumFile（`album_files`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `album_id` | TEXT | FK → albums.id ON DELETE CASCADE | |
| `file_id` | TEXT | FK → files.id ON DELETE CASCADE | |
| `position` | INTEGER | NOT NULL | アルバム内の順番。追加時に「そのアルバムの最大値 + 1」 |

- 主キー: `(album_id, file_id)`。インデックス: `(album_id, position)`。
- 同じファイルをもう一度追加しても順番は変えない（何もしない）。

### Link（`links`）

| 列 | 型 | 制約 | 内容 |
|---|---|---|---|
| `token` | TEXT | PK, 22 文字の Base64URL | 128 ビットの乱数 |
| `file_id` | TEXT | FK → files.id ON DELETE CASCADE | 対象ファイル |
| `label` | TEXT | NULL 可, 0〜200 文字 | 渡した相手などのメモ |
| `created_at` | INTEGER | NOT NULL | 発行日時 |
| `revoked_at` | INTEGER | NULL 可 | 取り消し日時。NULL なら有効 |

- インデックス: `file_id`。
- 配信用 Worker が使う検索は、`links` と `files` を結合し、`revoked_at IS NULL` かつ `status = 'ready'` の
  1 行だけを主キーで引く。

### Usage（派生値、テーブルなし）

- `usedBytes = SELECT COALESCE(SUM(size), 0) FROM files`（`pending` を含む）
- `limitBytes` は設定値 `STORAGE_LIMIT_BYTES`（本番 8000000000）
- `remainingBytes = max(0, limitBytes - usedBytes)`

## 状態遷移

### File

```text
(なし) ──上限内なら作成──▶ pending ──R2 保存成功──▶ ready ──削除──▶ (なし)
                              │
                              ├──R2 保存失敗──▶ (なし)  ※その場で行を削除
                              └──30 分経過──▶ (なし)    ※定期実行で R2 と行を削除
```

- `ready` のファイルだけが一覧・リンク発行・配信の対象になる。
- 削除は「有効なリンクをすべて取り消す → 配信用のキャッシュを消す → R2 のオブジェクトを消す → 行を消す」の順で行う。
  キャッシュの削除に失敗した場合は、そこで止めてエラーを返す（リンクの取り消しは記録済みのまま）。
  同じ削除をやり直すと、続きから処理する。

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
| 同じ `sha256` は 1 件だけ（一意制約） | FR-007 |
| 上限判定は処理中を含む合計で、1 文で行う | FR-009 |
| `ready` 以外は一覧・リンク・配信の対象外 | FR-008, FR-030 |
| トークンは 128 ビットの乱数 | FR-014 |
| 取り消し済み・不存在・削除済みは同じ 404 | FR-021 |
| アルバムの削除は `album_files` だけを消す | FR-026 |
| ファイルの削除はタグ・アルバム所属・リンクを連鎖削除 | FR-028 |

## マイグレーション

- 置き場所: `apps/admin/migrations/`。ファイル名は `NNNN_<説明>.sql`。
- 適用: `cf d1 migrations apply <DATABASE_ID> --dir apps/admin/migrations`。
- 初回は `0001_init.sql` で上記のテーブルとインデックスをすべて作成する。
