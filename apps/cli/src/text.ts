/**
 * Checks whether bytes are text that kumodana can treat as a Markdown document or show as is.
 * See specs/002-markdown-share/research.md M5 and data-model.md (TextCheck).
 */

export type TextRejectCode = "unsupported_type" | "unsupported_encoding";

export type TextCheck =
	| { ok: true; text: string }
	| { ok: false; code: TextRejectCode; reason: string; hint?: string };

const SAVE_AS_UTF8 = "UTF-8 で保存し直してから置いてください。";

/** C0 controls other than tab, LF, CR, and form feed, plus DEL and C1 controls. NUL is reported separately. */
const CONTROL = /[\u0001-\u0008\u000B\u000E-\u001F\u007F-\u009F]/;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
	return signature.every((b, i) => bytes[i] === b);
}

/** 1-based line number of a string index. */
function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
	return line;
}

/** 1-based line number of a byte offset (LF counts as a line break in UTF-8 and ASCII-compatible encodings). */
function lineOfByte(bytes: Uint8Array, offset: number): number {
	let line = 1;
	for (let i = bytes.indexOf(0x0a); i !== -1 && i < offset; i = bytes.indexOf(0x0a, i + 1)) line++;
	return line;
}

function codePoint(char: string): string {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

function reject(code: TextRejectCode, reason: string, hint?: string): TextCheck {
	return hint === undefined ? { ok: false, code, reason } : { ok: false, code, reason, hint };
}

/**
 * Text is non-empty, valid UTF-8 as a whole, and free of NUL and control characters other than tab, LF, CR, and
 * form feed (FR-002). A UTF-8 BOM is removed. UTF-16 and UTF-32 are refused with a hint to save as UTF-8 (FR-003).
 */
export function checkText(bytes: Uint8Array): TextCheck {
	if (bytes.length === 0) return reject("unsupported_type", "空のファイルです。");
	// UTF-32LE starts with the UTF-16LE BOM, so check it first.
	if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
		return reject("unsupported_encoding", "UTF-32 で保存されたテキストです。", SAVE_AS_UTF8);
	}
	if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
		return reject(
			"unsupported_encoding",
			"UTF-16 で保存されたテキストです。",
			`${SAVE_AS_UTF8}Windows PowerShell 5.1 の > や Out-File は、既定で UTF-16 を書き出します。`,
		);
	}

	// NUL means binary data or UTF-16 without a BOM; check it before decoding so that binaries are not reported as
	// a text encoding problem.
	const nul = bytes.indexOf(0x00);
	if (nul !== -1) {
		return reject(
			"unsupported_type",
			`NUL（U+0000）を含むため、テキストとして扱えません（${lineOfByte(bytes, nul)} 行目）。`,
			"バイナリのファイルか、BOM のない UTF-16 で保存されたテキストの可能性があります。",
		);
	}

	let text: string;
	try {
		// The whole file, not just its head. The decoder drops a leading UTF-8 BOM.
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return reject(
			"unsupported_encoding",
			"UTF-8 として読めないテキストです（Shift_JIS などで保存されている可能性があります）。",
			SAVE_AS_UTF8,
		);
	}

	const control = CONTROL.exec(text);
	if (control) {
		const where = `${codePoint(control[0])}（${lineOf(text, control.index)} 行目）`;
		if (control[0] === "\u001b") {
			return reject(
				"unsupported_type",
				`端末の制御文字 ESC を含むため、テキストとして扱えません: ${where}。`,
				"色付きのログなどは、色を付けずに保存し直してください。",
			);
		}
		return reject(
			"unsupported_type",
			`制御文字を含むため、テキストとして扱えません: ${where}。`,
			"タブ・改行・改ページ以外の制御文字を取り除いてください。",
		);
	}
	if (text.trim() === "") return reject("unsupported_type", "内容がありません（空白と改行だけです）。");
	return { ok: true, text };
}
