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
		const other = sniff(bytes("hello world"));
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
