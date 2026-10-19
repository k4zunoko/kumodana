import type { AllowedContentType } from "@kumodana/shared/limits";
import { checkText, type TextRejectCode } from "./text.ts";

/** How the owner asked to treat a text file (`--as`). */
export const AS_VALUES = ["markdown", "text"] as const;
export type As = (typeof AS_VALUES)[number];

export type Kind = "image" | "svg" | "html" | "markdown" | "text";

export type SniffRejectCode = TextRejectCode | "private_key" | "not_text";

export type Sniffed =
	| { ok: true; kind: "image" | "svg" | "html"; contentType: AllowedContentType }
	| { ok: true; kind: "markdown" | "text"; text: string }
	| { ok: false; code: SniffRejectCode; reason: string; hint?: string };

const ACCEPTED = "受け付ける形式は JPEG、PNG、GIF、WebP、AVIF、SVG、HTML と、UTF-8 のテキスト（Markdown 文書）です。";
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const VIDEO_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "m4v ", "m4a ", "qt  ", "3gp4", "3gp5", "dash"]);
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
	return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

function unsupported(reason: string, hint?: string): Sniffed {
	return hint === undefined
		? { ok: false, code: "unsupported_type", reason }
		: { ok: false, code: "unsupported_type", reason, hint };
}

/**
 * Decides how to treat a file from its contents, never its name (FR-001, specs/002-markdown-share research M5):
 * images and the signatures we refuse first, then SVG and HTML exactly as before (FR-004), then XML, then text.
 * Text that passes `checkText` is a Markdown document unless `as` says otherwise. `as` overrides SVG, HTML, and XML
 * detection (FR-006), but never the text checks or the private-key check (FR-005).
 */
export function sniff(bytes: Uint8Array, options: { as?: As } = {}): Sniffed {
	const binary = sniffBinary(bytes);
	if (binary) {
		if (binary.ok && options.as) {
			return {
				ok: false,
				code: "not_text",
				reason: `テキストではないファイル（${binary.kind === "image" ? binary.contentType : binary.kind}）に --as は使えません。`,
			};
		}
		return binary;
	}
	if (!options.as) {
		const markup = sniffMarkup(bytes);
		if (markup) return markup;
	}
	const checked = checkText(bytes);
	if (!checked.ok) {
		// FR-001: say what is accepted when the content is not text at all.
		return checked.code === "unsupported_type" ? { ...checked, reason: `${checked.reason}${ACCEPTED}` } : checked;
	}
	if (PRIVATE_KEY.test(checked.text)) {
		return {
			ok: false,
			code: "private_key",
			reason: "秘密鍵（-----BEGIN … PRIVATE KEY-----）を含むため、置けません。",
			hint: "鍵を取り除いてから置いてください。公開鍵は置けます。",
		};
	}
	return { ok: true, kind: options.as ?? "markdown", text: checked.text };
}

/** Images by magic bytes, and binary formats we refuse with their own message. */
function sniffBinary(bytes: Uint8Array): Sniffed | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, contentType: "image/jpeg", kind: "image" };
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return { ok: true, contentType: "image/png", kind: "image" };
	}
	const head6 = ascii(bytes, 0, 6);
	if (head6 === "GIF87a" || head6 === "GIF89a") return { ok: true, contentType: "image/gif", kind: "image" };
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
		return { ok: true, contentType: "image/webp", kind: "image" };
	}
	if (ascii(bytes, 4, 8) === "ftyp") {
		const brand = ascii(bytes, 8, 12);
		if (brand === "avif" || brand === "avis") return { ok: true, contentType: "image/avif", kind: "image" };
		if (HEIC_BRANDS.has(brand)) {
			return unsupported(`HEIC 形式は対象外です。JPEG などに変換してから置いてください。${ACCEPTED}`);
		}
		if (VIDEO_BRANDS.has(brand.toLowerCase()) || VIDEO_BRANDS.has(brand)) {
			return unsupported(`動画は対象外です。${ACCEPTED}`);
		}
	}
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return unsupported(`zip は対象外です。${ACCEPTED}`);
	if (ascii(bytes, 0, 5) === "%PDF-") return unsupported(`PDF は対象外です。${ACCEPTED}`);
	return undefined;
}

/**
 * SVG and HTML by their first element, after a BOM, whitespace, an XML declaration, comments, and an SVG doctype
 * (unchanged from 001 research R10, except that skipping now covers the whole file instead of the first 4096
 * bytes). Files that start with an XML declaration or another doctype are refused as XML.
 */
function sniffMarkup(bytes: Uint8Array): Sniffed | undefined {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const head = decoder.decode(bytes.subarray(0, 4096));
	let rest = decoder.decode(bytes).replace(/^\uFEFF/, "");
	let xmlDeclaration = false;
	for (;;) {
		const trimmed = rest.trimStart();
		const lower = trimmed.slice(0, 16).toLowerCase();
		if (lower.startsWith("<?xml")) {
			xmlDeclaration = true;
			rest = trimmed.slice(trimmed.indexOf("?>") + 2);
		} else if (lower.startsWith("<!--")) {
			const end = trimmed.indexOf("-->");
			if (end < 0) {
				rest = trimmed;
				break;
			}
			rest = trimmed.slice(end + 3);
		} else if (lower.startsWith("<!doctype svg")) {
			const end = trimmed.indexOf(">");
			if (end < 0) {
				rest = trimmed;
				break;
			}
			rest = trimmed.slice(end + 1);
		} else {
			rest = trimmed;
			break;
		}
	}
	const lower = rest.slice(0, 16).toLowerCase();
	if (lower.startsWith("<svg")) return { ok: true, contentType: "image/svg+xml", kind: "svg" };
	if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
		return { ok: true, contentType: htmlContentType(bytes, head), kind: "html" };
	}
	if (xmlDeclaration || lower.startsWith("<!doctype")) {
		return unsupported(
			`XML は対象外です（XML 宣言か、HTML と SVG 以外の DOCTYPE で始まっています）。${ACCEPTED}`,
			"そのままの形で見せるには --as text を付けてください。",
		);
	}
	return undefined;
}

/** `text/html` when the page declares its charset, otherwise UTF-8 if the bytes are valid UTF-8. */
function htmlContentType(bytes: Uint8Array, head: string): AllowedContentType {
	if (/<meta[^>]+charset\s*=/i.test(head)) return "text/html";
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return "text/html; charset=utf-8";
	} catch {
		return "text/html";
	}
}
