# Research: Markdown 文書を置いてリンクで共有する

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-19

比較と検討の詳細は [docs/markdown-support.md](../../docs/markdown-support.md) にある。ここでは決定と、その理由を短くまとめる。
001 の research（R1〜R16）と区別するため、番号は M を付ける。

## M1. 変換する場所

- **Decision**: kumo CLI で Markdown を HTML に変換し、既存の `PUT /api/files` で `text/html; charset=utf-8` として置く。
- **Rationale**: 憲法 V（重い処理は CLI、Worker の CPU は 1 回 10ms）に合う。配信用 Worker（現在 4.8KB、依存なし）に解析器を入れずに済み、
  閲覧者向けの経路の攻撃面が広がらない。既存の sandbox、キャッシュ、取り消しの仕組みとテストがそのまま効く。
- **Alternatives considered**: 配信用 Worker で変換（CPU の上限、`ETag`・`Content-Length` の作り直し、許可形式の追加が要る）、
  閲覧者のブラウザで変換（文書ごとに JS が付き、スクリプトを禁止できない）、管理用 Worker で変換（CPU の上限）。

## M2. 変換器と依存の追加

- **Decision**: markdown-it 15.0.2 と `@mdit/plugin-tasklist` 1.1.3 を `apps/cli` の `dependencies` に完全固定で加える。
- **Rationale**:
  - Node.js にも Workers にも、Markdown を HTML に変換する標準の機能はない（Workers AI の `toMarkdown` は逆向き）。CommonMark は
    仕様の例だけで 600 を超え、自作は誤りやすい（憲法 VII の「標準では足りない理由」）。
  - markdown-it は既定で安全（`html: false`、危険なスキームの拒否）、依存が 6 つ、VS Code のプレビューと同じエンジン。表・取り消し線・
    自動リンクは内蔵で、タスクリストだけをプラグインで足す。
  - 版は `min-release-age=7` を満たす最新を選んだ。markdown-it 15.0.3（2026-10-16、CPU を使いすぎる入力への修正）は 2026-10-23 以降に上げる。
    `@mdit/plugin-tasklist` 1.1.3 は peer に markdown-it ^15.0.2 を求める。
- **Alternatives considered**: micromark ＋ micromark-extension-gfm（依存が 26 で、拡張には remark/rehype への乗り換えが要る）、
  marked（出力の消毒が必須）、unified（依存が多い）、GitHub の Markdown API（外部サービス、文書を外に送る）、
  `markdown-it-task-lists`（2018 年から更新がない）。

## M3. 生の HTML とリンク

- **Decision**: `html: false`、`linkify: true`、`typographer: false`。`validateLink` を差し替え、スキームのある URL は `http:`・`https:`・
  `mailto:` だけを許し、スキームのない URL（相対パス、`#…`）は許す。見出しに `id` は付けない。タスクリストのチェックボックスには、
  プラグインが文書に依存しない `task-item-N` の `id` を付ける（`label: false` でも付く）。
- **Rationale**: 生の HTML（コメントを含む）は文字として表示される（spec FR-009）。既定の `validateLink` は `javascript:`・`vbscript:`・`file:`・
  `data:`（一部の画像を除く）を拒否するが、許可リストの方が新しいスキームにも安全側に倒れる。文書の内容から `id` を作らないので、DOM clobbering の
  心配がない。linkify-it 6 はスキームのない「あいまいなリンク」を既定で認識しない。
- **Alternatives considered**: サニタイザー（sanitize-html）を足して一部の HTML を許す（spec の対象外と決定）。

## M4. 生成する HTML の形と CSP

- **Decision**: 次のテンプレートにする。CSP は `<meta charset>` の直後に置く。

  ```html
  <!doctype html>
  <html lang="ja">
  <head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>…</title>
  <style>…</style>
  </head>
  <body><main class="markdown">…</main></body>
  </html>
  ```

- **Rationale**: meta の CSP は、それより後の要素に効く。配信用 Worker は Markdown 由来かどうかを区別できないので、文書自体に持たせる
  （憲法 IV の v2.1.0 の項目）。`style-src 'unsafe-inline'` は、`<style>` と、表の列揃え（markdown-it は `style="text-align:…"` を出す）に要る。
  生の HTML を通さないので、利用者がスタイルを注入する経路はない。`img-src https:` は「外部の `https` の画像だけを表示する」決定（spec FR-011）による。
  `<meta name="referrer">` は、手元でプレビューしたときも配信時と同じにするため。
- **Alternatives considered**: 外部の CSS やフォント（閲覧者の IP が外に伝わり、オフラインで崩れる）、github-markdown-css の埋め込み（依存が増える）。

## M5. 形式の判定

- **Decision**: `sniff(bytes, { as })` を次の順で判定する。ファイル名は受け取らない。

  1. 画像のマジックバイト（JPEG、PNG、GIF、WebP、AVIF）→ 画像。`--as` があれば `not_text` で拒否
  2. HEIC、動画、zip、PDF（`%PDF-`）の署名 → 拒否
  3. `--as` がなければ: 先頭の BOM・空白・XML 宣言・コメント・SVG の DOCTYPE を読み飛ばし（範囲はファイル全体）、`<svg` → SVG、
     `<!doctype html` か `<html` → HTML（`Content-Type` の決め方は今のまま）。XML 宣言があった、または HTML・SVG 以外の DOCTYPE なら拒否
  4. テキストの条件（`checkText`）を満たさなければ拒否
  5. 秘密鍵（`/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/`）を含めば拒否（`--as` があっても）
  6. それ以外 → `--as` の値、なければ Markdown

- テキストの条件（`checkText`）: 0 バイトでない、UTF-32 と UTF-16 の BOM でない（UTF-32LE を先に調べる）、NUL を含まない
  （デコードの前にバイト列で調べ、バイナリを文字コードの問題として報告しない）、全体が
  `TextDecoder("utf-8", { fatal: true })` で読める（BOM は取り除かれる）、`[\u0001-\u0008\u000B\u000E-\u001F\u007F-\u009F]`
  を含まない（タブ・LF・CR・FF は許す。ESC には色付きのログの案内を付ける）、空白だけでない。
- **Rationale**: 今受け付けているものは手順 1〜3 で今と同じ結果になる（FR-004）。読み飛ばしの範囲を広げても、今の 4096 バイトの範囲で
  判定できていたものの結果は変わらない（今拒否しているものが HTML や SVG になるだけ）。`meta charset` の確認は今と同じく先頭 4096 バイトで行う。
- **Alternatives considered**: 拡張子による判定（FR-002 と矛盾。資料 §3.10.7）、JSON などの自動判定（規則が複雑になる。対象外と決定）。

## M6. テキストのまま見せる表示

- **Decision**: 全文を HTML のエスケープ（`&`、`<`、`>`、`"`）だけして `<pre>` に入れ、M4 と同じテンプレートにする。`<pre>` の直後に改行を 1 つ置く。
  CSS は `white-space: pre-wrap` と `overflow-wrap: anywhere`、`tab-size: 4`。
- **Rationale**: HTML の解析器は `<pre>` の直後の改行を 1 つ捨てるので、先に 1 つ置けば、本文が改行で始まっても失われない。`pre-wrap` で
  スマートフォンでも横に広がらない。markdown-it を通らないので、安全性はエスケープと CSP で守る。

## M7. 名前と題名

- **Decision**: 変換して置く名前は `元の名前 + ".html"`。足すと 255 文字（コードポイント）を超える場合は、元の名前を先頭から 250 文字に
  切り詰める。題名は、Markdown では最初の `h1` の文字（インラインコードを含む）、なければ元のファイル名。テキスト表示では元のファイル名。
- **Rationale**: 拡張子を解釈しない方針とそろい、元の名前が残り、取得したファイルをそのまま開ける（資料 §3.7）。管理 API はファイル名を
  コードポイントで数える（`apps/admin/src/routes/files.ts` の `parseFilename`）。

## M8. 警告

- **Decision**:
  - 拡張子と判定の食い違い（`warnings.ts`）: 拡張子を markdown（`.md`、`.markdown`、`.mdown`、`.mkd`、`.mkdn`）、html（`.html`、`.htm`、`.xhtml`）、
    svg（`.svg`）、image（`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`、`.avif`）、text（`.txt`、`.csv`、`.tsv`、`.json`、`.jsonl`、`.log`、`.xml`、`.yml`、
    `.yaml`、`.toml`、`.ini`、`.env`、主なソースコード）に分け、判定と違う群なら警告する。一覧にない拡張子と、`--as` を指定したものは警告しない。
  - JSON: Markdown と判定し、前後の空白を除いて `{` か `[` で始まり、`JSON.parse` できるとき。
  - 生の HTML: `zero` プリセットに、HTML かどうかを決める規則（`code`、`fence`、`html_block`、`backticks`、`escape`、`html_inline`、
    `newline`）だけを有効にした別のインスタンスで解析し、`html_block` と `html_inline` のある行番号を集める（表示には使わない）。
  - 画像: 表示に使うトークンのうち、`https:` 以外（相対パス、`http:`）の画像は表示されないと警告し、`https:` の画像はホスト名をまとめて知らせる。
  - 使えない URL: 表示用のインスタンスの `validateLink` が拒否した URL（`javascript:`、`data:` など）を記録し、リンクや画像にならず
    文字のまま表示されることを警告する。
- **実装時の確認**: markdown-it 15 はトークンを作るたびに `defineProperty` を何度も呼ぶため、トークンの数に比例して遅く、GC も増える。
  最初は警告のために全機能の 2 つ目のインスタンス（`html: true`）で解析し直していたが、1MB の文書で変換が 2 倍近く遅くなった。
  検出用を `zero` プリセットに絞り、拒否した URL は 1 回目の解析で記録することで、2 回目の解析を約 4 割の手間に減らした。
- **Rationale**: 置くことは止めず（FR-019）、所有者が誤りに気づけるようにする。拡張子は警告にだけ使う。

## M9. プレビューの開き方

- **Decision**: `kumo preview` は変換結果を `os.tmpdir()` の下の一時ディレクトリに `sharedName` の名前で書き、既定のブラウザで開く。
  Windows は `explorer.exe <path>`、macOS は `open`、それ以外は `xdg-open` を、シェルを通さずに起動する。`--output` を指定した場合は
  そこに書き（上書きしない）、開かない。`--no-open` で開かない。画像・SVG・HTML は変換が要らないので、判定結果と警告だけを表示する。
- **Rationale**: シェルを通さないので、パスに `&` などがあっても安全に開ける。管理 API と設定ファイルを使わない（FR-021）。

## M10. テスト

- **Decision**: Vitest（Node.js）で、`text.ts`・`sniff.ts`・`markdown.ts`・`warnings.ts` を単体で、`put`・`preview` をローカルの HTTP サーバーと
  一時ディレクトリで確かめる。境界例のバイト列（UTF-16、Shift_JIS、制御文字など）はテストの中で組み立てる。既存の判定のテストは
  変えずに通し、`hello world` の拒否を期待する 1 件だけを Markdown に書き換える。
- **Rationale**: Worker の経路は変えないので、workerd のテストは変更不要（憲法 VI の必須項目は既存のテストのまま）。

## M11. 依存の更新

- **Decision**: markdown-it とプラグインのセキュリティ修正は、公開から 7 日経ってから上げる。手順は `docs/runbook.md` に書く。
- **Rationale**: 変換は CLI で所有者自身の入力に対して行うので、修正の遅れの影響は自分の CLI が遅くなる程度にとどまる。

## M12. 性能（SC-006）

- **Decision**: 単体テストでは、病的な入力（各 5 秒）と 1MB の文書（10 秒）の CPU 時間に緩い上限を置き、処理の暴走（2 次の計算量など）
  だけを検出する。SC-006（1MB の変換が 2 秒以内）は、負荷のない状態で手で計測する（[quickstart.md](./quickstart.md)）。
- **Rationale**: テストは並列に動き、exiftool などと CPU を取り合う。2 秒の上限を単体テストに置くと、この PC でも負荷によって
  落ちることがあった（同じ処理が単独なら 0.6〜1.1 秒）。CPU 時間で測るのは、Vitest がテストファイルごとに別のプロセスで動かすため、
  ほかのファイルの処理が混ざらないから。
- **計測結果（2026-10-19、この PC）**: 1,000,114 バイトの Markdown 文書の変換（判定から HTML の生成まで）が約 1.1 秒。
  `kumo preview --no-open` 全体では約 2.7〜3.4 秒。差の多くは CLI の起動で、`kumo --version` が約 1.3 秒、小さなファイルの
  `kumo preview` が約 1.5〜2.5 秒かかる（起動の遅さはこの変更の前からある）。
