import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sniff } from "../src/sniff.ts";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

const ftyp = (brand: string) => bytes([0, 0, 0, 24], "ftyp", brand, [0, 0, 0, 0], "mif1");

describe("sniff", () => {
	it("detects allowed images by magic bytes", async () => {
		expect(sniff(await readFile(new URL("./fixtures/gps-rotated.jpg", import.meta.url)))).toMatchObject({ ok: true, contentType: "image/jpeg", kind: "image" });
		expect(sniff(await readFile(new URL("./fixtures/gps.png", import.meta.url)))).toMatchObject({ ok: true, contentType: "image/png" });
		expect(sniff(bytes("GIF89a", [1, 0]))).toMatchObject({ ok: true, contentType: "image/gif" });
		expect(sniff(bytes("GIF87a", [1, 0]))).toMatchObject({ ok: true, contentType: "image/gif" });
		expect(sniff(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toMatchObject({ ok: true, contentType: "image/webp" });
		expect(sniff(ftyp("avif"))).toMatchObject({ ok: true, contentType: "image/avif" });
		expect(sniff(ftyp("avis"))).toMatchObject({ ok: true, contentType: "image/avif" });
	});

	it("rejects HEIC with its own message", () => {
		for (const brand of ["heic", "heix", "mif1"]) {
			const result = sniff(ftyp(brand));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toContain("HEIC");
		}
	});

	it("rejects video and zip", () => {
		const mp4 = sniff(ftyp("isom"));
		expect(mp4.ok).toBe(false);
		if (!mp4.ok) expect(mp4.reason).toContain("動画");
		const zip = sniff(bytes("PK", [3, 4, 20, 0]));
		expect(zip.ok).toBe(false);
		if (!zip.ok) expect(zip.reason).toContain("zip");
		// 002: plain text is now a Markdown document; binary data is still refused with the accepted formats.
		const other = sniff(bytes("MZ", [0x90, 0x00, 0x03, 0x00]));
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.reason).toContain("JPEG");
	});

	it("detects SVG after a BOM, XML declaration, comments, and doctype", () => {
		const svg = '\uFEFF<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
		expect(sniff(bytes(svg))).toMatchObject({ ok: true, contentType: "image/svg+xml", kind: "svg" });
	});

	it("detects HTML and chooses the charset", () => {
		expect(sniff(bytes("  <!DOCTYPE html><html><body>こんにちは</body></html>"))).toMatchObject({
			ok: true,
			contentType: "text/html; charset=utf-8",
			kind: "html",
		});
		expect(sniff(bytes('<!-- x --><html><head><meta charset="shift_jis"></head></html>'))).toMatchObject({
			ok: true,
			contentType: "text/html",
		});
		expect(sniff(bytes("<html><body>", [0x82, 0xa0], "</body></html>"))).toMatchObject({ ok: true, contentType: "text/html" });
	});
});

describe("sniff: text and Markdown (002)", () => {
	const rejectedCode = (input: Uint8Array, as?: "markdown" | "text") => {
		const result = sniff(input, as ? { as } : {});
		if (result.ok) throw new Error(`expected a rejection, got ${result.kind}`);
		return result;
	};

	it("treats text that is not an image, SVG, or HTML as Markdown", () => {
		expect(sniff(bytes("hello world"))).toEqual({ ok: true, kind: "markdown", text: "hello world" });
		expect(sniff(bytes([0xef, 0xbb, 0xbf], "# 見出し\n"))).toEqual({ ok: true, kind: "markdown", text: "# 見出し\n" });
		expect(sniff(bytes('<p align="center"><img src="logo.png"></p>\n\n# Title'))).toMatchObject({ ok: true, kind: "markdown" });
		expect(sniff(bytes("<!-- TOC -->\n# Title"))).toMatchObject({ ok: true, kind: "markdown" });
		expect(sniff(bytes("<https://example.com>"))).toMatchObject({ ok: true, kind: "markdown" });
		expect(sniff(bytes('<rss version="2.0"><channel/></rss>'))).toMatchObject({ ok: true, kind: "markdown" });
		expect(sniff(bytes("<div>fragment</div>"))).toMatchObject({ ok: true, kind: "markdown" });
	});

	it("keeps SVG and HTML detection, now skipping comments of any length", () => {
		expect(sniff(bytes([0xef, 0xbb, 0xbf], "\n\n  <!doctype html><p>x"))).toMatchObject({ ok: true, kind: "html" });
		const longComment = `<!-- ${"license ".repeat(1000)} -->\n<html><body>x</body></html>`;
		expect(longComment.length).toBeGreaterThan(4096);
		expect(sniff(bytes(longComment))).toMatchObject({ ok: true, kind: "html", contentType: "text/html; charset=utf-8" });
		expect(sniff(bytes('<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "x" "y">\n<html xmlns="x"></html>'))).toMatchObject({ kind: "html" });
		expect(sniff(bytes("<svg><title>logo</title></svg>\n\n# Markdown after an inline SVG"))).toMatchObject({ kind: "svg" });
	});

	it("does not hang on an SVG doctype without a closing bracket", () => {
		expect(sniff(bytes("<!DOCTYPE svg PUBLIC"))).toMatchObject({ ok: false, code: "unsupported_type" });
	});

	it("refuses XML with a declaration or another doctype, and PDF", () => {
		const xml = rejectedCode(bytes('<?xml version="1.0"?>\n<rss version="2.0"></rss>'));
		expect(xml.code).toBe("unsupported_type");
		expect(xml.reason).toContain("XML");
		expect(xml.hint).toContain("--as text");
		expect(rejectedCode(bytes('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x">\n<plist/>')).reason).toContain("XML");
		const pdf = rejectedCode(bytes("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"));
		expect(pdf.reason).toContain("PDF");
		expect(rejectedCode(bytes("%PDF-1.7\n"), "text").reason).toContain("PDF");
	});

	it("refuses UTF-16 HTML with an encoding hint instead of a generic message", () => {
		const utf16 = rejectedCode(bytes([0xff, 0xfe], [0x3c, 0x00, 0x68, 0x00, 0x74, 0x00, 0x6d, 0x00, 0x6c, 0x00]));
		expect(utf16.code).toBe("unsupported_encoding");
	});

	it("refuses private keys whatever --as says, but not public keys", () => {
		const keys = [
			"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
			"memo\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIE\n",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQ\n",
		];
		for (const key of keys) {
			expect(rejectedCode(bytes(key)).code).toBe("private_key");
			expect(rejectedCode(bytes(key), "text").code).toBe("private_key");
			expect(rejectedCode(bytes(key), "markdown").code).toBe("private_key");
		}
		expect(sniff(bytes("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n"))).toMatchObject({ ok: true, kind: "markdown" });
	});

	it("lets --as override SVG, HTML, and XML detection", () => {
		expect(sniff(bytes("<!doctype html><p>x</p>"), { as: "text" })).toEqual({ ok: true, kind: "text", text: "<!doctype html><p>x</p>" });
		expect(sniff(bytes("<svg></svg>\n# Title"), { as: "markdown" })).toMatchObject({ ok: true, kind: "markdown" });
		expect(sniff(bytes('<?xml version="1.0"?><rss/>'), { as: "text" })).toMatchObject({ ok: true, kind: "text" });
		expect(sniff(bytes("plain"), { as: "text" })).toEqual({ ok: true, kind: "text", text: "plain" });
	});

	it("refuses --as for images", async () => {
		const jpeg = await readFile(new URL("./fixtures/gps-rotated.jpg", import.meta.url));
		const result = rejectedCode(jpeg, "text");
		expect(result.code).toBe("not_text");
		expect(result.reason).toContain("image/jpeg");
		expect(rejectedCode(bytes("GIF89a", [1, 0]), "markdown").code).toBe("not_text");
	});

	it("still refuses binary data and text that fails the text checks", () => {
		expect(rejectedCode(bytes([0x00, 0x01, 0x02])).code).toBe("unsupported_type");
		expect(rejectedCode(bytes("a\u001b[0mb")).code).toBe("unsupported_type");
		expect(rejectedCode(bytes("# メモ ", [0x82, 0xa0])).code).toBe("unsupported_encoding");
		expect(rejectedCode(bytes("   \n")).code).toBe("unsupported_type");
	});
});
