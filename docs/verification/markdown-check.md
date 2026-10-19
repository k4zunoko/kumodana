<!-- markdownlint-disable -->
# kumodana Markdown の確認

このファイルを `kumo preview docs/verification/markdown-check.md` で開くか、`kumo put docs/verification/markdown-check.md --link`
で置いてリンクを開き、各節の「期待」どおりかを確かめる（specs/002-markdown-share の quickstart、SC-001、SC-002）。
先頭の HTML コメントは、文字として表示されるのが正しい。

## 1. CommonMark の基本

段落の中の *強調* と **太字** と `インラインコード`。
この行は前の行とつながって表示される（単独の改行は改行にならない）。

行末に空白 2 つで改行する。  
ここは次の行に表示される。

- 箇条書き 1
- 箇条書き 2
  - 入れ子
1. 番号付き 1
2. 番号付き 2

> 引用の段落

```js
const message = "コードブロック";
```

---

[外部へのリンク](https://example.com) と [ページ内のリンク](#1-commonmark-の基本) と <https://example.com/autolink>。

期待: 見出し、強調、太字、コード、リスト、入れ子、引用、コードブロック、水平線、リンクが整形される。
ページ内のリンクは、見出しに id を付けないので移動しない。

## 2. GFM

| 左寄せ | 中央 | 右寄せ |
|:---|:---:|---:|
| a | b | c |
| とても長いセルの内容がスマートフォンで横にはみ出すかどうか | 2 | 3 |

- [ ] 未完了のタスク
- [x] 完了したタスク

~~取り消し線~~ と、URL の自動リンク https://example.com/path、句読点で終わる。

期待: 表は列ごとに揃い、スマートフォンでは表だけが横にスクロールする。チェックボックスは操作できない。
取り消し線が引かれ、URL はリンクになり、「、」はリンクに含まれない。

## 3. 画像

![外部の https の画像](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)

![相対パスの画像](./missing.png)

![http の画像](http://example.com/image.png)

![data の画像](data:image/png;base64,iVBORw0KGgo=)

期待: 外部の https の画像だけが表示される。相対パスと http の画像は表示されず、data の画像は文字のまま表示される。
`kumo put` と `kumo preview` は、表示されない画像、外部の画像のホスト、使えない URL を警告する。

## 4. 生の HTML（文字として表示される）

<p align="center">中央寄せの段落</p>

<details><summary>折りたたみ</summary>中身</details>

<script>alert("script タグ")</script>

<img src="x" onerror="alert('onerror')">

<svg onload="alert('svg onload')"></svg>

<iframe src="https://example.com"></iframe>

<style>body { background: red; }</style>

<meta http-equiv="refresh" content="0;url=https://example.com">

<base href="https://example.com/">

<a href="javascript:alert('a タグ')">a タグのリンク</a>

期待: どれも要素にならず、タグがそのまま文字として表示される。ダイアログは一度も出ない。背景は赤くならず、
別のページへ移動しない。

## 5. 危険なリンク（リンクにならない）

[javascript](javascript:alert(1))、[大文字](JAVASCRIPT:alert(1))、[タブ入り](jav&#x09;ascript:alert(1))、
[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)、[vbscript](vbscript:msgbox(1))、
<javascript:alert(1)>、[タイトルの引用符](https://example.com "a&quot; onmouseover=&quot;alert(1)")

```js"><script>alert("コードフェンスの言語名")</script>
console.log("ここはコードとして表示される");
```

| 表のセル |
|---|
| <script>alert("表のセル")</script> |

期待: javascript・data・vbscript のリンクは文字のまま表示される。「タブ入り」はリンクになるが、押しても
スクリプトは動かず、相対 URL として扱われて「見つからない」になる。タイトルの引用符は属性を壊さない。
開発者ツールのコンソールに、スクリプトが動いた形跡（ダイアログ、エラー以外の出力）がない。

## 6. 日本語の折り返し

日本語の長い段落が、スマートフォンの画面の幅で自然に折り返されることを確かめる。とても長い英数字の連続も折り返される: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0123456789

期待: 横にスクロールせずに読める。ダークモードの端末では、暗い背景で表示される。
