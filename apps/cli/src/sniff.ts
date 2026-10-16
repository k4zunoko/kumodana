import type { AllowedContentType } from "@kumodana/shared/limits";

export type Sniffed =
	| { ok: true; contentType: AllowedContentType; kind: "image" | "svg" | "html" }
	| { ok: false; reason: string };

const ACCEPTED = "受け付ける形式は JPEG、PNG、GIF、WebP、AVIF、SVG、HTML です。";
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const VIDEO_BRANDS = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "m4v ", "m4a ", "qt  ", "3gp4", "3gp5", "dash"]);

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
	return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

/** Decides the content type from the file contents, not the extension (FR-002, research R10). */
export function sniff(bytes: Uint8Array): Sniffed {
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
			return { ok: false, reason: `HEIC 形式は対象外です。JPEG などに変換してから置いてください。${ACCEPTED}` };
		}
		if (VIDEO_BRANDS.has(brand.toLowerCase()) || VIDEO_BRANDS.has(brand)) {
			return { ok: false, reason: `動画は対象外です。${ACCEPTED}` };
		}
	}
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { ok: false, reason: `zip は対象外です。${ACCEPTED}` };

	return sniffText(bytes);
}

function sniffText(bytes: Uint8Array): Sniffed {
	const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
	let rest = head.replace(/^\uFEFF/, "");
	// Skip whitespace, an XML declaration, comments, and a doctype other than HTML's.
	for (;;) {
		const trimmed = rest.trimStart();
		const lower = trimmed.toLowerCase();
		if (lower.startsWith("<?xml")) {
			rest = trimmed.slice(trimmed.indexOf("?>") + 2);
		} else if (lower.startsWith("<!--")) {
			const end = trimmed.indexOf("-->");
			if (end < 0) break;
			rest = trimmed.slice(end + 3);
		} else if (lower.startsWith("<!doctype svg")) {
			rest = trimmed.slice(trimmed.indexOf(">") + 1);
		} else {
			rest = trimmed;
			break;
		}
	}
	const lower = rest.toLowerCase();
	if (lower.startsWith("<svg")) return { ok: true, contentType: "image/svg+xml", kind: "svg" };
	if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
		return { ok: true, contentType: htmlContentType(bytes, head), kind: "html" };
	}
	return { ok: false, reason: `対象外の形式です。${ACCEPTED}` };
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
