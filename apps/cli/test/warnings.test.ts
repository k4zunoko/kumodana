import { describe, expect, it } from "vitest";
import { extensionOf, extensionWarning, jsonWarning } from "../src/warnings.ts";

describe("extensionOf", () => {
	it("returns the lower-case extension with its dot", () => {
		expect(extensionOf("note.md")).toBe(".md");
		expect(extensionOf("Memo.TXT")).toBe(".txt");
		expect(extensionOf("archive.tar.gz")).toBe(".gz");
		expect(extensionOf("README")).toBe("");
		expect(extensionOf(".env")).toBe(".env");
		expect(extensionOf("dir.d/notes")).toBe("");
	});
});

describe("extensionWarning (FR-019)", () => {
	it("warns when text with a text or code extension becomes Markdown, pointing to --as text", () => {
		for (const name of ["memo.txt", "data.csv", "data.json", "app.log", "script.py", ".env"]) {
			const warning = extensionWarning(name, "markdown", false);
			expect(warning, name).toContain("Markdown 文書と判定しました");
			expect(warning, name).toContain("--as text");
		}
	});

	it("explains how to make a file HTML when an .html file becomes Markdown", () => {
		const warning = extensionWarning("snippet.html", "markdown", false);
		expect(warning).toContain("拡張子は .html ですが、中身から Markdown 文書と判定しました。");
		expect(warning).toContain("<!doctype html>");
		expect(extensionWarning("icon.svg", "markdown", false)).toContain("<svg");
	});

	it("points to --as markdown when a .md file is HTML or SVG", () => {
		expect(extensionWarning("page.md", "html", false)).toContain("中身から HTML と判定しました。Markdown 文書として置くには --as markdown");
		expect(extensionWarning("logo.md", "svg", false)).toContain("--as markdown");
	});

	it("warns about other mismatches without a hint", () => {
		expect(extensionWarning("photo.txt", "image", false)).toBe("拡張子は .txt ですが、中身から画像と判定しました。");
		expect(extensionWarning("photo.png", "markdown", false)).toBe("拡張子は .png ですが、中身から Markdown 文書と判定しました。");
		expect(extensionWarning("page.html", "svg", false)).toContain("中身から SVG と判定しました。");
	});

	it("stays quiet when the extension agrees, is unknown or missing, or the owner chose --as", () => {
		expect(extensionWarning("note.md", "markdown", false)).toBeUndefined();
		expect(extensionWarning("note.markdown", "markdown", false)).toBeUndefined();
		expect(extensionWarning("README", "markdown", false)).toBeUndefined();
		expect(extensionWarning("notes.weird", "markdown", false)).toBeUndefined();
		expect(extensionWarning("page.html", "html", false)).toBeUndefined();
		expect(extensionWarning("photo.JPG", "image", false)).toBeUndefined();
		expect(extensionWarning("app.log", "text", true)).toBeUndefined();
		expect(extensionWarning("page.html", "text", true)).toBeUndefined();
		expect(extensionWarning("memo.txt", "markdown", true)).toBeUndefined();
	});
});

describe("jsonWarning (FR-019)", () => {
	it("warns when the whole text is a JSON object or array", () => {
		expect(jsonWarning('{"a": [1, 2], "b": "*x*"}')).toContain("--as text");
		expect(jsonWarning("\n  [1, 2, 3]\n")).toContain("JSON");
	});

	it("does not warn about Markdown that merely starts with a bracket, or about JSON scalars", () => {
		expect(jsonWarning("[リンク](https://example.com) の説明")).toBeUndefined();
		expect(jsonWarning("{ not json }")).toBeUndefined();
		expect(jsonWarning("42")).toBeUndefined();
		expect(jsonWarning('"text"')).toBeUndefined();
	});
});
