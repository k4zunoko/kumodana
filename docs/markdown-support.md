# Markdown 対応の検討

**状態**: 決定済み（§5 の論点はすべて決定。実装は `specs/002-markdown-share/`） | **作成日**: 2026-10-19 |
**改訂**: 2026-10-19（決定の反映、形式を中身で判定する案の検討、全論点の決定）、2026-10-23（論点 2・18・20 の見直し:
テキスト系の拡張子のテキストは既定でテキスト表示） | **調査対象**: コミット `27d02d2`

kumodana に Markdown を入れる場合に、どこへ入れるか、どこまで対応するか、どの方式で実現するかを整理する。
次の spec（`/speckit.specify`）の材料にするための資料で、コードは変更していない。ライブラリの版とサイズは、
2026-10-19 に npm レジストリと bundlephobia で確認した値である（付録 A）。

改訂では、所有者が決めた論点 1・4・6 と、任された論点 3 を反映した。また論点 2 を見直し、拡張子に頼らず
FR-002 と同じく中身で判定する案を §3.10 で検討した。その後、所有者は §5 の残りの論点をすべて推奨どおりに
決定した（中身で判定する案、`--as text` と `--as markdown`、残るリスクの受け入れ、HTML コメントの扱いなど）。

## 要約

- kumodana の画面は、CLI（端末）と、閲覧者に返すファイルそのものだけである。ブラウザで HTML として描画される
  文字は、共有した HTML ファイルの中身しかない。Markdown が役に立つのは「共有するファイルとしての Markdown 文書」
  だけで、ファイル名・タグ・リンクのメモに入れても描画する場所がない（§1）。
- **推奨**: kumo CLI が Markdown を 1 枚で完結する HTML に変換してから置く（方式 A）。範囲は **GFM 段階**
  （表、タスクリスト、取り消し線、自動リンク）とし、生の HTML は無効にする。ライブラリは **markdown-it 15.0.2**
  と `@mdit/plugin-tasklist` 1.1.3。Worker、管理 API、D1 は変更しない（§2、§4）。
- **形式の判定**: FR-002 と同じく中身で判定し、拡張子は使わない。画像・SVG・HTML のどれでもなく、全体が正しい
  UTF-8 のテキスト（NUL や制御文字を含まず、UTF-16 でもない）なら Markdown とみなす。今受け付けているファイルの
  判定は変えない。この案では `.txt`・`.csv`・`.json`・ログも Markdown として置かれ、見た目が崩れる。また、今は
  拒否されている設定ファイルなども置けるようになる。そこで、判定結果の表示、拡張子との食い違いの警告、秘密鍵の
  拒否、逃げ道の `--as text`（Markdown として解釈せず、等幅のまま見せる）で補う（§3.10）。
  2026-10-23 注記: 見直した。実際に `.txt` の連絡事項が見出しと箇条書きに崩れたため、所有者は、拡張子がテキストやソースコードの
  テキストを既定で `--as text` と同じ表示にすると決めた（§5 論点 2・18・20 の注記）。受け付けるかどうかと形式の判定は中身のまま。
- **決定事項**: 憲法を改正して Markdown を加える（MINOR、v2.1.0。文言の案は §3.10.8）。棚に置くファイル名は、
  元の名前に `.html` を足す（任された論点。§3.7）。文書内の画像は外部の `https:` のものだけを表示する。
  生の HTML は許さない。
- 生成する HTML の先頭に `<meta http-equiv="Content-Security-Policy">` を置き、スクリプトを禁止して、読み込める
  外部の資源を `https:` の画像だけに絞る。配信時にすでに付いている CSP の sandbox と合わせると、変換器に穴が
  あってもスクリプトは動かない（§3.5）。
- 拡張段階（シンタックスハイライト、数式、Mermaid）は後回しにする。ハイライトと数式は、CLI で静的に変換すれば
  閲覧時の JS なしで足せる。Mermaid はヘッドレスブラウザか閲覧時の JS が必要で、推奨しない（§3.3）。
- §5 の論点はすべて決定済みである。中身で判定する案、`--as text` と `--as markdown`、残るリスクの受け入れ
  （厳格モードを作らない）、HTML コメントを文字として表示することなどを、推奨どおりに決めた（§5）。

## 1. 現状調査

### 1.1 構成と技術

| パス | 役割 | 技術 | 根拠 |
|---|---|---|---|
| `apps/admin` | 管理用 Worker `kumodana-admin`。JSON の管理 API | Hono 4.13、Zod 4.6、jose 6.2。Cloudflare Access と JWT 検証 | `apps/admin/package.json`、`apps/admin/src/app.ts` |
| `apps/files` | 配信用 Worker `kumo`。リンクからファイルを返す | フレームワークなし（`WorkerEntrypoint`）、Workers Cache | `apps/files/package.json`（実行時の依存なし）、`apps/files/src/index.ts` |
| `apps/cli` | kumo CLI。所有者の唯一の操作手段 | Node.js 22.18 以上の型除去で TypeScript を直接実行。commander 15、exiftool-vendored 39 | `apps/cli/package.json`、`apps/cli/bin/kumo.js` |
| `packages/shared` | API の型、上限値、ID とタグの規則 | 依存なし | `packages/shared/src/*.ts` |
| D1 / R2 | メタデータ / ファイルの実体 | 素の SQL と手書きのマイグレーション | `apps/admin/migrations/0001_init.sql` |

- Web の管理画面はない。憲法 VII は「Web UI は spec を作ってから追加する」と定め、spec の Assumptions にも
  「ブラウザ向けの管理画面は作らない」とある（`.specify/memory/constitution.md`、`specs/001-share-shelf-mvp/spec.md`）。
- フロントエンドのフレームワークや、画面用のバンドル設定は存在しない。Worker は `vite build`
  （`@cloudflare/vite-plugin`）でバンドルし、CLI はバンドルしない（`specs/001-share-shelf-mvp/research.md` R16）。
- 現在のバンドルの大きさ: 配信用 4.8KB（gzip 2.0KB）、管理用 約 270KB（gzip 68KB）。
  `apps/*/.cloudflare/output/v0/workers/default/bundle/index.js`（2026-10-16 のビルド。git の管理外）で測った。

### 1.2 表示・保存されているテキスト

| テキスト | 保存場所 | 表示される場所 | 形式・制約 | 根拠 |
|---|---|---|---|---|
| ファイルの本体（画像、SVG、HTML） | R2 `files/<id>` | 閲覧者のブラウザ（リンク） | `Content-Type` は D1 の値。すべての応答に CSP `sandbox …`（`allow-same-origin` なし） | `apps/files/src/index.ts` 74–82 行、`apps/files/src/headers.ts` 3–14 行 |
| 置ける形式の一覧 | コード | — | 画像 6 種、`text/html`、`text/html; charset=utf-8` | `packages/shared/src/limits.ts` 2–11 行 |
| ファイル名 `files.name` | D1 | `kumo put`・`kumo ls` の出力、配信と取得の `Content-Disposition` | 1〜255 文字。パス区切りと制御文字は不可 | `apps/admin/migrations/0001_init.sql` 6 行、`apps/admin/src/routes/files.ts` 40–53 行、`apps/cli/src/commands/ls.ts` 10–14 行 |
| タグ `file_tags.tag` | D1 | `kumo ls`、`kumo tags` | NFC、前後の空白除去、小文字化。1〜64 文字 | `packages/shared/src/names.ts`、`0001_init.sql` 22 行 |
| リンクのメモ `links.label` | D1 | `kumo link ls` | 0〜200 文字の自由記述 | `0001_init.sql` 31 行、`apps/admin/src/routes/links.ts` 11 行、`apps/cli/src/commands/link.ts` 26–29 行 |
| 管理 API のエラーメッセージ | コード（日本語の固定文） | CLI の標準エラー出力 | JSON の `error.message` | `apps/admin/src/errors.ts`、`apps/cli/src/output.ts` 43–64 行 |
| 配信の 404 の本文 | コード | 閲覧者 | `Not Found`（`text/plain`） | `apps/files/src/index.ts` 16–20 行 |
| CLI のヘルプと結果表示 | コード | 端末 | プレーンテキスト | `apps/cli/src/main.ts`、`apps/cli/src/commands/*.ts` |
| 文書（README、docs、specs） | リポジトリ | GitHub など | すでに Markdown。製品の機能ではない | `README.md`、`docs/`、`specs/` |

分かったこと:

- 所有者が見る文字は、すべて端末に出る。ブラウザで HTML として描画される文字は、閲覧者が開く「共有した HTML
  ファイル」の中身だけである。
- 自由記述の文字列はファイル名とリンクのメモだけで、どちらも所有者が端末で見るためのもの。閲覧者には届かない。
- 今の CLI は Markdown を置けない。形式は中身で判定し、画像・SVG・HTML のどれでもないテキストは「対象外の形式」
  として拒否する（`apps/cli/src/sniff.ts` 45–71 行、FR-002）。したがって、棚に Markdown は 1 件も存在しない。

### 1.3 Markdown を入れられそうな場所

| 候補 | 内容 | 評価 |
|---|---|---|
| **A. 共有するファイルとしての Markdown 文書** | `kumo put note.md --link` で、整形した文書を閲覧者に見せる | **価値が大きい**。手元のメモや手順書を、HTML を書かずに渡せる。以降はこれを対象にする |
| B. リンクのメモ、ファイル名、タグ | 記法を許す | 価値がない。端末でしか表示せず、描画する場所がない |
| C. ファイルの「説明文」欄を新設 | 閲覧者向けの説明を Markdown で付ける | 閲覧者にはファイルそのものを返す設計で、説明を出す画面がない。出すには「共有ページ」という新しい概念が要り、ギャラリーを作らない決まり（FR-027）との境界も曖昧になる。対象外 |
| D. CLI の出力を Markdown で装飾 | 表や強調を端末に描画する | 価値が低い。`--json` があり、人向けの出力は 1 行 1 件で足りている |
| E. 将来の Web 管理画面 | 編集画面とプレビュー | 今は存在しない。作るには spec と CSRF 対策の見直しが要る。`apps/admin/src/csrf.ts` 12–14 行は `Origin` 付きの要求をすべて拒否するので、ブラウザの画面から管理 API を呼べない |

### 1.4 Markdown 対応に関係する既存の決まり

| 決まり | 内容 | 影響 |
|---|---|---|
| 憲法 I | 原本は手元に、棚には共有用のコピーだけを置く | 棚に置くのが変換後の HTML でも原則に合う。原文を棚に残す必要はない |
| 憲法 IV | HTML と SVG に `allow-same-origin` なしの sandbox を付ける。管理用と配信用は別のオリジン。画像の EXIF は既定で削除 | Markdown から作った HTML も同じ隔離の下に置ける。画像を文書に埋め込むなら、その画像にも EXIF の削除が要る |
| 憲法 V | 重い処理は CLI で行い、Worker は 1 回 10ms の CPU に収める | 変換を Worker で行う方式に強く逆らう |
| 憲法 VII | 対象は画像と 1 枚で完結する HTML。依存を足すときは、標準の機能で足りない理由を plan に書く | 新しい spec と plan が要る。Markdown の変換は Node.js にも Workers にも標準の機能がない（Workers AI の `toMarkdown` は文書を Markdown に変換する逆向きの機能で、`apps/*/.cloudflare/types/index.d.ts` に型がある） |
| 憲法「技術・運用上の制約」 | 受け付けるファイルは JPEG、PNG、GIF、WebP、AVIF、SVG、HTML | 入力として Markdown を受け付けるので改正する（論点 1、決定。文言の案は §3.10.8） |
| FR-002 | 形式は中身で判定する | Markdown には中身で判定できる目印がない。「画像・SVG・HTML のどれでもない UTF-8 のテキスト」を Markdown とみなすよう、文言を広げる（§3.10） |
| FR-007、data-model | 同じ内容（SHA-256）は 1 回だけ保存する | 変換後のバイト列で同一判定される。変換器やテンプレートを変えると、同じ原文でも別のファイルになる |
| 配信ヘッダー | `ETag` は `"<sha256>"`、`Content-Length` は保存時のサイズ | Worker で変換する方式では、両方の意味が変わる（`apps/files/src/index.ts` 74–82 行） |
| `.npmrc` | `save-exact=true`、`min-release-age=7` | 公開から 7 日未満の版は使えない。セキュリティ修正の取り込みも 7 日遅れる |

## 2. どこで HTML に変換するか

Markdown をそのまま返しても、ブラウザは整形して表示しない。どこかで HTML に変換する必要がある。

| 方式 | 内容 | 長所 | 短所 |
|---|---|---|---|
| **A. kumo CLI で変換（推奨）** | `kumo put` が `.md` を 1 枚で完結する HTML にし、既存の HTML と同じ経路で置く | Worker、管理 API、D1 を変えない。CPU の制限がない。Worker のバンドルが増えない。既存の sandbox、キャッシュ、取り消しの仕組みとテストがそのまま効く。憲法 I と V に合う | 棚の中身は HTML になり、`kumo get` で Markdown は戻らない（原本は手元にある）。変換器を更新しても、置いた文書の見た目は古いまま |
| B. 配信用 Worker で変換 | R2 に Markdown を置き、キャッシュに当たらなかったときに変換して返す | 棚に原文が残る。変換器の更新が、次の取り直しから反映される | 10ms の CPU に収まる保証がない（markdown-it は 2026 年の 5 つの版で、CPU を使いすぎる入力への修正を出している）。配信用 Worker が 4.8KB から min で約 130KB になる。閲覧者向けの経路に解析器が入り、攻撃面が広がる。`ETag`、`Content-Length`、`HEAD` の扱いを作り直す必要がある。許可形式の追加と憲法の改正が要る |
| C. 閲覧者のブラウザで変換 | Markdown と変換用の JS を 1 枚の HTML に入れて置く | サーバー側は何も変えない | 文書ごとに min で 44〜124KB の JS が付く。スクリプトを禁止する防御（§3.5 の層 3）が使えない。JS が動かないと読めない |
| D. 管理用 Worker で変換 | アップロード時に Worker が変換して R2 に置く | CLI 以外の経路からも使える | 10ms の CPU に収まらない恐れがある。今は本文を R2 に流し込むだけで（research R8、`apps/admin/src/routes/files.ts` 127 行）、変換には全体を読み込む必要がある。A に勝る点がない |
| 参考: 変換しない | `text/plain; charset=utf-8` で返す | 最も簡単 | 整形されないので、Markdown に対応したとは言えない。それでも許可形式の追加は要る |

以降は方式 A を前提に書く。方式 B を選ぶ場合に追加で必要なことは §4.5 にまとめた。

## 3. 対応範囲の段階比較

### 3.1 段階の定義

| 段階 | 含む記法 |
|---|---|
| 最小（CommonMark） | 見出し、段落、強調と太字、リンク、画像、箇条書きと番号付きリスト、引用、インラインコード、コードブロック、水平線、改行 |
| GFM | 最小に加えて、表、タスクリスト（`- [ ]`）、取り消し線（`~~`）、自動リンク（`https://…` を自動でリンクにする） |
| 拡張 | GFM に加えて、シンタックスハイライト、数式、Mermaid、脚注、見出しのアンカーと目次、フロントマターなど（個別に選ぶ） |

### 3.2 比較表（方式 A の場合）

| | 最小 | GFM | 拡張 |
|---|---|---|---|
| できること | 文章、リスト、リンク、コード | 最小に加えて、表、チェックリスト、取り消し線、URL の自動リンク。GitHub や VS Code で書いた文書がほぼそのまま見える | GFM に加えて、色付きのコード、数式、図。技術文書や学習ノートに向く |
| 追加する依存 | markdown-it（依存 6） | 最小に加えて `@mdit/plugin-tasklist`（依存 1）。表、取り消し線、自動リンクは markdown-it に内蔵 | GFM に加えて、Shiki か highlight.js、Temml か KaTeX、Mermaid なら mermaid-cli と puppeteer |
| 実装の量（目安） | 変換、テンプレート、判定で 150 行程度とテスト | 最小に数十行を足す | 要素ごとに 50〜300 行。Mermaid はブラウザの実行環境も要る |
| 生成 HTML の 1 件あたりの増分 | テンプレートの CSS で数 KB | 同左 | ハイライトでコード部分が数倍。KaTeX の HTML 出力は CSS とフォントで数百 KB。Mermaid は SVG を埋め込む |
| XSS のリスク | 低い（生 HTML は無効、危険な URL は拒否） | 低い（最小と同じ。タスクリストのチェックボックスは操作できない `input`） | 中〜高。プラグインが HTML を直接組み立てる。Mermaid は XSS の報告が繰り返されている（付録 A） |
| 閲覧時の JS | 不要 | 不要 | ハイライトと数式は CLI で変換すれば不要。Mermaid を閲覧時に描くなら必要で、スクリプト禁止の防御が使えない |
| 既存データへの影響 | なし | なし | なし |
| Worker への影響 | なし | なし | なし |

### 3.3 段階ごとの詳細

#### 最小

- markdown-it を `html: false` で使う。`default` プリセットの既定は `html: false` だが、`commonmark` プリセットは
  `html: true` なので、プリセットに頼らず明示的に指定する（markdown-it `src/presets/default.ts` 7 行、
  `src/presets/commonmark.ts` 7 行）。
- 生の HTML（`<div>` や `<script>`）は文字として表示される。VS Code のプレビューは `html: true` で描画するので
  （VS Code `extensions/markdown-language-features/src/markdownEngine.ts` の `getMarkdownOptions`）、HTML を
  書いた文書は見た目が変わる。CLI で警告を出す（§3.6）。生の HTML は許さない（論点 6、決定）。
- 文書内の画像（`![](…)`）は、外部の `https:` の画像だけを表示する。相対パスの画像は表示されないので、警告する
  （論点 4、決定）。

#### GFM

| 記法 | markdown-it での実現 | 注意 |
|---|---|---|
| 表 | 内蔵（`table` ルール） | 列の揃えは `style="text-align:…"` で出力される（`src/rules_block/table.ts` 155・206 行）。CSP で `style-src 'unsafe-inline'` が必要 |
| 取り消し線 | 内蔵（`strikethrough`） | — |
| 自動リンク | 内蔵（`linkify: true`、linkify-it 6） | markdown-it 15 からは、スキームのない「あいまいなリンク」を既定で認識しない（CHANGELOG 15.0.0）。`www.example.com` の扱いが GitHub と違う可能性がある（要確認）。一方、CJK の句読点でリンクが終わるようになり、日本語の文章には合う |
| タスクリスト | `@mdit/plugin-tasklist` 1.1.3、または 30 行程度の自前のルール | 2018 年から更新のない `markdown-it-task-lists` は使わない。チェックボックスは `disabled` にする |
| 生 HTML の制限（tagfilter） | 不要 | 生の HTML 自体を無効にするため |

最小からの追加費用は小さい。GitHub や VS Code で書いた文書には表やチェックリストがよく含まれ、最小で止めると
「書いたとおりに見えない」不満が出やすい。

#### 拡張

| 要素 | 候補（7 日を満たす版） | 方式 A での実現 | 費用 | リスク |
|---|---|---|---|---|
| シンタックスハイライト | Shiki 4.5.0（`@shikijs/markdown-it`）、highlight.js 11.12.0 | CLI で色付けする。Shiki はインラインの `style`、highlight.js はクラスと CSS を出す | Shiki は文法 8.7MB とテーマ 1.5MB（展開時）を CLI に入れる。読み込みに時間がかかる（要計測）。highlight.js は全言語で min 901KB | 出力はライブラリが組み立てる。コードフェンスの言語名を属性に入れるので、エスケープの確認が要る（markdown-it 自身も 4.3.1 で同種の注入を修正している） |
| 数式 | Temml 0.14.0（MathML だけを出す）、KaTeX 0.19.0（`@mdit/plugin-katex`） | CLI で MathML に変換して埋め込む。MathML は主要ブラウザが標準で描画する | Temml は min 201KB（CLI 側）で、出力は小さい。KaTeX の HTML 出力は CSS とフォント（数百 KB）を文書ごとに埋め込むか、外部から読む必要がある | KaTeX には `\href` などを制限する `trust` 設定がある。フォントを外部から読むと、閲覧者の IP アドレスが外部に伝わる |
| Mermaid | mermaid 12.1.0、mermaid-cli 12.0.0 | (1) CLI で SVG に変換（mermaid-cli は puppeteer でブラウザを動かす）、(2) 閲覧時に JS で描画、(3) 対応せず、図は SVG として別に置く | (1) はブラウザ本体のダウンロードが要る。mermaid パッケージだけで展開時 122MB。(2) は文書ごとに数 MB の JS | XSS の報告が繰り返されている（GHSA-7rqq-prvp-x9jh など）。(2) はスクリプトを許可する必要があり、§3.5 の層 3 が使えない |
| 脚注 | `@mdit/plugin-footnote` 1.1.2、`markdown-it-footnote` 4.0.0 | プラグインを足す | 小さい | 要素の `id` を作る。markdown-it の文書は、利用者の入力から `id` や `name` を作るときは接頭辞を付けるよう求めている（DOM clobbering。`docs/safety.md`）。スクリプトを禁止すれば実害はほぼない |
| 見出しのアンカーと目次 | markdown-it-anchor 10.0.0 | プラグインを足す | 小さい | 脚注と同じく `id` に接頭辞を付ける |
| フロントマター | 先頭の `---` の区間を自前で切り出す | `title` を `<title>` に使う | 小さい | YAML を解析するなら依存が増える。使うキーを限れば正規表現で足りる |

拡張の中では、脚注とアンカーは安い。ハイライトと数式は、CLI で静的に変換すれば閲覧時の JS が要らず、
セキュリティの方針を崩さない。Mermaid だけは、どの実現方法でも費用かリスクが大きい。

### 3.4 変換ライブラリの比較

| ライブラリ | 使える版（公開から 7 日以上） | 依存 | サイズ（min / gzip） | 既定の安全性 | GFM | 拡張のしやすさ |
|---|---|---|---|---|---|---|
| **markdown-it** | 15.0.2（2026-09-11）。15.0.3 は 2026-10-23 から使える | 6（entities、linkify-it、mdurl、punycode.js、uc.micro、argparse） | 124KB / 51KB（14.3.2 で測定） | 安全。`default` プリセットは生 HTML が無効で、`javascript:`、`vbscript:`、`file:`、画像以外の `data:` を拒否する | 表、取り消し線、自動リンクは内蔵。タスクリストはプラグイン | 高い。`highlight` オプションがあり、プラグインが豊富。VS Code のプレビューと同じエンジン |
| micromark と micromark-extension-gfm | 4.0.3 と 3.0.0 | 18 と 8（小さいパッケージが多い） | 52KB / 15KB と 23KB / 7KB | 安全。`allowDangerousHtml` と `allowDangerousProtocol` は既定で `false`。リンクは http(s) や mailto などだけを許す | すべて（脚注と tagfilter を含む） | 低い。HTML を直接出すので、ハイライトなどを足すには remark と rehype への乗り換えが要る |
| marked | 18.1.0 | 0 | 44KB / 13KB | **安全ではない**。README が、出力を DOMPurify などで消毒するよう警告している | 既定で GFM | 中程度。拡張は多い |
| unified（remark、rehype、rehype-sanitize） | remark-gfm 4.0.1、rehype-sanitize 6.0.0 など | 数十 | 構成による | rehype-sanitize で許可リスト方式の消毒ができる | すべて | 最も高い。依存も最も多い |
| 参考: GitHub の Markdown API | — | 外部サービス | — | GitHub 側で消毒される | GitHub と同一 | — |

- markdown-it と micromark は生の HTML を無効にできるので、消毒用のライブラリなしで安全な出力が得られる。
  marked は消毒が必須になる。Node.js の CLI で DOMPurify を使うには jsdom などの DOM 実装が要り、依存がさらに増える。
- GitHub の Markdown API は文書を外部に送ることになり、外部サービスへの依存も増える（憲法 VII）。採らない。
- 将来ハイライトなどを足すことを考えると、markdown-it が最も素直である。GFM で止めると決めるなら、micromark も
  依存の数を除けば同等の選択肢になる。

### 3.5 XSS とサニタイズ

**脅威の整理**: 書き手は所有者だけで、悪意のある書き手は想定しない。それでも、次の経路で危険な内容が入りうる。

- 他人が書いた Markdown（README、AI の出力、Web からのコピー）をそのまま置く
- 生成した HTML を閲覧者が開く（閲覧者にとっては、知らない人から受け取った URL）

既存の HTML の共有では、sandbox の中で任意のスクリプトを動かすことを許している（spec US1 の受け入れシナリオ 2、
research R5）。Markdown から作る HTML には書き手のスクリプトが要らないので、HTML より強く絞れる。

**多層の防御（推奨の構成）**

| 層 | 内容 | 止めるもの |
|---|---|---|
| 1. 生 HTML を無効にする | markdown-it の `html: false`。`<script>` や `<img onerror>` は文字として出る | 要素と属性の注入 |
| 2. 危険な URL を拒否する | markdown-it の `validateLink`（`javascript:`、`vbscript:`、`file:`、`data:` を拒否し、`data:image/(gif\|png\|jpeg\|webp)` だけ許す）。さらに `http`、`https`、`mailto`、`#` だけの許可リストにしてもよい。`data:` の画像は層 3 で表示されないので、変換時に警告する | `javascript:` のリンク、`data:text/html` |
| 3. 生成 HTML に meta の CSP を入れる | `<meta charset>` の直後に `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` | 層 1・2 をすり抜けた場合のスクリプトの実行、`https:` の画像以外の読み込み、iframe |
| 4. 既存の配信ヘッダー | CSP `sandbox`（`allow-same-origin` なし）、`nosniff`、`no-referrer`、管理用と別のオリジン | Cookie、ブラウザの保存領域、管理 API、他のリンクへのアクセス（SC-006 で確認済み、`docs/runbook.md` §12） |
| 5. 変換の上限 | 入力と出力のサイズ（100MB 未満）の確認、入れ子の上限（markdown-it の `maxNesting: 100`） | 病的な入力による CLI の停止 |

補足:

- meta 要素の CSP では、`sandbox`、`frame-ancestors`、`report-uri` は使えない（CSP 仕様）。sandbox は配信ヘッダー
  （層 4）で付くので問題ない。meta の CSP はそれより前の要素には効かないため、`<meta charset>` の直後に置く。
  meta の CSP は追加の制限として働き、HTTP ヘッダーの CSP を緩めることはない。
- 層 3 は方式 A ならではの利点である。配信用 Worker は Markdown 由来の HTML かどうかを区別できないので、
  ヘッダーで HTML より強い CSP を付けられない。文書が自分の CSP を持てば、Worker を変えずに強くできる。
  手元でプレビューしたとき（`file://`）にも効く。
- 文書内の画像は、外部の `https:` のものだけを表示する（論点 4、決定。`img-src https:`）。外部の画像を読むたびに、
  閲覧者の IP アドレスが外部のサイトに伝わる。`Referrer-Policy: no-referrer` により、リンクの URL は伝わらない。
  HTML の共有でも同じ挙動を許している（spec Assumptions）。CLI は、外部の画像のホスト名を警告する。
- 生の HTML は許さない（論点 6、決定）。将来見直す場合（`<details>` や `<kbd>` を使いたいなど）は、変換後に
  許可リスト方式のサニタイザーを通す。Node.js では sanitize-html 2.18.0（htmlparser2、postcss などに依存）が使える。
  DOMPurify は DOM の実装なしでは動かない。その場合も層 3 は残す。
- `--as text`（§3.10.6）で作る HTML は、本文を HTML のエスケープ（`&`、`<`、`>`、`"`）だけして `<pre>` に入れる。
  markdown-it を通らないので層 1・2 は関係なく、エスケープと層 3・4 で守る。
- 過去の脆弱性の傾向: markdown-it は XSS よりも、CPU を使いすぎる入力（2 次の計算量）への修正が多い（14.1.1、
  14.2.0、15.0.1、15.0.2、15.0.3。すべて 2026 年）。方式 A では、所有者自身の入力で自分の CLI が遅くなるだけで、
  影響は小さい。方式 B では、配信用 Worker の CPU の上限に直結する。

**テストで確かめる攻撃パターン**（§4.4 で使う）: `<script>`、`<img src=x onerror=…>`、`[x](javascript:alert(1))`、
大文字・文字参照・タブ・改行を混ぜた `javascript:`（`JAVASCRIPT:`、`jav&#x09;ascript:` など）、
`[x](data:text/html;base64,…)`、`<javascript:alert(1)>` の形の自動リンク、リンクのタイトル内の引用符、
コードフェンスの言語名に入れた `"><script>`、表のセル内の HTML、`<meta http-equiv="refresh">`、`<base href>`、
`<style>`、`<iframe>`、`<svg onload>`。

### 3.6 編集体験（プレビューとエディタ）

**現状**: kumodana に編集画面はなく、Markdown は手元のエディタで書く。憲法 I の「原本は手元」に合っている。

**プレビュー**

| 方法 | 内容 | 置かれるものとの一致 | 費用 |
|---|---|---|---|
| エディタのプレビュー（VS Code など） | 追加の作業なし | 近いが一致しない。VS Code も markdown-it を使うが、生 HTML を有効にし、highlight.js で色付けする。組み込みのエンジンにタスクリストのプラグインはない（拡張機能で足す） | なし |
| **`kumo preview <file>`（推奨）** | `kumo put` と同じ判定と変換で一時ファイルに HTML を書き、既定のブラウザで開く。判定した形式と警告も表示する。`--as` を使える。`--output` で保存だけもできる | 完全に一致する（置かれるバイト列と同じ） | 小さい（数十行。管理 API を呼ばない） |
| `kumo put --dry-run` | 判定と変換まで行い、送らない | 同上 | 小さい |
| 保存のたびに自動で更新するプレビュー | ファイルを監視して再変換する | 同上 | 中程度。ファイルの監視かローカルのサーバーが要る。最初は不要 |

**判定結果と警告**: `kumo put` と `kumo preview` は、判定した形式（Markdown、テキスト、HTML、SVG、画像）を必ず
表示する。そのうえで、次の場合は標準エラー出力で警告する（§3.10.6）:

- 拡張子と判定結果が食い違う
- 全体が JSON として解析できる
- 文字として表示される生の HTML がある（行番号を付ける）
- 相対パスや `data:` の画像がある（どちらも表示されない）
- 外部の画像を読む（ホスト名を示す）

**更新**: 置き直すと内容が変わるので、新しい ID と新しいリンクになる（SHA-256 で同一判定する設計のため）。
古いリンクは `kumo rm` か `kumo link revoke` で消す。「リンクを保ったまま内容を差し替える」機能は、キャッシュの
削除や `ETag` の意味を変える別の機能なので、ここでは扱わない（§5 論点 11）。

**Web のエディタ（参考）**: 作るなら spec が必要。最小の構成は、textarea と、sandbox を付けた iframe のプレビュー。
CodeMirror 6 は数百 KB、Monaco は数 MB。管理 API は `Origin` 付きの要求を拒否するので
（`apps/admin/src/csrf.ts`）、ブラウザから呼ぶには CSRF 対策を作り直す必要がある。

### 3.7 保存形式

| 案 | 棚に置くもの | 長所 | 短所 |
|---|---|---|---|
| **1. HTML だけ（推奨、方式 A）** | 変換後の HTML（`text/html; charset=utf-8`） | D1、管理 API、Worker、容量の計算を変えない。「`ready` なら R2 に実体が 1 つある」という不変条件もそのまま | 棚から原文は戻らない（原本は手元にある） |
| 2. Markdown だけ（方式 B） | 原文（許可形式に `text/markdown; charset=utf-8` を追加） | 原文が戻る | §2 の方式 B の短所がすべて当てはまる |
| 3. 両方 | 原文と HTML の 2 つのオブジェクト | 両方の長所 | 1 行に 1 オブジェクトの前提が崩れ、容量の計算、削除、後始末を作り直すことになる。容量も 2 倍使う |
| 4. HTML に原文を埋め込む | HTML の中に、`<script type="text/markdown">` などで原文を残す | 原文を取り出せる | サイズが約 2 倍になる。閲覧者にも原文が渡る（見えている内容と同じなので問題は小さい）。必要性が低い |

文字コードの条件（UTF-8 に限る、BOM を取り除く、UTF-16 などは拒否する）は §3.10.2 にまとめた。
生成する HTML は `<meta charset="utf-8">` を持ち、送るときの `Content-Type` は `text/html; charset=utf-8` を明示する。
今の `htmlContentType` は、meta charset があると charset なしの `text/html` を選ぶので、Markdown の経路では使わない
（`apps/cli/src/sniff.ts` 73–81 行）。

**ファイル名（論点 3。任されて決定）**: 棚に置く名前は、**元のファイル名の末尾に `.html` を足したもの**にする。
変換しない画像・SVG・HTML の名前は、今までどおり変えない。

| 元の名前 | 判定 | 棚に置く名前 |
|---|---|---|
| `note.md` | Markdown | `note.md.html` |
| `README`（拡張子なし） | Markdown | `README.html` |
| `memo.txt` | Markdown | `memo.txt.html` |
| `app.log`（`--as text`） | テキスト | `app.log.html` |
| `page.html`（`--as text`） | テキスト | `page.html.html` |
| `page.html` | HTML | `page.html`（変えない） |

理由:

1. **拡張子を解釈しない方針とそろう**。中身で判定するので、Markdown になるファイルの拡張子は何でもありうる（なし、
   `.txt`、`.log` など）。拡張子を置き換える方式では、「どこからが拡張子か」（`.env`、`archive.tar.gz`、`v1.2`）を
   決める必要がある。末尾に足すだけなら、規則が 1 つで済む。
2. **元の名前が残る**。`kumo ls` で原本が分かり、`note.md` と `note.txt` を置いても名前で区別できる。
3. **中身と末尾の拡張子が一致する**。`kumo get` やブラウザで保存したファイルを、そのままブラウザで開ける。
   `note.md` のままだと、HTML が `.md` という名前で保存される。
4. **手元の原本と名前がぶつからない**。原本と同じフォルダーに `kumo get` しても、`note.md.html` は
   `note.md` と別の名前になる（`kumo get` は上書きしない。`apps/cli/src/commands/get.ts` 16–20 行）。

欠点は、`.md.html` が見慣れないことと、`--as text` で HTML を置くと `page.html.html` になること。どちらも
中身を正しく表しているので、受け入れる。`files.name` は 255 文字までなので（`0001_init.sql` 6 行）、足すと
超える場合は、元の名前を 250 文字に切り詰めてから `.html` を足す。

### 3.8 既存データとの互換性

- 棚に Markdown は存在しない（§1.2）ので、データの移行は要らない。
- CLI の挙動は変わる。今まで「対象外の形式」として拒否していたテキストが、Markdown として受け付けられるように
  なる。既存のテスト `apps/cli/test/sniff.test.ts` 36–38 行（`hello world` を拒否する）は、書き換えが要る。
  画像・SVG・HTML の判定結果は変わらない（§3.10.1）。
- 方式 A では、D1 のスキーマ、管理 API、配信、許可形式（`packages/shared/src/limits.ts`）を変えない。古い CLI も
  そのまま動き、置いてある画像、SVG、HTML にも影響しない。
- 同一判定は変換後のバイト列で行われる。同じ Markdown でも、変換器、プラグイン、テンプレート（CSS）の版が違えば
  別のファイルとして置かれる（古い方は残る）。変換結果に日時や乱数を入れず、同じ入力と同じ版からは同じバイト列が
  できるようにする。
- 変換器を更新しても、置いた文書の見た目は変わらない。安定しているとも、古いままとも言える。
- 方式 B を選ぶ場合は、管理用 Worker と配信用 Worker を先にデプロイし、その後で CLI を更新する順序が必要になる。

### 3.9 バンドルサイズと性能

- **方式 A**: Worker のバンドルは増えない。増えるのは CLI の `node_modules`（markdown-it 15.0.2 は展開時 2.0MB で、
  依存は 6 つ）と、各文書に埋め込むテンプレートの CSS（数 KB）だけ。CLI はビルドせず型除去で動くので（research R16）、
  ESM の依存を読み込めれば足りる。変換は手元の CPU で行われ、時間の上限はない。
- **方式 B の場合**: Workers の無料プランは、スクリプトの大きさが非圧縮で 64MiB まで（圧縮後の上限はない）、起動は
  1 秒以内、CPU は 1 回 10ms まで（Cloudflare Workers Limits、2026-10-12 更新）。大きさは問題にならず、CPU が制約に
  なる。配信用 Worker は、markdown-it を入れると 4.8KB から min で約 130KB になる。変換の時間は計測していないので、
  方式 B を選ぶなら、まず数 KB から数 MB の文書で計測する。
- **拡張段階の出力サイズ**: Shiki のインラインの `style` はコードの量に比例して増える。KaTeX の HTML 出力は、
  フォントを含めると数百 KB。Temml（MathML）の出力は小さい。

### 3.10 形式の判定: 中身で判定する案（論点 2 の見直し）

所有者の意向は、拡張子による例外を設けず、FR-002 と同じく中身で判定することである。ここでは、
「画像・SVG・HTML のどれでもなく、正しい UTF-8 のテキストなら、すべて Markdown として扱う」案を検討する。

Markdown にはマジックバイトがなく、CommonMark ではどんな文字列も正しい Markdown として解釈される。したがって
「Markdown かどうか」は判定できず、判定できるのは「テキストかどうか」だけである。この案は、「テキストなら
Markdown として見せる」という扱いを決めるものである。

#### 3.10.1 基本方針

- **今受け付けているファイルの判定は変えない**。画像・SVG・HTML の判定を先に行い、今「対象外の形式」として
  拒否しているテキストだけを Markdown に回す。今あるテストは、`hello world` の 1 件を除いてそのまま通る（§3.8）。
- **拡張子は判定に使わない**。判定結果と拡張子が食い違うときの警告にだけ使う。
- **検査するのは「テキストとして正しいか」**。Markdown として正しいかは検査できない。
- **ファイル全体を検査する**。CLI はすでにファイル全体をメモリに読んでいる（`apps/cli/src/commands/put.ts` 89 行）。
  今の `sniffText` は、先頭の 4096 バイトを壊れたバイトを許して読んでいる（`apps/cli/src/sniff.ts` 46 行）。
  そのままでは、4096 バイトより後ろの不正なバイトを見逃す。

#### 3.10.2 テキストとバイナリの判定基準

| 条件 | 扱い | 理由と案内 |
|---|---|---|
| 0 バイト | 拒否 | 管理 API も 1 バイト以上を求める（data-model の `size`）。「空のファイルです」 |
| 先頭が UTF-32 の BOM（`FF FE 00 00`、`00 00 FE FF`） | 拒否 | 「UTF-32 で保存されています。UTF-8 で保存し直してください」。UTF-16LE の BOM と先頭の 2 バイトが同じなので、先に調べる |
| 先頭が UTF-16 の BOM（`FF FE`、`FE FF`） | 拒否 | 「UTF-16 で保存されています。UTF-8 で保存し直してください」。Windows PowerShell 5.1 の `>` と `Out-File` は既定で UTF-16LE を書くので、所有者の環境（Windows）で実際に起こる |
| 先頭が UTF-8 の BOM（`EF BB BF`） | 取り除いて続ける | 取り除かないと、先頭の行の `#` が見出しにならない（行頭に U+FEFF が残る） |
| 全体が UTF-8 として正しくない | 拒否 | `TextDecoder("utf-8", { fatal: true })` で全体を検査する。Shift_JIS や EUC-JP の日本語はほぼここで落ちる。「UTF-8 ではありません（Shift_JIS などの可能性があります）」。ASCII だけのファイルは、どの文字コードでも UTF-8 として正しい |
| NUL（U+0000）を含む | 拒否 | バイナリか、BOM のない UTF-16 を示す（ASCII の文字や改行では、片方のバイトが 0 になる） |
| タブ・改行（LF）・復帰（CR）・改ページ（FF）以外の C0 制御文字（U+0001〜U+001F）と DEL（U+007F） | 拒否 | ESC（U+001B）は色付きのログ（ANSI エスケープ）を示すので、「色の制御文字を取り除いてください」と案内する。FF は古いソースコードなどにあり、CommonMark も空白として扱うので許す |
| C1 制御文字（U+0080〜U+009F） | 拒否 | UTF-8 として正しくても、文字化けの名残であることが多い |
| BOM を除くと空白と改行だけ | 拒否 | 「内容がありません」 |
| その他（私用領域、U+FFFD、ゼロ幅の文字、双方向の制御文字など） | 受け付ける | 正しいテキストの一部でありうる。双方向の制御文字（U+202E など）で見た目を偽る手口はあるが、書き手は所有者なので扱わない |
| 改行コード（CRLF、CR、LF） | 受け付ける | markdown-it が正規化する |

検査は、BOM の確認、`fatal: true` での全体のデコード、1 つの正規表現
（`/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/`）、空白だけかの確認で済む。100MB のファイルでも、手元の
CPU で短時間に終わる。

#### 3.10.3 判定の順序

| 順 | 判定 | 結果 | 今との違い |
|---|---|---|---|
| 1 | 画像のマジックバイト（JPEG、PNG、GIF、WebP、AVIF） | 画像 | なし |
| 2 | HEIC、動画、zip の署名 | 拒否 | なし |
| 3 | PDF の署名（`%PDF-`） | 拒否（「PDF は対象外です」） | 追加。ほとんどの PDF は順 8 で落ちるが、ASCII だけの PDF は Markdown になってしまうので、専用の理由を出す |
| 4 | UTF-32 と UTF-16 の BOM | 拒否（文字コードを案内） | 追加。今は「対象外の形式」 |
| 5 | 先頭の BOM、空白、XML 宣言、コメント、SVG の DOCTYPE を読み飛ばした後が `<svg` | SVG | なし。ただし読み飛ばす範囲を、先頭 4096 バイトから全体に広げる（§3.10.4 の例 9） |
| 6 | 同じく、読み飛ばした後が `<!doctype html` か `<html` | HTML | なし |
| 7 | XML 宣言があった、または HTML と SVG 以外の DOCTYPE（`<!DOCTYPE plist …>` など）で始まる | 拒否（「XML は対象外です」） | 追加。今も拒否されており、その結果を保つ |
| 8 | §3.10.2 のテキストの条件を満たさない | 拒否（落ちた条件を示す） | 追加。今は一律に「対象外の形式」 |
| 9 | 秘密鍵（`-----BEGIN … PRIVATE KEY-----`）を含む | 拒否 | 追加（§3.10.6 の対策 E） |
| 10 | それ以外 | Markdown（`--as text` のときはテキスト） | 追加。今は「対象外の形式」 |

`--as` を指定した場合は、順 5〜7 の結果より指定を優先する。`--as text` は、HTML、SVG、XML のソースも
テキストとして見せる。`--as markdown` は、先頭が HTML や SVG の文書を Markdown として扱う。どちらも順 8（テキストの
条件）と順 9（秘密鍵）は必ず調べる。順 1〜4 に当たるファイルに `--as` を付けた場合は、「テキストではない」として拒否する。

#### 3.10.4 誤判定の境界例

| # | 例 | 今 | この案 | 評価と対策 |
|---|---|---|---|---|
| 1 | `<p align="center"><img …></p>` や `<h1 align="center">` で始まる Markdown（GitHub の README によくある） | 拒否 | Markdown。先頭の HTML は文字として見える（論点 6 の決定） | 判定は正しいが、見た目が崩れる。生の HTML の警告（行番号付き）で知らせる |
| 2 | `<!-- markdownlint-disable -->` や `<!-- TOC -->` のような HTML コメントで始まる Markdown | 拒否 | Markdown（コメントを読み飛ばした後が `<svg` や `<html` ではない）。コメントは文字として見える | 判定は正しい。コメントを出力から取り除くかは §5 論点 17 |
| 3 | `<!doctype html>` や `<html>` で始まる `.md` | HTML | HTML（変わらない） | 中身は HTML そのものなので正しい。拡張子との食い違いを警告する。Markdown として見せたいなら `--as markdown` |
| 4 | インラインの `<svg>`（ロゴなど）で始まり、後ろに Markdown が続く `.md` | SVG | SVG（変わらない） | 誤判定。ブラウザは XML として読むので、`</svg>` より後ろでエラーになる。拡張子との食い違いの警告と `kumo preview` で気づける。`--as markdown` で回避できる（ただし SVG は生の HTML なので、文字として見える） |
| 5 | XML 宣言付きの XML（RSS、設定ファイル） | 拒否 | 拒否（順 7） | 今と同じ。見せたいなら `--as text` |
| 6 | XML 宣言のない XML（`<rss version="2.0">`、`<Project Sdk="…">`） | 拒否 | Markdown。タグは文字として見え、行がつながる | 誤判定だが、HTML の断片で始まる Markdown（例 1）と区別できない。拡張子の警告で知らせ、`--as text` を案内する |
| 7 | 先頭に BOM、空白、空行がある HTML | HTML | HTML（変わらない） | 読み飛ばすので正しい |
| 8 | 先頭に BOM がある Markdown | 拒否 | Markdown（BOM を取り除いて変換） | BOM を残すと先頭の見出しが崩れる。取り除くことをテストで確かめる |
| 9 | 4096 バイトを超えるコメント（ライセンスの表記など）で始まる HTML | 拒否 | 読み飛ばしを全体に広げれば HTML。広げなければ Markdown | 広げる（順 5）。今拒否しているものが HTML として受け付けられるだけで、受け付けていたものの結果は変わらない |
| 10 | `<head>`、`<meta charset>`、`<div>` などで始まる HTML の断片（`.html`） | 拒否 | Markdown。タグがすべて文字として見える | 誤判定（害は見た目だけ）。拡張子 `.html` との食い違いを警告し、「先頭に `<!doctype html>` を付けると HTML として置ける」と案内する |
| 11 | Shift_JIS や UTF-16 で保存した `.md`（PowerShell 5.1 で書き出したものを含む） | 拒否 | 拒否（文字コードを案内） | 今より分かりやすくなる |
| 12 | 色付きのログ（ANSI エスケープを含む） | 拒否 | 拒否（ESC） | 色の除き方を案内する |
| 13 | 空、または空白だけのファイル | 拒否 | 拒否 | — |
| 14 | `<https://example.com>` や `<user@example.com>` で始まるメモ | 拒否 | Markdown（自動リンク） | 正しい |

#### 3.10.5 Markdown 以外のテキストを置いたときの見え方

Markdown として変換すると、CommonMark の規則（CommonMark Spec 0.31.2）により次のことが起こる。

- 単独の改行は改行にならず、段落の中でつながる（論点 7）。空行がなければ、ファイル全体が 1 つの段落になる。
- 行頭の `# `（`#` と空白）は見出し、`-`・`*`・`+`・`1.` はリスト、`>` は引用になる。4 つ以上の空白で始まる行は、
  段落の途中ではつながり、空行の後ではコードになる。
- `---` や `===` だけの行は、直前の行を見出しにする。
- `*` で囲んだ部分は強調になり、記号が消える（`2*3*4` では `3` が斜体になる。`_` は単語の中では強調にならない）。
- ASCII の記号の前の `\` はエスケープとして消える（`\\` は `\` 1 つになる。`C:\Users` の `\U` はそのまま）。
- `[名前]: URL` の形の行（リンクの参照定義）は表示されない。
- タグのような部分は、生の HTML として文字のまま表示される（論点 6）。

| 種類 | Markdown としての見え方 | 害 |
|---|---|---|
| `.txt`（日本語のメモ） | 空行で区切った段落は読める。行ごとの改行はつながり、ブラウザによっては日本語の間に空白が入る。行頭の記号がリストや見出しになる | 中: 読めるが、レイアウトが変わり、記号や `\` の一部が消える。書き手が気づきにくい |
| `.csv` | 空行がないので全体が 1 つの段落になり、行の区切りが消える | 大: 表として読めない |
| `.json` | 1 つの段落につながり、インデントが消える。`*` などで値が変わって見えることもある | 大: 構造が読めない |
| ソースコード | 行がつながる。`# ` で始まるコメント（Python、シェル、YAML）が見出しになる。`2*3*4` のような式が強調になる | 大: 読めない |
| ログ | 行がつながり、行ごとの区切りが消える。色付きのものは拒否される | 大: 読めない |
| `.env` や設定ファイル | `# コメント` が見出しになり、`KEY=value` がつながる | 見た目よりも、**秘密を含むファイルが置けてしまう**ことが問題（下記） |

**安全網が 1 つ減る**: 今は、画像と HTML 以外を置こうとすると拒否される。この案では、正しい UTF-8 のテキストなら
何でも置ける。たとえば `kumo put ./* --link` のようにまとめて指定すると、`.env`、設定の JSON（このリポジトリの
`.secrets.production.json` のようなもの）、`.npmrc`、秘密鍵などの、共有するつもりのないテキストまで置かれ、
リンクが発行されうる。`*` を展開するのはシェルで、Git Bash などでは起こる。cmd や PowerShell は外部コマンドの
引数の `*` を展開しないので、CLI には `*` がそのまま渡り、「ファイルが見つかりません」になる。

#### 3.10.6 害への対策

| 対策 | 内容 | 効果 | 費用と欠点 | 判断 |
|---|---|---|---|---|
| A. 判定結果の表示 | `kumo put` の結果に、判定した形式を必ず出す（`Markdown → HTML`、`テキスト → HTML`、`HTML`、`SVG`、`画像`）。`--json` では `kind` | 誤判定にすぐ気づける | ごく小さい | 採る |
| B. 警告 | 拡張子と判定の食い違い（`.html`・`.htm`・`.svg`・`.xml` なのに Markdown、`.md` なのに HTML や SVG、`.txt`・`.csv`・`.json`・`.log`・ソースコードの拡張子なのに Markdown）、全体が JSON として解析できる、生の HTML、表示されない画像 | 置いた直後に気づける | 小さい。拡張子の一覧を持つ必要がある。置くことは止めない | 採る |
| C. `--as text`（逃げ道） | Markdown として解釈せず、HTML のエスケープをした全文を `<pre>` に入れ、同じテンプレート（meta の CSP 付き）で HTML にする。HTML・SVG・XML のソースにも使える | `.txt`・`.csv`・`.json`・ログ・コードを、そのままの形で見せられる | 小さい（20 行程度。markdown-it を使わない） | 採る |
| D. `--as markdown` | 先頭が HTML や SVG でも、テキストなら Markdown として扱う | 境界例 3・4 を回避できる | ごく小さい（C と同じオプションの別の値） | 採る |
| E. 秘密鍵の拒否 | `-----BEGIN … PRIVATE KEY-----` を含むテキストは、`--as` の指定にかかわらず拒否する | 最も危険な取り違えを止める | 小さい。公開鍵（`BEGIN PUBLIC KEY`）は止めない | 採る |
| F. 厳格モード | B の警告に当たるファイルは、`--as` を指定しない限り置かない | 取り違えをほぼ止められる | 警告の条件に拡張子を含むので、結局「拡張子による例外」になる。正しい `.txt` のメモにも毎回指定が要る | 採らない（§5 論点 16） |
| G. `--raw`（加工せずに置く） | テキストを `text/plain` のまま棚に置く | 原文がそのまま残る | 許可形式（`packages/shared/src/limits.ts`）と管理 API の変更、憲法の対象の再拡大が要る。「棚には画像と HTML だけ」が崩れる。C で目的を果たせる | 採らない |

逃げ道の名前は、`--raw` ではなく `--as text` を勧める。「raw」は「加工せずに置く」（G）と受け取られやすいが、
実際には HTML に変換して置くので、名前と動作がずれる。`--as` なら値で `markdown` と `text` を切り替えられ、
オプションが 1 つで済む（§5 論点 15）。

**残るリスク**: A〜E を入れても、秘密鍵以外の秘密（API のトークンなど）を含むテキストは置けてしまう。ただし、
置いただけでは誰にも見えない（憲法 II。リンクのないファイルは所有者しか見られない）。`--link` を付けても、
リンクを渡すまでは誰も開かない。気づいたら `kumo rm` で消せる（配信側のキャッシュの削除を含む）。この資料は、
このリスクを受け入れることを勧める（§5 論点 16）。

#### 3.10.7 拡張子で判定する案との比較

| | 拡張子で判定（前回の推奨） | 中身で判定（今回の案） |
|---|---|---|
| FR-002 との整合 | 例外が要る | 整合する（受け付ける形式の文言を広げるだけ） |
| 拡張子のない `README`、`.txt` に書いた Markdown | 置けない | 置ける |
| `.txt`・`.csv`・`.json`・ログ | 拒否される（安全網が残る） | Markdown として置かれ、見た目が崩れる。`--as text` で見やすくできる |
| 秘密を含むテキストを誤って置くリスク | 低い（`.md` だけが対象） | 上がる（A〜E と、リンクを渡すまで見えないことで抑える） |
| 誤判定 | `.md` の中身が HTML や SVG の場合だけ | §3.10.4 の例 4・6・10。どれも見た目の問題で、警告で気づける |
| 実装 | 拡張子の一覧と分岐 | テキストの条件（数十行）、警告、`--as` |
| 説明のしやすさ | 「`.md` なら Markdown」 | 「画像・SVG・HTML 以外の UTF-8 テキストは Markdown」 |

#### 3.10.8 FR-002 と憲法の文言

**FR-002 の改定案**（spec 002 で、spec 001 の FR-002 を置き換える）

> - **FR-002**: システムは、JPEG、PNG、GIF、WebP、AVIF、SVG の画像、1 枚で完結する HTML、Markdown 文書を受け付け
>   なければならない（MUST）。形式はファイルの中身で判定し、ファイル名の拡張子を判定に使ってはならない（MUST NOT）。
>   画像・SVG・HTML のいずれでもなく、全体がテキスト（FR-002a）であるファイルは、Markdown 文書とみなさなければ
>   ならない（MUST）。どれにも当たらない場合は、理由と受け付ける形式を示して拒否しなければならない（MUST）。
> - **FR-002a**: テキストとは、BOM と空白を除いて 1 文字以上あり、全体が正しい UTF-8 で、NUL と、タブ・改行・復帰・
>   改ページ以外の制御文字を含まないものをいう。UTF-16 と UTF-32 のファイルは、UTF-8 で保存し直すよう案内して
>   拒否しなければならない（MUST）。
> - **FR-002b**: Markdown 文書は、生の HTML を通さずに 1 枚で完結する HTML に変換し、スクリプトを禁止する CSP を文書に
>   含めてから置かなければならない（MUST）。所有者が明示した場合は、テキストを Markdown として解釈せず、そのまま
>   等幅で表示する HTML にして置けなければならない（MUST）。
> - **FR-002c**: システムは、判定した形式を結果に表示しなければならない（MUST）。判定した形式が拡張子から想定される
>   形式と異なる場合は、警告しなければならない（MUST）。秘密鍵を含むテキストは拒否しなければならない（MUST）。

spec 001 の Edge Cases「拡張子と中身が違う」は、「形式は中身で判定する。画像・SVG・HTML でないテキストは
Markdown として置き、拡張子との食い違いを警告する。どれにも当たらなければ拒否する」に改める。US1 の受け入れ
シナリオ 5（動画、HEIC、zip の拒否）はそのまま残す。spec 002 には、`.txt` を置くと Markdown として置かれて
警告が出るシナリオと、`--as text` でそのまま見せるシナリオを加える。

**憲法の改正案**（論点 1 の決定。v2.0.0 → v2.1.0、MINOR）

| 箇所 | 今の文言 | 改正案 |
|---|---|---|
| 前文 | 画像と HTML を置き、リンクで人に見せる・渡す。 | 画像、HTML、Markdown 文書を置き、リンクで人に見せる・渡す。 |
| IV（項目の追加） | — | Markdown 文書から変換した HTML には生の HTML を含めず、スクリプトを禁止する CSP を文書自体に持たせる（MUST）。 |
| VII の 1 項 | 対象は画像と 1 枚で完結する HTML、操作は CLI だけとする。 | 対象は画像、1 枚で完結する HTML、Markdown 文書とし、操作は CLI だけとする。Markdown 文書は kumo CLI で 1 枚で完結する HTML に変換して置き、棚に置く形式は画像と HTML に限る。 |
| 技術・運用上の制約 | 受け付けるファイルは JPEG、PNG、GIF、WebP、AVIF、SVG、HTML で、1 ファイル 100MB 未満とする。 | 受け付けるファイルは JPEG、PNG、GIF、WebP、AVIF、SVG、HTML、Markdown 文書で、1 ファイル 100MB 未満とする。形式は中身で判定し、画像・SVG・HTML のいずれでもない UTF-8 のテキストを Markdown 文書とみなす。 |
| 基準とする技術選定 | CLI: Node.js、commander、exiftool-vendored | CLI: Node.js、commander、exiftool-vendored、markdown-it |
| Sync Impact Report | — | 変更点（対象に Markdown 文書を追加、IV に変換時の防御を追加）、理由、影響する文書（spec 001 の FR-002 と Edge Cases、research R10、contracts/cli.md、README） |

MINOR とする理由: 原則の削除や再定義ではなく、対象の追加と、それに伴う防御の追加だから（憲法の Governance）。
棚に置く形式は画像と HTML のままなので、配信の原則（II と、IV の sandbox）は変わらない。

#### 3.10.9 結論（決定）

中身で判定する案を採る（§5 論点 2 で決定）。条件は次のとおり。

1. 今受け付けているものの判定は変えない（画像・SVG・HTML の判定を先に行う）。
2. テキストの条件は §3.10.2 のとおりとし、ファイル全体で検査する（UTF-8 の検査、NUL と制御文字の拒否、
   UTF-16 と UTF-32 の拒否、BOM の除去）。
3. XML 宣言付きの XML、PDF、秘密鍵は、明示的に拒否する。
4. 判定結果を必ず表示し、拡張子との食い違いなどを警告する。拡張子は警告にだけ使う。
   （2026-10-23 注記: 拡張子は、テキストを Markdown とテキストのどちらで見せるかの既定にも使うことにした。§5 論点 2 の注記）
5. 逃げ道として `--as text`（と `--as markdown`）を入れる。`--raw`（加工せずに置く）は作らない。
6. 秘密を含むテキストを誤って置くリスクは残る。リンクを渡すまで見えないことと警告を拠り所に、受け入れる。

拡張子で判定する案に比べると、FR-002 と一貫し、規則を一文で説明でき、拡張子のない `README` や `.txt` に書いた
Markdown も扱える。その代わりに生じる、Markdown でないテキストの見た目の崩れと、安全網が 1 つ減ることは、
A〜E で補う。

## 4. 推奨

### 4.1 推奨する段階と方式

- **方式**: A（kumo CLI で変換し、1 枚で完結する HTML として置く）
- **段階**: GFM（表、タスクリスト、取り消し線、自動リンク）。生の HTML は無効にする（論点 6、決定）
- **形式の判定**: 中身で判定し、拡張子は警告にだけ使う。画像・SVG・HTML のどれでもない UTF-8 のテキストは Markdown
  とみなす（§3.10.9）。逃げ道として `--as text`（等幅のまま見せる）と `--as markdown` を入れる
- **棚に置く名前**: 元の名前の末尾に `.html` を足す（論点 3、§3.7）
- **画像**: 外部の `https:` の画像だけを表示し、相対パスは警告する（論点 4、決定）
- **ライブラリ**: markdown-it 15.0.2 と `@mdit/plugin-tasklist` 1.1.3。どちらも版を完全に固定する。
  15.0.3（CPU を使いすぎる入力への修正）は、7 日の条件を満たす 2026-10-23 以降に上げる
- **防御**: §3.5 の層 1〜5。生成する HTML に meta の CSP（`default-src 'none'; img-src https:` ほか）を入れる
- **編集体験**: `kumo preview <file>` を同時に入れる
- **後回し**: 拡張段階。要望が出たら、ハイライト（CLI で静的に）、数式（Temml で MathML に）の順に検討する。
  Mermaid は、SVG を別のファイルとして置く運用で代える

### 4.2 理由

1. **既存の安全の仕組みをそのまま使える**。棚に置くのは HTML なので、sandbox、キャッシュ、取り消し、404 の扱いと、
   それらの自動テスト（憲法 VI）は変わらない。新しい危険は CLI の変換部分だけに生じ、そこは meta の CSP で外側から
   閉じられる。
2. **憲法に沿う**。重い処理は CLI で行い（V）、棚には共有用のコピーを置き（I）、書き込みの経路は変えない（III）。
3. **GFM の追加費用はほとんどない**。表、取り消し線、自動リンクは markdown-it に内蔵で、追加はタスクリストの小さな
   プラグイン 1 つだけ。最小で止めると、普段 GitHub や VS Code で書いている文書が崩れる。
4. **拡張段階は、費用とリスクの釣り合いが悪い**。Mermaid には 100MB 級の依存か、スクリプトの許可が必要になる。
   ハイライトと数式は安全に足せるが、今の目的（人に見せる・渡す）には必須ではない。
5. **markdown-it を選ぶ理由**: 既定で安全、依存が少ない、VS Code のプレビューと同じエンジン、拡張の余地がある。
   micromark でもよいが、拡張するときに remark と rehype への乗り換えが必要になる。
6. **形式を中身で判定する理由**: FR-002 と一貫し、規則を「画像・SVG・HTML 以外の UTF-8 テキストは Markdown」の一文で
   説明できる。今受け付けているファイルの判定は変わらない。Markdown でないテキストの見た目の崩れと、安全網が
   1 つ減ることは、判定結果の表示、警告、`--as text`、秘密鍵の拒否で補う（§3.10）。

### 4.3 実装計画（変更するファイル）

Spec Kit の流れ（`/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`）に乗せ、
`specs/002-markdown-share/` として進める想定である。

**文書**

| ファイル | 変更 |
|---|---|
| `.specify/memory/constitution.md` | §3.10.8 の改正案のとおり、前文、IV、VII、技術・運用上の制約、基準とする技術選定を改める。v2.1.0（MINOR）。Sync Impact Report を付ける（論点 1、決定） |
| `specs/002-markdown-share/*`（新規） | spec（§3.10.8 の FR-002、FR-002a〜c、ユーザーストーリー、`.txt` と `--as text` の受け入れシナリオ）、plan（依存を追加する理由と Constitution Check）、research（§3.10.2 と §3.10.3 の判定規則。research R10 を置き換える）、contracts（`kumo put` の `--as` と出力の `kind`・`warnings`、`kumo preview`）、quickstart、tasks |
| `specs/001-share-shelf-mvp/spec.md`、`research.md`、`contracts/cli.md` | FR-002、Edge Cases、R10、`kumo put` の手順 2 が spec 002 で置き換わったことを注記する。本文は 001 の時点の記録として残す |
| `README.md` | 冒頭の説明に Markdown を加える。使い方に `kumo put note.md --link`、`kumo put app.log --as text`、`kumo preview` を追加し、UTF-8 で保存することと、改行の扱い（§5 論点 7）を書く |
| `docs/runbook.md` | markdown-it のセキュリティ修正を取り込む手順（§5 論点 9） |

**コード（kumo CLI だけ）**

| ファイル | 変更 |
|---|---|
| `apps/cli/package.json` | `markdown-it` と `@mdit/plugin-tasklist` を `dependencies` に完全固定で追加する（`package-lock.json` も更新される） |
| `apps/cli/src/text.ts`（新規） | `checkText(bytes)`。§3.10.2 の検査（BOM の判定と除去、UTF-16 と UTF-32 の拒否、`fatal: true` での全体のデコード、制御文字、空白だけの検出）。結果は `{ ok: true, text }` か、落ちた条件と案内の文 |
| `apps/cli/src/sniff.ts` | §3.10.3 の順序に改める。`Sniffed` の `kind` に `markdown` を加え、そのときは変換前の `text` を返す。PDF、UTF-16 と UTF-32、XML 宣言とその他の DOCTYPE、秘密鍵の判定を加える。先頭の読み飛ばしを全体に広げる。`--as` の指定を引数で受ける。ファイル名は受け取らない（拡張子を判定に使わないことを型で保つ）。`ACCEPTED` の文に Markdown を加える |
| `apps/cli/src/markdown.ts`（新規） | `renderMarkdown(text, { fallbackTitle })` が `{ html: Uint8Array, warnings: string[] }` を返す。markdown-it の設定（`html: false`、`linkify: true`、`typographer: false`）、URL の許可リスト、タスクリスト、見出しに `id` を付けない、テンプレート（doctype、`lang="ja"`、charset、meta の CSP、`<meta name="referrer" content="no-referrer">`、viewport、`<title>`、CSS）、出力サイズの確認。`--as text` 用の `renderText(text, { title })`（エスケープして `<pre>` に入れる）。名前の規則 `sharedName(name)`（`.html` を足す。255 文字を超えるときは切り詰める）。生の HTML の検出（`html: true` の別のインスタンスで解析し、`html_block` と `html_inline` のトークンの行番号を集める。出力には使わない）と、画像の警告 |
| `apps/cli/src/markdown.ts` 内の CSS 定数 | 数 KB の CSS（読みやすい行の幅、表の横スクロール、コードブロック、`--as text` の `pre-wrap`、ダークモード）。外部のフォントは使わない |
| `apps/cli/src/prepare.ts`（新規、実装時に追加） | 判定と変換をまとめ、`kumo put` と `kumo preview` が同じものを使う（SC-005） |
| `apps/cli/src/warnings.ts`（新規） | 拡張子と判定の食い違い（警告に使う拡張子の一覧を持つ。§5 論点 20）と、全体が JSON として解析できるかの確認。判定には口を出さない |
| `apps/cli/src/commands/put.ts` | `--as <markdown\|text>` を加える。`kind` が `markdown` かテキストのときは変換し、`Content-Type: text/html; charset=utf-8` と `sharedName` の名前で送る。SHA-256 は変換後のバイト列で計算する。判定結果を必ず表示し（`--json` では `kind`）、警告を出す（`--json` では `warnings`）。複数のファイルでは、最後に形式ごとの件数と警告の件数を出す |
| `apps/cli/src/commands/preview.ts`（新規） | `kumo preview <file> [--as <markdown\|text>] [--output <path>] [--no-open]`。判定結果と警告を表示し、Markdown とテキストは同じ変換で一時ファイルに書いて開く。画像・SVG・HTML は判定結果だけを表示する。管理 API と設定ファイルを使わない |
| `apps/cli/src/commands/index.ts` | `registerPreview` を追加する |
| `apps/cli/src/main.ts` | 説明文を「画像、HTML、Markdown（HTML に変換）」に改める |
| `docs/verification/markdown-check.md`（新規） | §3.5 の攻撃パターンと、GFM のすべての記法を含む確認用の文書。SC-006 の隔離チェックページ（`docs/verification/isolation-check.html`）と同じ役割 |

判定の境界例（UTF-16、Shift_JIS、制御文字など）は、テストの中でバイト列を組み立てて作る（今の
`apps/cli/test/sniff.test.ts` の `bytes()` と同じやり方）。バイナリのフィクスチャーは増やさない。

**変更しないもの**: `apps/admin/**`、`apps/files/**`、`apps/admin/migrations/**`、`packages/shared/**`
（`limits.ts` の許可形式を含む）。

### 4.4 テストの方針

既存の CLI のテスト（Vitest を Node.js で実行。`apps/cli/vitest.config.ts`。管理 API は `apps/cli/test/helpers.ts`
の `mockApi` によるローカルの HTTP サーバー）に追加する。Worker のテストは変更しない。

| テスト | 内容 |
|---|---|
| `apps/cli/test/markdown.test.ts`（新規）: 記法 | 見出し、強調、リスト、リンク、コード、表（列の揃え）、タスクリスト（`disabled`）、取り消し線、自動リンク（日本語の句読点で終わる URL を含む）の期待出力 |
| 同: セキュリティ | §3.5 の攻撃パターンを 1 件ずつ変換し、出力に `<script`、`on…=` の属性、`javascript:`・`vbscript:`・`data:text` を含む `href` と `src`、`<iframe`、`<base`、`<meta http-equiv="refresh"` がないことを確かめる。meta の CSP が `<head>` の中で charset の直後にあり、本文からその前に何も入り込めないことを確かめる |
| 同: テンプレート | `<!doctype html>`、`<meta charset="utf-8">`、`<title>` のエスケープ（`<` や `&` を含む見出しやファイル名）、`lang` |
| 同: 決定性 | 同じ入力を 2 回変換すると、同じバイト列になる（同一判定のため） |
| 同: 上限と病的な入力 | 深い入れ子、`[`・`*`・`` ` `` の長い連続、巨大な表が、決めた時間（例: 2 秒）以内に終わる。出力が 100MB 以上なら送る前に拒否する |
| 同: BOM と改行 | BOM を取り除いた後の先頭の `#` が見出しになる。CRLF と CR が LF と同じ出力になる |
| 同: `renderText`（`--as text`） | `<`、`>`、`&`、`"`、`</pre>` を含む入力がエスケープされる。空白と改行がそのまま残る。meta の CSP が入る。HTML のソースを渡しても要素にならない |
| 同: 名前と警告 | `sharedName` が §3.7 の表のとおりになる。255 文字を超える名前の切り詰め。生の HTML の行番号、相対パスと `data:` の画像、外部のホスト名の警告 |
| `apps/cli/test/text.test.ts`（新規） | §3.10.2 の表を 1 行ずつ: 0 バイト、空白だけ、UTF-8 の BOM（取り除かれる）、UTF-16LE・UTF-16BE の BOM、UTF-32LE・UTF-32BE の BOM（UTF-16LE より先に判定される）、BOM のない UTF-16（NUL で落ちる）、Shift_JIS の「あ」（`82 A0`）、4096 バイトより後ろにだけ不正なバイトがあるファイル、NUL、VT・ESC・DEL・U+0085 の拒否、タブ・LF・CR・FF・CRLF の受け入れ、私用領域や U+200B の受け入れ。拒否の理由と案内の文も確かめる |
| `apps/cli/test/sniff.test.ts` | §3.10.3 の順序と、§3.10.4 の境界例を 1 件ずつ。既存の画像・HEIC・動画・zip・SVG・HTML のテストは**変更せずに**通ること（今受け付けているものの判定が変わらないことの確認）。36–38 行の `hello world` は、期待を拒否から Markdown に書き換え、拒否の例は NUL を含むバイト列に置き換える。PDF、XML 宣言、`<!DOCTYPE plist>`、4096 バイトを超えるコメントの後の `<html>`、秘密鍵（`BEGIN PRIVATE KEY`、`BEGIN OPENSSH PRIVATE KEY` は拒否、`BEGIN PUBLIC KEY` は通す）、`--as text` と `--as markdown` が順 5〜7 より優先されること、画像に `--as` を付けたときの拒否 |
| `apps/cli/test/warnings.test.ts`（新規） | 拡張子と判定の組み合わせ: `.md` なのに HTML・SVG、`.html` なのに Markdown、`.txt`・`.csv`・`.json`・`.log`・`.py` なのに Markdown は警告。`.md` で Markdown、拡張子なし、一覧にない拡張子は警告しない。JSON として解析できる入力への警告。警告が判定結果を変えないこと |
| `apps/cli/test/put.test.ts` | `kumo put note.md --link` で、`Content-Type: text/html; charset=utf-8`、名前 `note.md.html`、変換後の SHA-256 が送られる。`memo.txt` は `memo.txt.html` で送られ、警告が出る。`--as text`。判定結果の表示（人向けと `--json` の `kind`）と `warnings`。秘密鍵を含むファイルは送られず、残りは続行して終了コード 1。形式が混ざった複数ファイルの集計。重複の判定。原本の内容と更新日時が変わらない（FR-005。`apps/cli/test/exif.test.ts` と同じ確かめ方） |
| `apps/cli/test/preview.test.ts`（新規） | 一時ファイルを書き、管理 API を呼ばない。判定結果と警告を表示する。`--as` が効く。`--output` で既存のファイルを上書きしない |
| 手動（quickstart に追加） | `docs/verification/markdown-check.md` を置いてリンクを開き、PC と iPhone・Android のブラウザで次を確かめる: 表示が崩れない、リンクをたどれる、開発者ツールに CSP による遮断が記録される、スクリプトが何も動かない（SC-002、SC-006 にならう）。さらに、`.txt`・`.csv`・`.json` を置いて警告と見え方を確かめ、`--as text` で置き直す。Windows PowerShell 5.1 で `"# test" > ps.md` として作った（UTF-16LE の）ファイルが、案内付きで拒否されることを確かめる |

憲法 VI の必須項目（認証、上限、リンク、配信ヘッダー）の範囲は変わらない。Markdown と形式の判定の安全性は、
CLI の単体テストと手動の確認で守る。判定は、今受け付けているファイルの結果が変わらないこと（既存のテストを
そのまま通すこと）を、回帰の確認の中心に置く。

### 4.5 方式 B を選ぶ場合に追加で必要なこと（参考）

- 許可形式に `text/markdown; charset=utf-8` を加える（`packages/shared/src/limits.ts`）。憲法の改正も要る。
- 配信用 Worker に変換器を入れ、Markdown の応答だけ CSP を強める（`apps/files/src/index.ts`、`headers.ts`）。
  `Content-Length` は変換後の長さに、`ETag` は SHA-256 と変換器の版の組み合わせにする。`HEAD` でも変換が要る。
- 大きな文書で 10ms の CPU に収まることを計測する。収まらない場合の扱い（エラーにするか、変換せずに返すか）を決める。
- workerd 上のテスト（`apps/files/test/delivery.test.ts` の CSP の期待値など）を更新する。

## 5. 論点と決定

「状態」の意味: **決定** は所有者が決めたもの、**決定（一任）** は所有者に任されてこの資料で決めたもの。
論点 2 と 5、7〜20 は、所有者がこの資料の推奨どおりに決定した（2026-10-19）。

| # | 論点 | 状態 | 選択肢 | 結論 |
|---|---|---|---|---|
| 1 | 憲法の改正の要否と種類 | **決定** | (a) 改正しない、(b) PATCH（明確化）、(c) MINOR（受け付ける入力に Markdown を追加） | (c)。v2.0.0 から v2.1.0 にする。改正案の文言（前文、IV、VII、技術・運用上の制約、基準とする技術選定）は §3.10.8 |
| 2 | 形式の判定 | **決定** | (a) 拡張子 `.md`・`.markdown` と UTF-8 のテキスト（前回の推奨）、(b) `--markdown` の明示を必須にする、(c) 中身で判定し、画像・SVG・HTML のどれでもない UTF-8 のテキストを Markdown とみなす | (c)。前回の推奨 (a) は取り下げた。拡張子は警告にだけ使う。条件は §3.10.9 の 1〜6<br>2026-10-23 注記: 見直した（所有者の決定）。拡張子がテキストやソースコード（論点 20 の一覧のうち `.txt`、`.csv`、`.json`、`.log`、`.yml`、`.env`、ソースコードなど）のテキストは、`--as` がなければ `--as text` と同じ表示にする。拡張子が決めるのはこの既定だけで、受け付けるかどうかと形式の判定は (c) のまま |
| 3 | 棚に置くファイル名 | **決定（一任）** | (a) 拡張子を `.html` に置き換える、(b) 元の名前のまま、(c) 元の名前に `.html` を足す | (c)。`note.md` は `note.md.html`、`README` は `README.html` になる。中身で判定する方針では拡張子を解釈しないので、末尾に足す規則が最も単純で、元の名前も残る。理由の詳細は §3.7 |
| 4 | 文書内の画像 | **決定** | (a) 外部の `https:` の画像だけを許し、相対パスは警告、(b) 相対パスの画像を `data:` URI で埋め込む、(c) 画像は一切不可 | (a)。相対パスと `data:` の画像は表示されないことを警告する |
| 5 | 外部の画像と閲覧者のプライバシー | **決定**（論点 4 に従う） | meta の CSP の `img-src` | 論点 4 の決定により `img-src https:` とする。外部ホストの警告を出す |
| 6 | 生の HTML の一部を許すか（`<details>`、`<kbd>`、`<br>` など） | **決定** | 許さない / サニタイザーを足して許可リストで許す | 許さない（`html: false`）。将来見直すなら、sanitize-html と §3.5 の層 3 を組み合わせる |
| 7 | 改行の扱い（`breaks`） | **決定** | CommonMark どおり（単独の改行は改行にならない）/ 改行をすべて `<br>` にする | CommonMark どおり（GitHub のファイル表示と同じ）。日本語の間に空白が入って見えることがあるので、README に書き方を載せる。行ごとに見せたいテキストは `--as text` を使う |
| 8 | 見た目（CSS） | **決定** | 自作の小さな CSS / github-markdown-css などを埋め込む | 自作（数 KB）。依存を増やさず、ダークモードとスマートフォンに対応する |
| 9 | セキュリティ修正の取り込み | **決定** | `min-release-age=7` を守る / 修正版に限り例外とする | 方式 A では影響が CLI に閉じるので、7 日待つ。例外を設けるなら手順を runbook に書く |
| 10 | `<title>` の決め方 | **決定** | 最初の `#` の見出し / フロントマターの `title` / ファイル名 | 最初の h1。なければ元のファイル名をそのまま使う（拡張子を解釈しない方針に合わせ、拡張子も除かない）。`--as text` では元のファイル名 |
| 11 | 内容の差し替え（リンクを保ったまま更新） | **決定** | 作らない / 別の spec で検討する | 今回は作らない。置き直して、古いファイルを削除する運用にする |
| 12 | 拡張段階のどれを、いつ足すか | **決定** | ハイライト、数式、脚注、アンカー、Mermaid | 使い方を見て決める。足すなら CLI で静的に変換し、閲覧時の JS を使わない |
| 13 | `kumo preview` の開き方 | **決定** | 既定のブラウザで自動で開く / パスを表示するだけ | 自動で開く（Windows では `start`）。`--no-open` で止められるようにする |
| 14 | タスクリストの実装 | **決定** | `@mdit/plugin-tasklist` / 30 行程度の自前のルール | プラグイン。保守されていて、依存は 1 つ。自前にすれば依存は減るが、テストが増える |
| 15 | 逃げ道のオプションの名前 | **決定** | `--as <markdown\|text>` / `--text` と `--markdown` の 2 つ / `--raw` | `--as`。1 つのオプションで両方を指定できる。`--raw` は「加工せずに置く」と受け取られやすく、HTML に変換する実際の動作とずれる（§3.10.6） |
| 16 | 残るリスクの受け入れと厳格モード | **決定** | 警告に当たるファイルを止める厳格モードを作る / 作らずにリスクを受け入れる | 作らない。秘密を含むテキストを誤って置くリスクは、リンクを渡すまで見えないことと警告で受け入れる。運用で困ったら、`--strict` のような選べる形で後から足す（§3.10.6 の対策 F） |
| 17 | HTML コメントの扱い | **決定** | 文字として表示する / 出力から取り除く | 最初は表示して警告する。取り除くには、`html: true` で解析してコメントのトークンだけを捨てる処理が要り、生の HTML の扱い（論点 6）と絡むので後回しにする |
| 18 | JSON などを自動でテキスト表示にするか | **決定** | 中身で JSON と分かるものは自動で `--as text` と同じ扱いにする / しない | しない（警告と `--as text` で対応する）。規則を「テキストは Markdown」の一文に保つため。CSV やログは中身で確実には見分けられず、一部だけ自動にすると規則が分かりにくくなる<br>2026-10-23 注記: 中身での自動判定はしないまま、拡張子が `.json`・`.csv`・ログなどのものは既定でテキスト表示にした（論点 2 の注記）。拡張子のない JSON は今までどおり Markdown と警告 |
| 19 | 制御文字の許可範囲 | **決定** | §3.10.2 のとおり / もっと緩める | §3.10.2 のとおり（タブ・LF・CR・FF だけを許し、C1 も拒否する）。古いファイルで困る例が出たら見直す |
| 20 | 警告に使う拡張子の一覧 | **決定** | コードに小さな一覧を持つ / 警告しない | 小さな一覧を持つ（`.html`、`.htm`、`.svg`、`.xml`、`.txt`、`.csv`、`.tsv`、`.json`、`.log`、`.yml`、`.yaml`、`.toml`、`.ini`、`.env`、主なソースコード）。一覧にない拡張子は警告しない<br>2026-10-23 注記: 同じ一覧（`apps/cli/src/warnings.ts` の `GROUPS.text`）を、テキスト表示の既定にも使う（論点 2 の注記） |

## 付録 A. 確認した事実と出典（2026-10-19 時点）

**npm レジストリ**（`npm view` で確認。インストールはしていない。「7 日を満たす」は 2026-10-12 以前の公開を指す）

| パッケージ | 最新 | 7 日を満たす最新 | 備考 |
|---|---|---|---|
| markdown-it | 15.0.3（2026-10-16） | 15.0.2（2026-09-11） | 14 系は 14.3.2（2026-09-12）。15.0.2 は依存 6、展開時 2.0MB |
| @mdit/plugin-tasklist | 1.1.3（2026-09-26） | 同左 | peer: markdown-it ^15.0.2。依存は @mdit/helper だけ |
| @mdit/plugin-footnote | 1.1.2（2026-09-26） | 同左 | peer: markdown-it ^15.0.2 |
| markdown-it-task-lists | 2.1.1（2018-03-06） | 同左 | 更新が止まっている |
| markdown-it-footnote / markdown-it-anchor | 4.0.0（2023-12-06）/ 10.0.0（2026-09-05） | 同左 | |
| micromark / micromark-extension-gfm | 4.0.3（2026-09-26）/ 3.0.0（2023-06-26） | 同左 | |
| marked | 18.1.1（2026-10-12） | 18.1.0（2026-10-05） | |
| sanitize-html | 2.18.1（2026-10-14） | 2.18.0（2026-09-30） | |
| dompurify | 3.4.17（2026-10-12） | 3.4.16（2026-09-23） | |
| shiki | 4.5.0（2026-10-01） | 同左 | `@shikijs/langs` は展開時 8.7MB、`@shikijs/themes` は 1.5MB |
| highlight.js | 11.12.0（2026-08-12） | 同左 | |
| katex / temml | 0.19.0（2026-10-01）/ 0.14.0（2026-10-08） | 同左 | |
| mermaid | 12.2.0（2026-10-13） | 12.1.0（2026-10-02） | 展開時 122MB。mermaid-cli 12.0.0 は peer に puppeteer ^25 |

**bundlephobia**（min / gzip、依存の数）: markdown-it 14.3.2 は 123.9KB / 50.8KB（6）、marked 18.1.0 は 44.2KB / 13.3KB
（0）、micromark 4.0.3 は 52.1KB / 14.8KB（18）、micromark-extension-gfm 3.0.0 は 22.6KB / 7.0KB（8）、
dompurify 3.4.16 は 27.6KB / 10.9KB、katex 0.19.0 は 253.8KB / 75.2KB、temml 0.14.0 は 200.6KB / 58.4KB、
highlight.js 11.12.0（全言語）は 901.4KB / 299.9KB、shiki 4.5.0（入口だけで、文法とテーマは別）は 204.3KB / 63.5KB。
markdown-it 15.0.2、markdown-it-footnote、sanitize-html、mermaid は、bundlephobia の回数制限（429）で取得できなかった。
markdown-it 15 系の大きさは 14.3.2 と同程度と見込んでいるが、採用時に `vite build` などで実測する。

**文書とソース**

- markdown-it `docs/safety.md`: 生の HTML を有効にしなければ、サニタイザーなしで安全な出力になる。`javascript:`、
  `vbscript:`、`file:`、`data:`（一部の画像を除く）を拒否する。プラグインが利用者の入力から `id` や `name` を作る場合は
  接頭辞を付ける（DOM clobbering）。
- markdown-it のソース: `src/presets/default.ts`（`html: false`）、`src/presets/commonmark.ts`（`html: true`）、
  `src/markdownit.ts`（`BAD_PROTO_RE`、`GOOD_DATA_RE`、`validateLink`）、`src/rules_block/table.ts`（列の揃えの
  `style`）、`CHANGELOG.md`（14.1.1〜15.0.3 の Security の項目）。https://github.com/markdown-it/markdown-it
- micromark の README: `allowDangerousHtml` と `allowDangerousProtocol` は既定で `false`。
- marked の README: 「Marked does not sanitize the output HTML」。
- VS Code `extensions/markdown-language-features/src/markdownEngine.ts`: markdown-it を `html: true` と highlight.js で
  使い、linkify の `fuzzyLink` を無効にしている。https://github.com/microsoft/vscode
- CSP 仕様（meta 要素）: `report-uri`、`frame-ancestors`、`sandbox` は meta 要素では使えない。
  https://w3c.github.io/webappsec-csp/#meta-element
- Mermaid の XSS の報告: GHSA-7rqq-prvp-x9jh、GHSA-8gwm-58g9-j8pw（2025-08）、GHSA-p3rp-vmj9-gv6v（2021-12）など。
  https://github.com/mermaid-js/mermaid/security/advisories
- Cloudflare Workers Limits（2026-10-12 更新）: 無料プランの CPU は 1 回 10ms、スクリプトは非圧縮で 64MiB
  （圧縮後の上限はない）、起動は 1 秒。https://developers.cloudflare.com/workers/platform/limits/
- Temml の README: LaTeX を MathML Core に変換する、軽量なライブラリ。
- Windows PowerShell 5.1 の about_Character_Encoding: 「`Out-File` and the redirection operators `>` and `>>` create
  UTF-16LE」。PowerShell 6 以降の既定は BOM なしの UTF-8。
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1
- CommonMark Spec 0.31.2: バックスラッシュでエスケープできるのは ASCII の記号だけ（2.4）、setext 見出し（4.3）、
  リンクの参照定義、空白として扱う文字に改ページ（U+000C）を含むこと。https://spec.commonmark.org/0.31.2/
- 既存の判定とテスト: `apps/cli/src/sniff.ts`（先頭 4096 バイトを壊れたバイトを許して読む。どれにも当たらないテキストは
  70 行で拒否）、`apps/cli/test/sniff.test.ts` 36–38 行（`hello world` の拒否を期待する唯一のテスト）、
  `apps/cli/test/put.test.ts`（失敗の例には動画を使っており、この案の影響を受けない）。
