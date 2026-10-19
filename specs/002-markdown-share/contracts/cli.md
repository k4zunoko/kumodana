# Contract: `kumo` CLI の変更（002）

001 の [contracts/cli.md](../../001-share-shelf-mvp/contracts/cli.md) に対する追加と変更。管理 API は変えない。

## `kumo put <path...> [--tag <tag>]... [--link] [--label <text>] [--keep-exif] [--as <markdown|text>]`

各ファイルについて次を行う（001 の手順 2 を置き換え、手順 3 の後に変換を加える）。

1. サイズを確認（100MB 以上は送信前に拒否）
2. 中身で形式を判定する（拡張子は使わない）。順序と条件は [research.md](../research.md) M5
   - 画像、SVG、HTML はこれまでどおり
   - 画像・SVG・HTML のどれでもない UTF-8 のテキストは Markdown 文書
   - `--as markdown` / `--as text` はテキストの判定より優先する。テキストでないファイルに付けると `not_text` で拒否する
3. 画像で `--keep-exif` がなければ、一時コピーの EXIF を削除
4. Markdown 文書は HTML に変換し、`--as text` のテキストは等幅のまま見せる HTML にする。変換したものは
   `Content-Type: text/html; charset=utf-8`、名前は元の名前の末尾に `.html` を足したものにする。変換後が 100MB 以上なら `file_too_large`
5. 以降（SHA-256、同じ内容の確認、送信、タグ、リンク）は 001 のまま。SHA-256 は変換後のバイト列で計算する

### オプション

| オプション | 内容 |
|---|---|
| `--as <markdown\|text>` | `markdown`: テキストを Markdown 文書として扱う（先頭が HTML や SVG でも）。`text`: Markdown として解釈せず、すべての文字・空白・改行を保って等幅で見せる。ほかの値は使い方の誤り（終了コード `2`） |

### 出力（人向け）

```text
<id>  <name>  <size>  <形式>  [（重複: 既存のファイルを使用）]
  リンク: <url>
```

- `<形式>` は `画像`、`SVG`、`HTML`、`Markdown → HTML`、`テキスト → HTML` のいずれか。
- 警告は標準エラー出力に `警告: <path>: <内容>` の形で出す。警告があっても置くことは止めない。
- 2 つ以上のファイルを指定したときは、最後に `形式: Markdown → HTML 2 件、画像 1 件 / 警告: 3 件` のような集計を出す。

### 出力（`--json`）

```json
{
  "results": [
    { "path": "note.md", "kind": "markdown", "warnings": [], "file": { "…": "FileSummary" }, "duplicate": false, "link": { "…": "Link" } }
  ],
  "summary": { "kinds": { "markdown": 1 }, "warnings": 0 }
}
```

- `kind` は `image`、`svg`、`html`、`markdown`、`text` のいずれか。失敗したファイルは `kind` を持たず、`error` を持つ（001 のまま）。
- `summary` は常に出す。

### 警告

| 条件 | 例 |
|---|---|
| 拡張子と判定の食い違い | `.txt` なのに Markdown、`.html` なのに Markdown、`.md` なのに HTML・SVG、`.png` なのにテキスト |
| 全体が JSON として読める（Markdown のとき） | `--as text` を案内する |
| 文字として表示される生の HTML（コメントを含む） | 行番号を最大 5 つまで示す |
| 表示されない画像 | 相対パス、`data:`、`http:` の画像 |
| 外部の画像を読む | ホスト名を示す |
| 使えない URL のリンクや画像 | `javascript:`、`data:` などは文字のまま表示されることを示す |

### 拒否（エラーコード）

| `code` | 条件 | 終了コード |
|---|---|---|
| `unsupported_type` | 動画、zip、HEIC、PDF、XML 宣言や HTML・SVG 以外の DOCTYPE で始まるもの、空・空白だけ、NUL や制御文字を含むもの | `1` |
| `unsupported_encoding` | UTF-16、UTF-32、UTF-8 として正しくない（Shift_JIS など） | `1` |
| `private_key` | 秘密鍵（`-----BEGIN … PRIVATE KEY-----`）を含む。`--as` の指定にかかわらない | `1` |
| `not_text` | テキストでないファイルに `--as` を指定した | `1` |
| `file_too_large` | 元または変換後が 100MB 以上 | `1` |
| `invalid_argument` | `--as` の値が `markdown`・`text` 以外 | `2` |

複数のファイルを指定した場合、1 件の失敗では止めず、最後に終了コード `1` で終わる（001 のまま）。

## `kumo preview <path> [--as <markdown|text>] [--output <path>] [--no-open]`（新規）

- `kumo put` と同じ判定と変換を行い、結果を確かめる。管理 API と設定ファイルは使わない。
- Markdown 文書とテキスト: 変換結果を一時ディレクトリに、棚に置くときと同じ名前で書き、既定のブラウザで開く。
  - `--output <path>`: 指定した場所に書き、ブラウザは開かない。同名のファイルがあれば上書きせず `file_exists`（終了コード `2`）
  - `--no-open`: 一時ディレクトリに書くだけで、開かない
- 画像・SVG・HTML: 変換は要らないので、判定結果と警告だけを表示する（ファイルは書かない）。
- 出力（人向け）: `形式: <形式>` と、書いた場合は `<path>（<size>）`。警告は標準エラー出力。
- 出力（`--json`）: `{ "kind": "markdown", "path": "<書いた場所 or null>", "size": <bytes or null>, "opened": true, "warnings": [] }`
- 拒否のエラーコードは `kumo put` と同じ。ブラウザを開けなかったときは `open_failed`（終了コード `1`）で、書いたファイルの場所を示す。
