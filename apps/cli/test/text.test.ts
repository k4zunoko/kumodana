import { describe, expect, it } from "vitest";
import { checkText } from "../src/text.ts";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

function rejected(input: Uint8Array) {
	const result = checkText(input);
	if (result.ok) throw new Error(`expected a rejection, got text: ${JSON.stringify(result.text.slice(0, 40))}`);
	return result;
}

function accepted(input: Uint8Array): string {
	const result = checkText(input);
	if (!result.ok) throw new Error(`expected text, got: ${result.reason}`);
	return result.text;
}

describe("checkText", () => {
	it("rejects empty and blank files", () => {
		expect(rejected(bytes())).toMatchObject({ code: "unsupported_type", reason: expect.stringContaining("空") });
		expect(rejected(bytes(" \n\t\r\n　"))).toMatchObject({ code: "unsupported_type", reason: expect.stringContaining("内容がありません") });
		expect(rejected(bytes([0xef, 0xbb, 0xbf], "\n"))).toMatchObject({ code: "unsupported_type" });
	});

	it("removes a UTF-8 BOM", () => {
		expect(accepted(bytes([0xef, 0xbb, 0xbf], "# 見出し"))).toBe("# 見出し");
	});

	it("refuses UTF-16 and UTF-32 with a hint to save as UTF-8", () => {
		for (const bom of [[0xff, 0xfe], [0xfe, 0xff]]) {
			const result = rejected(bytes(bom, [0x23, 0x00, 0x20, 0x00]));
			expect(result.code).toBe("unsupported_encoding");
			expect(result.reason).toContain("UTF-16");
			expect(result.hint).toContain("UTF-8");
		}
		for (const bom of [[0xff, 0xfe, 0x00, 0x00], [0x00, 0x00, 0xfe, 0xff]]) {
			const result = rejected(bytes(bom, [0x23, 0, 0, 0]));
			expect(result.code).toBe("unsupported_encoding");
			expect(result.reason).toContain("UTF-32");
		}
	});

	it("catches UTF-16 without a BOM by its NUL bytes", () => {
		const result = rejected(bytes([0x23, 0x00, 0x20, 0x00, 0x61, 0x00, 0x0a, 0x00]));
		expect(result.code).toBe("unsupported_type");
		expect(result.reason).toContain("NUL");
		expect(result.hint).toContain("UTF-16");
	});

	it("refuses Shift_JIS and other invalid UTF-8", () => {
		const result = rejected(bytes("# メモ\n", [0x82, 0xa0], "\n"));
		expect(result.code).toBe("unsupported_encoding");
		expect(result.reason).toContain("Shift_JIS");
	});

	it("checks the whole file, not just the first 4096 bytes", () => {
		const result = rejected(bytes("a".repeat(5000), [0xff], "z"));
		expect(result.code).toBe("unsupported_encoding");
		const late = rejected(bytes(`${"a\n".repeat(3000)}x`, [0x07]));
		expect(late.reason).toContain("U+0007");
		expect(late.reason).toContain("3001 行目");
	});

	it("rejects NUL and control characters, with a hint for terminal colors", () => {
		expect(rejected(bytes("a", [0x00], "b"))).toMatchObject({ code: "unsupported_type" });
		expect(rejected(bytes("a\u000bb")).reason).toContain("U+000B");
		const esc = rejected(bytes("\u001b[31merror\u001b[0m"));
		expect(esc.reason).toContain("ESC");
		expect(esc.hint).toContain("色");
		expect(rejected(bytes("a\u007fb")).reason).toContain("U+007F");
		expect(rejected(bytes("a\u0085b")).reason).toContain("U+0085");
	});

	it("accepts tab, LF, CR, form feed, and CRLF", () => {
		expect(accepted(bytes("a\tb\nc\rd\fe\r\nf"))).toBe("a\tb\nc\rd\fe\r\nf");
	});

	it("accepts private-use characters, zero-width spaces, and U+FFFD", () => {
		expect(accepted(bytes("a\ue000b\u200bc\ufffd"))).toBe("a\ue000b\u200bc\ufffd");
	});
});
