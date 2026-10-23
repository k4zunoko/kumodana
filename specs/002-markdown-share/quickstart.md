# Quickstart: Markdown 文書の共有の検証手順

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Contracts**: [contracts/cli.md](./contracts/cli.md)

実装が仕様どおりに動くことを確かめる手順。変わるのは kumo CLI だけで、Worker のデプロイは要らない。

## 前提

- Node.js 22.18 以上。npm の `min-release-age=7` を前提にしている
- 本番での確認（§2）は、001 の初期設定が済み、CLI の設定（`%APPDATA%\kumodana\config.json` か環境変数）がある PC で行う
- この変更を含む CLI を使う: `npm ci` の後、`npm install -g ./apps/cli`（001 の research R16）

## 1. ローカルでの検証（自動テスト）

```sh
npm ci
npm run typecheck
npm test
```

期待結果: すべて成功する。CLI のテストは次を含む。

- テキストの条件: 空・空白だけ・NUL・制御文字・UTF-16・UTF-32・Shift_JIS を拒否し、BOM 付きの UTF-8、タブ・CR・FF を受け付ける。
  4096 バイトより後ろにだけ不正なバイトがあっても見逃さない
- 判定: 既存の画像・HEIC・動画・zip・SVG・HTML のテストが変更なしで通る。テキストは Markdown、`--as` が優先、XML・PDF・秘密鍵は拒否
- 変換: GFM の記法、生の HTML とコメントの文字表示、危険なリンクの無効化、meta の CSP の位置、題名のエスケープ、同じ入力で同じバイト列、
  病的な入力と 1MB の文書で処理が暴走しない（上限は緩い。SC-006 は下の手順で測る）
- `kumo put`: 名前 `note.md.html`、`Content-Type: text/html; charset=utf-8`、変換後の SHA-256、判定結果と警告、集計、原本が変わらない
- `kumo preview`: 管理 API を呼ばない、`--output` で上書きしない

Worker（`apps/admin`、`apps/files`）のテストは変更なしで通る。

## 2. 手動での検証

### US2: 置く前に確かめる

```sh
kumo preview docs/verification/markdown-check.md
```

- 期待: `形式: Markdown → HTML` と警告（生の HTML、表示されない画像など）が表示され、既定のブラウザでページが開く
- 期待: 表、タスクリスト（チェックできない）、取り消し線、自動リンクが記法どおりに表示される
- 期待: 開発者ツールのコンソールに、スクリプトが動いた形跡がない（`alert` が出ない）。meta の CSP による遮断が記録されることがある
- 期待: `kumo preview docs/verification/markdown-check.md --output ./check.html` は `check.html` を書き、もう一度実行すると上書きせずに止まる

### US1: Markdown 文書を置いてリンクで共有する

```sh
kumo put docs/verification/markdown-check.md --link --label "Markdown の確認"
```

- 期待: `<id>  markdown-check.md.html  <size>  Markdown → HTML` とリンクが表示される
- 期待: リンクを、ログインしていないブラウザで開く。PC の Chrome・Edge・Firefox・Safari と、iPhone の Safari・Android の Chrome で、
  表示が崩れず、リンクをたどれ、スクリプトが何も動かない（SC-001、SC-002）。外部の `https` の画像だけが表示される
- 期待: もう一度同じコマンドを実行すると、`（重複: 既存のファイルを使用）` になる
- 期待: `kumo get <id>` で `markdown-check.md.html` が保存され、`kumo preview` の結果と同じ内容である（SC-005）

### US3: テキストのまま見せる

```sh
kumo put ./app.log --as text --link
kumo put ./page.html --as text
```

- 期待: `app.log.html` として置かれ、リンクを開くと元の行・空白・記号がそのまま等幅で表示される
- 期待: `page.html.html` は HTML のソースを文字として表示する

### US4: 判定の結果と問題に気づける

```sh
kumo put ./memo.txt ./data.json ./photo.jpg
```

- 期待: `memo.txt` と `data.json` は Markdown として置かれ、拡張子の食い違い（と JSON）の警告、`--as text` の案内が出る。
  最後に形式ごとの件数と警告の件数が出る
  - 2026-10-23 注記: 見直した。`memo.txt` と `data.json` は `テキスト → HTML` として置かれ、警告は出ない。
    `--as markdown` を付けると Markdown になる。拡張子のない JSON（`README` など）は、今までどおり Markdown と JSON の警告になる
- 期待: Windows PowerShell 5.1 で `"# test" > ps.md` として作ったファイル（UTF-16LE）は、何も保存されず、UTF-8 で保存し直すよう案内される
- 期待: `-----BEGIN PRIVATE KEY-----` の行を含むテキストは、`--as text` を付けても何も保存されない（本物の鍵は使わない）

### SC-006: 1MB の文書の変換時間

1MB 程度の Markdown 文書を用意し、負荷の少ない状態で次を実行する（PowerShell）。

```powershell
Measure-Command { kumo preview .\big.md --no-open }
Measure-Command { kumo --version }
```

- 期待: 1 つ目と 2 つ目の差（変換にかかった時間の目安）が 2 秒以内
- 記録（2026-10-19、開発 PC）: 1,000,114 バイトで変換は約 1.1 秒。`kumo preview` 全体は約 2.7〜3.4 秒、起動は約 1.3 秒
  （[research.md](./research.md) M12）

### 後片付け

- 確認に使ったファイルを `kumo rm <id>` で削除する。リンクは削除と同時に使えなくなる
