import { tasklist } from "@mdit/plugin-tasklist";
import markdownit, { type MarkdownIt, type Token } from "markdown-it";

/**
 * Converts Markdown documents and plain text into self-contained HTML pages (specs/002-markdown-share research
 * M3, M4, M6, M7). The shelf only ever stores the resulting HTML.
 */

/** Placed right after `<meta charset>` so that it governs everything in the page (constitution IV, FR-010). */
export const DOCUMENT_CSP =
	"default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** `files.name` holds up to 255 characters (code points). */
export const MAX_NAME_CHARS = 255;
const HTML_SUFFIX = ".html";

export type Rendered = { html: Uint8Array; title: string; warnings: string[] };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(?:https?|mailto):/i;

/** Links and images may use http, https, or mailto, or no scheme at all (relative paths and `#fragments`). */
export function isAllowedUrl(url: string): boolean {
	const value = url.trim();
	return SCHEME.test(value) ? SAFE_SCHEME.test(value) : true;
}

/** URLs the renderer refused while parsing the current document (collected for a warning). */
let refused: Set<string> | undefined;

function createRenderer(): MarkdownIt {
	const md = markdownit({ html: false, linkify: true, typographer: false });
	md.validateLink = (url) => {
		const allowed = isAllowedUrl(url);
		if (!allowed) refused?.add(url);
		return allowed;
	};
	// Checkboxes get fixed ids (`task-item-N`) that never come from the document; no labels are added.
	md.use(tasklist, { disabled: true, label: false });
	return md;
}

/**
 * Finds raw HTML so that the owner can be warned; its output is never used. Only the rules that decide whether
 * something is HTML are enabled (code blocks, fences, code spans, escapes), which keeps a second pass cheap.
 */
function createHtmlDetector(): MarkdownIt {
	const md = markdownit("zero", { html: true });
	md.block.ruler.enable(["code", "fence", "html_block"]);
	md.inline.ruler.enable(["backticks", "escape", "html_inline", "newline"]);
	return md;
}

/** Renders pages. Raw HTML stays text (FR-009) and only safe URLs become links or images (FR-010). */
const renderer = createRenderer();
const htmlDetector = createHtmlDetector();

const encoder = new TextEncoder();

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The name a converted file gets on the shelf: the original name plus `.html`, shortened to fit (FR-014). */
export function sharedName(name: string): string {
	const chars = [...name];
	const room = MAX_NAME_CHARS - HTML_SUFFIX.length;
	return `${chars.length > room ? chars.slice(0, room).join("") : name}${HTML_SUFFIX}`;
}

/** Converts a Markdown document (FR-007 to FR-011, FR-013, FR-015). `text` must already have passed `checkText`. */
export function renderMarkdown(text: string, options: { fallbackTitle: string }): Rendered {
	const env = {};
	refused = new Set();
	let tokens: Token[];
	let urls: string[];
	try {
		tokens = renderer.parse(text, env);
	} finally {
		urls = [...refused];
		refused = undefined;
	}
	const body = renderer.renderer.render(tokens, renderer.options, env);
	const title = firstHeading(tokens) ?? options.fallbackTitle;
	const warnings = [...rawHtmlWarnings(htmlDetector.parse(text, {})), ...imageWarnings(tokens), ...refusedWarnings(urls)];
	return { html: encoder.encode(page(title, "markdown", body)), title, warnings };
}

/** Shows text as it is, in a monospace block (FR-012). */
export function renderText(text: string, options: { title: string }): Rendered {
	// The HTML parser drops one newline right after <pre>, so add one to keep a leading newline of the text.
	const body = `<pre>\n${escapeHtml(text)}</pre>\n`;
	return { html: encoder.encode(page(options.title, "text", body)), title: options.title, warnings: [] };
}

function page(title: string, kind: "markdown" | "text", body: string): string {
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="${kind}">
${body}</main>
</body>
</html>
`;
}

function inlineText(token: Token | undefined): string {
	return (token?.children ?? [])
		.map((child) => (child.type === "text" || child.type === "code_inline" ? child.content : child.type === "softbreak" ? " " : ""))
		.join("")
		.trim();
}

function firstHeading(tokens: Token[]): string | undefined {
	const index = tokens.findIndex((t) => t.type === "heading_open" && t.tag === "h1");
	if (index < 0) return undefined;
	const text = inlineText(tokens[index + 1]);
	return text === "" ? undefined : text;
}

function lineList(lines: number[]): string {
	const shown = `${lines.slice(0, 5).join("、")} 行目`;
	return lines.length > 5 ? `${shown}ほか ${lines.length - 5} か所` : shown;
}

/** Lines where the document has raw HTML (including comments), which the page shows as text. */
function rawHtmlWarnings(tokens: Token[]): string[] {
	const lines = new Set<number>();
	for (const token of tokens) {
		if (token.type === "html_block" && token.map) lines.add(token.map[0] + 1);
		if (token.type === "inline" && token.map && token.children) {
			let line = token.map[0] + 1;
			for (const child of token.children) {
				if (child.type === "softbreak" || child.type === "hardbreak") line++;
				if (child.type === "html_inline") lines.add(line);
			}
		}
	}
	if (lines.size === 0) return [];
	const sorted = [...lines].sort((a, b) => a - b);
	return [`生の HTML（コメントを含む）は、要素にならず文字として表示されます（${lineList(sorted)}）。`];
}

function* images(tokens: Token[]): Generator<Token> {
	for (const token of tokens) {
		if (token.type === "image") yield token;
		if (token.children) yield* images(token.children);
	}
}

function shorten(url: string): string {
	return url.length > 60 ? `${url.slice(0, 57)}...` : url;
}

/** Links and images with a refused scheme stay as text (FR-010). */
function refusedWarnings(urls: string[]): string[] {
	if (urls.length === 0) return [];
	return [
		`使えない URL（javascript:、data: など）は、リンクや画像にならず文字のまま表示されます: ${urls.slice(0, 3).map(shorten).join("、")}${urls.length > 3 ? " ほか" : ""}`,
	];
}

/** Only external https images are shown (FR-011); external hosts learn the viewer's IP address. */
function imageWarnings(tokens: Token[]): string[] {
	const hidden: string[] = [];
	const hosts = new Set<string>();
	for (const image of images(tokens)) {
		const src = String(image.attrGet("src") ?? "");
		if (src === "") continue; // A refused URL, reported by refusedWarnings.
		if (/^https:\/\//i.test(src)) {
			try {
				hosts.add(new URL(src).host);
				continue;
			} catch {
				// An unparsable URL is not shown either.
			}
		}
		hidden.push(shorten(src));
	}
	const warnings: string[] = [];
	if (hidden.length > 0) {
		warnings.push(
			`表示されない画像が ${hidden.length} 個あります（外部の https の画像だけを表示します）: ${hidden.slice(0, 3).join("、")}${hidden.length > 3 ? " ほか" : ""}`,
		);
	}
	if (hosts.size > 0) {
		warnings.push(`外部の画像を読み込みます。閲覧者の IP アドレスが次のサイトに伝わります: ${[...hosts].join("、")}`);
	}
	return warnings;
}

/** A small stylesheet with no external fonts (research M4). */
const CSS = `
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--code:#151b23;--link:#4493f8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);line-height:1.75;font-family:system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif}
main{max-width:48rem;margin:0 auto;padding:1.5rem 1rem 4rem;overflow-wrap:anywhere}
main.text{max-width:72rem}
a{color:var(--link)}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.8em 0 .7em}
h1{font-size:1.9em;margin-top:.4em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
h3{font-size:1.2em}
p,ul,ol,blockquote,pre,table{margin:0 0 1em}
ul,ol{padding-left:1.75em}
li+li{margin-top:.25em}
blockquote{margin-left:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
img{max-width:100%;height:auto}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,"BIZ UDGothic",monospace;font-size:.9em}
code{background:var(--code);padding:.15em .35em;border-radius:4px}
pre{background:var(--code);padding:1em;border-radius:6px;overflow-x:auto;line-height:1.5}
pre code{background:none;padding:0;font-size:inherit}
main.text pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}
th,td{border:1px solid var(--line);padding:.4em .8em}
th{background:var(--code)}
.task-list-item{list-style:none}
.task-list-item-checkbox{margin:0 .4em 0 -1.4em;vertical-align:middle}
`;
