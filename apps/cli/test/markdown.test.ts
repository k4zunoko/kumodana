import { describe, expect, it } from "vitest";
import { DOCUMENT_CSP, isAllowedUrl, type Rendered, renderMarkdown, renderText, sharedName } from "../src/markdown.ts";
import { checkText } from "../src/text.ts";

const decode = (r: Rendered) => new TextDecoder().decode(r.html);
const body = (r: Rendered) => {
	const html = decode(r);
	return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
};
const md = (text: string, fallbackTitle = "note.md") => renderMarkdown(text, { fallbackTitle });
/**
 * CPU time of this test process in milliseconds. Vitest runs each test file in its own process, so other test files
 * running in parallel do not count, unlike wall-clock time.
 */
const ms = (fn: () => void) => {
	const start = process.cpuUsage();
	fn();
	const used = process.cpuUsage(start);
	return (used.user + used.system) / 1000;
};

describe("renderMarkdown: CommonMark and GFM (FR-008)", () => {
	it("renders the CommonMark basics", () => {
		const b = body(
			md("# 見出し\n\n本文 *強調* と **太字**。\n\n- a\n- b\n\n1. one\n2. two\n\n> 引用\n\n`code` と\n\n```\nblock\n```\n\n---\n\n[リンク](https://example.com)"),
		);
		expect(b).toContain("<h1>見出し</h1>");
		expect(b).toContain("<em>強調</em>");
		expect(b).toContain("<strong>太字</strong>");
		expect(b).toContain("<ul>\n<li>a</li>");
		expect(b).toContain("<ol>\n<li>one</li>");
		expect(b).toContain("<blockquote>\n<p>引用</p>");
		expect(b).toContain("<code>code</code>");
		expect(b).toContain("<pre><code>block\n</code></pre>");
		expect(b).toContain("<hr>");
		expect(b).toContain('<a href="https://example.com">リンク</a>');
	});

	it("renders tables with column alignment", () => {
		const b = body(md("| 左 | 中 | 右 |\n|:---|:--:|---:|\n| a | b | c |"));
		expect(b).toContain("<table>");
		expect(b).toContain('<th style="text-align:left">左</th>');
		expect(b).toContain('<td style="text-align:center">b</td>');
		expect(b).toContain('<td style="text-align:right">c</td>');
	});

	it("renders task lists as checkboxes that cannot be changed", () => {
		const b = body(md("- [ ] 未完了\n- [x] 完了\n- 普通の項目"));
		expect(b).toMatch(/<input type="checkbox" class="task-list-item-checkbox" id="task-item-0" disabled="disabled"> 未完了/);
		expect(b).toMatch(/<input type="checkbox"[^>]*checked="checked" disabled="disabled"> 完了/);
		expect(b).toContain("<li>普通の項目</li>");
		expect(b).not.toContain("<label");
	});

	it("renders strikethrough and autolinks that end at Japanese punctuation", () => {
		const b = body(md("~~取り消し~~ と https://example.com/a、続き。"));
		expect(b).toContain("<s>取り消し</s>");
		expect(b).toContain('<a href="https://example.com/a">https://example.com/a</a>、続き。');
	});

	it("keeps single line breaks as soft breaks (CommonMark)", () => {
		expect(body(md("一行目\n二行目"))).toContain("<p>一行目\n二行目</p>");
	});
});

describe("renderMarkdown: safety (FR-009, FR-010)", () => {
	const vectors = [
		"<script>alert(1)</script>",
		"<img src=x onerror=alert(1)>",
		"[x](javascript:alert(1))",
		"[x](JAVASCRIPT:alert(1))",
		"[x](jav&#x09;ascript:alert(1))",
		"[x](  javascript:alert(1))",
		"[x](vbscript:msgbox(1))",
		"[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
		"[x](file:///C:/Windows/win.ini)",
		"<javascript:alert(1)>",
		'[x](https://example.com "a\\" onmouseover=\\"alert(1)")',
		'[x](https://example.com "a&quot; onmouseover=&quot;alert(1)")',
		'![x](https://example.com/a.png "x\\" onerror=\\"alert(1)")',
		'```js"><script>alert(1)</script>\ncode\n```',
		"| a |\n|---|\n| <script>alert(1)</script> |",
		'<meta http-equiv="refresh" content="0;url=https://example.com">',
		'<base href="https://evil.example/">',
		"<style>body{background:url(https://evil.example)}</style>",
		'<iframe src="https://evil.example"></iframe>',
		"<svg onload=alert(1)>",
		'<a href="javascript:alert(1)">x</a>',
		"<!-- <script>alert(1)</script> -->",
	];

	it("never emits active HTML from the document", () => {
		for (const vector of vectors) {
			const b = body(md(vector));
			// Quoted attribute values are escaped text; look for elements and attributes outside them.
			const outside = b.replace(/="[^"]*"/g, '=""');
			expect(outside, vector).not.toMatch(/<(script|iframe|base|meta|style|svg|object|embed|form)\b/i);
			expect(outside, vector).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
			expect(b, vector).not.toMatch(/(href|src)\s*=\s*"\s*(javascript|vbscript|data|file):/i);
		}
	});

	it("keeps quotes in link titles inside the attribute", () => {
		const expected = '<a href="https://example.com" title="a&quot; onmouseover=&quot;alert(1)">x</a>';
		expect(body(md('[x](https://example.com "a\\" onmouseover=\\"alert(1)")'))).toContain(expected);
		expect(body(md('[x](https://example.com "a&quot; onmouseover=&quot;alert(1)")'))).toContain(expected);
	});

	it("shows raw HTML and comments as text", () => {
		expect(body(md("<script>alert(1)</script>"))).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(body(md("<!-- TOC -->\n# Title"))).toContain("&lt;!-- TOC --&gt;");
		expect(body(md('<p align="center">logo</p>'))).toContain("&lt;p align=&quot;center&quot;&gt;logo&lt;/p&gt;");
	});

	it("only allows http, https, mailto, and URLs without a scheme", () => {
		for (const url of ["https://a.example", "http://a.example", "mailto:a@example.com", "./b.md", "#section", "/x", "jav%09ascript:x"]) {
			expect(isAllowedUrl(url), url).toBe(true);
		}
		for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:x", "data:image/png;base64,AA", "vbscript:x", "file:///c", "blob:x", "ftp://a"]) {
			expect(isAllowedUrl(url), url).toBe(false);
		}
	});

	it("puts the CSP right after the charset, before anything from the document", () => {
		const html = decode(md("<title>x</title>\n# A"));
		expect(
			html.startsWith(
				`<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">\n`,
			),
		).toBe(true);
		expect(DOCUMENT_CSP).toBe("default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
		expect(html.indexOf("<main")).toBeGreaterThan(html.indexOf("</head>"));
		expect(html).toContain('<meta name="referrer" content="no-referrer">');
		expect(html.match(/<meta http-equiv/g)).toHaveLength(1);
	});
});

describe("renderMarkdown: title, determinism, and input forms (FR-013, FR-015)", () => {
	it("uses the first h1 as the title, else the file name, escaped", () => {
		expect(md("intro\n\n## h2\n\n# A < B & `C`").title).toBe("A < B & C");
		expect(decode(md("# A < B & `C`"))).toContain("<title>A &#60; B &#38; C</title>");
		expect(md("no heading", "メモ.md").title).toBe("メモ.md");
		expect(decode(md("x", "a<b>.md"))).toContain("<title>a&#60;b&#62;.md</title>");
	});

	it("produces the same bytes for the same input", () => {
		const text = "# 同じ\n\n- [ ] a\n\n| x |\n|---|\n| y |\n";
		expect(md(text).html).toEqual(md(text).html);
	});

	it("treats CRLF like LF", () => {
		expect(md("# A\r\n\r\nb\r\nc\r\n").html).toEqual(md("# A\n\nb\nc\n").html);
	});

	it("renders a heading at the start of a file that had a UTF-8 BOM", () => {
		const checked = checkText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# 見出し")]));
		if (!checked.ok) throw new Error(checked.reason);
		expect(body(md(checked.text))).toContain("<h1>見出し</h1>");
	});
});

describe("renderMarkdown: warnings (FR-011, FR-019)", () => {
	it("reports links whose scheme is refused", () => {
		const { warnings } = md("[x](javascript:alert(1)) and [y](https://ok.example)");
		expect(warnings).toEqual([expect.stringContaining("javascript:alert(1)")]);
	});

	it("does not count HTML inside code as raw HTML", () => {
		expect(md("`<b>` and\n\n```\n<div>\n```\n\n    <span>indented</span>").warnings).toEqual([]);
	});

	it("has no warnings for a plain document", () => {
		expect(md("# A\n\ntext [link](./b.md)").warnings).toEqual([]);
	});

	it("reports the lines with raw HTML, including comments", () => {
		const { warnings } = md("<!-- TOC -->\n# A\n\ntext <b>bold</b>\nmore <i>x</i>\n\n<div>\nblock\n</div>");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("1、4、5、7 行目");
	});

	it("reports images that are not shown, the hosts of external images, and refused URLs", () => {
		const { warnings } = md(
			"![a](https://img.example/a.png) ![b](./b.png) ![c](data:image/png;base64,AAAA) ![d](http://img.example/d.png) ![e](https://cdn.example/e.png)",
		);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toContain("表示されない画像が 2 個");
		expect(warnings[0]).toContain("./b.png");
		expect(warnings[0]).toContain("http://img.example/d.png");
		expect(warnings[1]).toContain("img.example、cdn.example");
		expect(warnings[2]).toContain("data:image/png");
	});

	it("does not show images other than external https ones", () => {
		const b = body(md("![a](https://img.example/a.png) ![b](./b.png)"));
		expect(b).toContain('<img src="https://img.example/a.png" alt="a">');
		// The relative image stays in the page, but the document CSP (img-src https:) keeps it from loading.
		expect(DOCUMENT_CSP).toContain("img-src https:;");
	});
});

/**
 * Guards against runaway (for example quadratic) parsing. The limits are loose on purpose: test files run in
 * parallel and a busy machine slows everything down. SC-006 itself (1MB within 2 seconds on an idle PC) is measured
 * by hand; see specs/002-markdown-share/quickstart.md.
 */
describe("renderMarkdown: no runaway parsing", () => {
	it("handles pathological input quickly", () => {
		const inputs = [
			"[".repeat(50_000),
			`${"*".repeat(50_000)}a`,
			"`".repeat(50_000),
			`${"> ".repeat(10_000)}x`,
			`${"- ".repeat(5_000)}x`,
			"<!-- ".repeat(20_000),
			`${"| a ".repeat(1_000)}|\n${"|---".repeat(1_000)}|\n${`${"| x ".repeat(1_000)}|\n`.repeat(50)}`,
		];
		for (const input of inputs) expect(ms(() => md(input)), input.slice(0, 12)).toBeLessThan(5_000);
	});

	it("converts a 1MB document in seconds, not minutes", () => {
		const section = (i: number) =>
			`## 節 ${i}\n\n本文の段落です。**太字** と [リンク](https://example.com/${i}) と \`code\`。\n- [ ] タスク\n- 項目\n\n| a | b |\n|---|---|\n| ${i} | x |\n\n\`\`\`\nconst x = ${i};\n\`\`\`\n\n`;
		// 1MB as a file: count UTF-8 bytes, not characters.
		const encoder = new TextEncoder();
		let text = "# 大きな文書\n\n";
		let bytes = encoder.encode(text).length;
		for (let i = 0; bytes < 1_000_000; i++) {
			const next = section(i);
			text += next;
			bytes += encoder.encode(next).length;
		}
		expect(ms(() => md(text))).toBeLessThan(10_000);
	});
});

describe("renderText (FR-012)", () => {
	it("escapes everything and keeps whitespace and line breaks", () => {
		const b = body(renderText("a  b\n\tc <b>&\"'</b></pre>\n", { title: "app.log" }));
		expect(b).toBe('<main class="text">\n<pre>\na  b\n\tc &#60;b&#62;&#38;&#34;&#39;&#60;/b&#62;&#60;/pre&#62;\n</pre>\n');
	});

	it("keeps a leading newline of the text", () => {
		expect(body(renderText("\nfirst", { title: "x" }))).toContain("<pre>\n\nfirst</pre>");
	});

	it("uses the same CSP and the file name as the title", () => {
		const html = decode(renderText("x", { title: "a<b>.log" }));
		expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">`);
		expect(html).toContain("<title>a&#60;b&#62;.log</title>");
		expect(renderText("x", { title: "t" }).warnings).toEqual([]);
	});
});

describe("sharedName (FR-014)", () => {
	it("appends .html to the original name", () => {
		expect(sharedName("note.md")).toBe("note.md.html");
		expect(sharedName("README")).toBe("README.html");
		expect(sharedName("memo.txt")).toBe("memo.txt.html");
		expect(sharedName("page.html")).toBe("page.html.html");
	});

	it("shortens the original name so the result fits in 255 characters", () => {
		const long = `${"あ".repeat(260)}.md`;
		const name = sharedName(long);
		expect([...name]).toHaveLength(255);
		expect(name.endsWith(".html")).toBe(true);
		expect(sharedName("a".repeat(250))).toBe(`${"a".repeat(250)}.html`);
		expect(sharedName("😀".repeat(251))).toBe(`${"😀".repeat(250)}.html`);
	});
});
