import type { Kind } from "./sniff.ts";

/**
 * Warnings about how a file was detected (FR-019, specs/002-markdown-share research M8), and the default display of text
 * with a text or code extension (`showsAsText`). The extension is only used here and never decides whether a file is
 * accepted or whether it is an image, SVG, HTML, or text (FR-001).
 */

type Group = "markdown" | "html" | "svg" | "image" | "text";

const GROUPS: Record<Group, string[]> = {
	markdown: [".md", ".markdown", ".mdown", ".mkd", ".mkdn"],
	html: [".html", ".htm", ".xhtml"],
	svg: [".svg"],
	image: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic"],
	text: [
		".txt", ".text", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".log", ".xml", ".yml", ".yaml", ".toml",
		".ini", ".cfg", ".conf", ".env", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".py", ".rb",
		".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".ps1", ".bat",
		".cmd", ".sql", ".css", ".scss", ".vue",
	],
};

const GROUP_OF = new Map<string, Group>(
	(Object.entries(GROUPS) as [Group, string[]][]).flatMap(([group, extensions]) => extensions.map((e) => [e, group] as const)),
);

const KIND_GROUP: Record<Kind, Group | undefined> = {
	image: "image",
	svg: "svg",
	html: "html",
	markdown: "markdown",
	text: undefined,
};

/** Spaced for use inside a Japanese sentence (spaces only around Latin words). */
const KIND_NAMES: Record<Kind, string> = {
	image: "画像",
	svg: " SVG ",
	html: " HTML ",
	markdown: " Markdown 文書",
	text: "テキスト",
};

/** Lower-case extension including the dot; a dotfile such as `.env` counts as its own extension. */
export function extensionOf(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? name;
	const dot = base.lastIndexOf(".");
	return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Whether text with this name is shown as it is (like `--as text`) instead of as Markdown when `--as` is not given:
 * text and code extensions such as `.txt`, `.log`, `.csv`, and `.json` (2026-10-23).
 */
export function showsAsText(name: string): boolean {
	return GROUP_OF.get(extensionOf(name)) === "text";
}

/**
 * Warns when the detected kind differs from what the extension suggests. Unknown extensions, files without one, and
 * kinds the owner chose with `--as` are not warned about.
 */
export function extensionWarning(name: string, kind: Kind, chosen: boolean): string | undefined {
	if (chosen) return undefined;
	const extension = extensionOf(name);
	const expected = GROUP_OF.get(extension);
	const actual = KIND_GROUP[kind];
	if (!expected || !actual || expected === actual) return undefined;
	const lead = `拡張子は ${extension} ですが、中身から${KIND_NAMES[kind]}と判定しました。`;
	if (kind === "markdown") {
		if (expected === "html") {
			return `${lead}先頭が <!doctype html> か <html> ではないためです。HTML として置くには、先頭に <!doctype html> を付けてください。`;
		}
		if (expected === "svg") return `${lead}先頭が <svg ではないためです。`;
		return lead;
	}
	if ((kind === "html" || kind === "svg") && expected === "markdown") {
		return `${lead}Markdown 文書として置くには --as markdown を付けてください。`;
	}
	return lead;
}

/** Warns when a Markdown document is in fact JSON, which Markdown would run together into one paragraph. */
export function jsonWarning(text: string): string | undefined {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return undefined;
	try {
		JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	return "全体が JSON として読めます。Markdown として表示すると構造が崩れます。そのままの形で見せるには --as text を付けてください。";
}
