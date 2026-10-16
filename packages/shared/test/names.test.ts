import { describe, expect, it } from "vitest";
import { normalizeTag } from "../src/names.ts";

describe("normalizeTag", () => {
	it("trims, lowercases, and applies NFC", () => {
		expect(normalizeTag("  Travel ")).toEqual({ ok: true, tag: "travel" });
		expect(normalizeTag("旅行")).toEqual({ ok: true, tag: "旅行" });
		expect(normalizeTag("e\u0301")).toEqual({ ok: true, tag: "\u00e9" });
	});

	it("rejects empty, too long, control characters, and commas", () => {
		expect(normalizeTag("   ").ok).toBe(false);
		expect(normalizeTag("a".repeat(65)).ok).toBe(false);
		expect(normalizeTag("あ".repeat(64)).ok).toBe(true);
		expect(normalizeTag("a\tb").ok).toBe(false);
		expect(normalizeTag("a,b").ok).toBe(false);
	});
});
