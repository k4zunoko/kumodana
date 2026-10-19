import { describe, expect, it, vi } from "vitest";
import { CliError } from "../src/errors.ts";
import { prepare } from "../src/prepare.ts";

// A small limit stands in for 100MB, so the converted size can exceed it without building huge inputs.
vi.mock("@kumodana/shared/limits", async (importOriginal) => ({
	...(await importOriginal<typeof import("@kumodana/shared/limits")>()),
	MAX_FILE_BYTES: 3_000,
}));

const bytes = (text: string) => new TextEncoder().encode(text);

function refusal(fn: () => unknown): CliError {
	try {
		fn();
	} catch (error) {
		if (error instanceof CliError) return error;
		throw error;
	}
	throw new Error("expected a CliError");
}

describe("prepare: converted size (FR-016)", () => {
	it("accepts a converted page below the limit", () => {
		const prepared = prepare(bytes("# ok\n"), "note.md", undefined);
		expect(prepared.kind).toBe("markdown");
		expect(prepared.data.length).toBeLessThanOrEqual(3_000);
	});

	it("refuses a page that grows past the limit when converted, before anything is sent", () => {
		// Each "<" becomes an entity, so the page is larger than the source.
		const source = bytes("<".repeat(400));
		expect(source.length).toBeLessThan(3_000);
		for (const as of [undefined, "text"] as const) {
			const error = refusal(() => prepare(source, "big.md", as));
			expect(error.code, String(as)).toBe("file_too_large");
			expect(error.message, String(as)).toContain("変換後の HTML が大きすぎます");
		}
	});
});
