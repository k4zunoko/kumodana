import { describe, expect, it } from "vitest";
import { isFileId, isLinkToken, newFileId, newLinkToken } from "../src/ids.ts";

describe("file IDs", () => {
	it("are 10-character lowercase Crockford Base32", () => {
		for (let i = 0; i < 200; i++) {
			const id = newFileId();
			expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/);
			expect(isFileId(id)).toBe(true);
		}
	});

	it("rejects other shapes", () => {
		expect(isFileId("ABCDEFGHJK")).toBe(false);
		expect(isFileId("0123456789a")).toBe(false);
		expect(isFileId("012345678i")).toBe(false);
	});
});

describe("link tokens", () => {
	it("are 22-character Base64URL strings", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const token = newLinkToken();
			expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
			expect(isLinkToken(token)).toBe(true);
			seen.add(token);
		}
		expect(seen.size).toBe(200);
	});

	it("rejects other shapes", () => {
		expect(isLinkToken("short")).toBe(false);
		expect(isLinkToken("a".repeat(23))).toBe(false);
		expect(isLinkToken(`${"a".repeat(21)}=`)).toBe(false);
	});
});
