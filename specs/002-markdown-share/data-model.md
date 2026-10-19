# Data Model: Markdown 文書を置いてリンクで共有する

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-19

## 保存されるデータ

**変更なし**。D1 のテーブル（`files`、`file_tags`、`links`）、R2 のオブジェクト、マイグレーションは 001 の
[data-model.md](../001-share-shelf-mvp/data-model.md) のまま。Markdown 文書とテキストは CLI で HTML に変換してから置くので、
棚の上では通常の HTML のファイルとして扱われる。

| 列 | 変換して置いたファイルでの値 |
|---|---|
| `name` | 元のファイル名の末尾に `.html` を足したもの（255 文字を超える場合は元の名前を 250 文字に切り詰める） |
| `content_type` | `text/html; charset=utf-8`（既存の許可形式） |
| `size` | 変換後の HTML のバイト数（1〜99999999） |
| `sha256` | 変換後の HTML の SHA-256。同じ入力と同じ指定からは同じ値になる（同一判定、001 の FR-007） |

## CLI の中だけで使う値（保存しない）

### 判定結果（`Sniffed`、`apps/cli/src/sniff.ts`）

| `kind` | 条件 | 持つ値 |
|---|---|---|
| `image` | 画像のマジックバイト | `contentType`（`image/jpeg` など） |
| `svg` | 読み飛ばした後が `<svg`（`--as` なし） | `contentType: image/svg+xml` |
| `html` | 読み飛ばした後が `<!doctype html` か `<html`（`--as` なし） | `contentType`（`text/html` か `text/html; charset=utf-8`。今のまま） |
| `markdown` | テキストの条件を満たし、上のどれでもない。または `--as markdown` | `text`（BOM を除いた文字列） |
| `text` | テキストの条件を満たし、`--as text` | `text` |

拒否するときは `{ ok: false, code, reason, hint? }` を返す。`code` は [contracts/cli.md](./contracts/cli.md) のエラーコード。

### テキストの検査結果（`TextCheck`、`apps/cli/src/text.ts`）

- 成功: `{ ok: true, text }`
- 失敗: `{ ok: false, code, reason, hint? }`。検査の順序と条件は [research.md](./research.md) M5。

| 失敗の理由 | `code` |
|---|---|
| 0 バイト、空白だけ、NUL、制御文字（ESC を含む） | `unsupported_type` |
| UTF-32 と UTF-16 の BOM、UTF-8 として正しくない | `unsupported_encoding` |

### 変換結果（`Rendered`、`apps/cli/src/markdown.ts`）

- `html`: 変換後の HTML（UTF-8 のバイト列）
- `title`: ページの題名
- `warnings`: 生の HTML の行、表示されない画像、外部の画像のホスト、使えない URL についての警告

### 判定と変換の結果（`Prepared`、`apps/cli/src/prepare.ts`）

- `kind`、`contentType`、`data`（送るバイト列。画像の EXIF は `kumo put` が後で取り除く）、`name`（棚に置く名前）、`warnings`

### 置いた結果（`PutResult`、`apps/cli/src/commands/put.ts`）

001 の結果に、`kind`（判定した形式）と `warnings`（文字列の配列。警告がなければ空）を加える。

## 状態遷移

変更なし（ファイルとリンクの状態は 001 のまま）。
