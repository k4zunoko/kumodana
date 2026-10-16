import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeTags } from "../src/purge.ts";
import { TOKEN_A } from "./helpers.ts";

const FILE_ID = "abcdefghjk";

function fakeCache(result: CachePurgeResult | Error) {
	const calls: CachePurgeOptions[] = [];
	const cache = {
		calls,
		async purge(options: CachePurgeOptions): Promise<CachePurgeResult> {
			calls.push(options);
			if (result instanceof Error) throw result;
			return result;
		},
		async invalidate(): Promise<CachePurgeResult> {
			throw new Error("not used");
		},
	};
	return cache;
}

describe("purgeTags", () => {
	it("purges valid link and file tags", async () => {
		const cache = fakeCache({ success: true, errors: [] });
		expect(await purgeTags(cache, [`l:${TOKEN_A}`, `f:${FILE_ID}`])).toEqual({ ok: true });
		expect(cache.calls).toEqual([{ tags: [`l:${TOKEN_A}`, `f:${FILE_ID}`] }]);
	});

	it("rejects other tags and more than 100 tags without purging", async () => {
		const cache = fakeCache({ success: true, errors: [] });
		expect(await purgeTags(cache, ["post-list"])).toEqual({ ok: false, error: "invalid_tag" });
		expect(await purgeTags(cache, [])).toEqual({ ok: false, error: "invalid_tag" });
		expect(await purgeTags(cache, Array.from({ length: 101 }, () => `f:${FILE_ID}`))).toEqual({ ok: false, error: "invalid_tag" });
		expect(cache.calls).toEqual([]);
	});

	it("reports a missing cache", async () => {
		expect(await purgeTags(undefined, [`l:${TOKEN_A}`])).toEqual({ ok: false, error: "cache_unavailable" });
	});

	it("maps failures and exceptions to ok: false", async () => {
		const failed = await purgeTags(fakeCache({ success: false, errors: [{ code: 429, message: "rate limited" }] }), [`l:${TOKEN_A}`]);
		expect(failed).toEqual({ ok: false, error: "429: rate limited" });
		const thrown = await purgeTags(fakeCache(new Error("boom")), [`l:${TOKEN_A}`]);
		expect(thrown.ok).toBe(false);
	});
});

describe("purge RPC", () => {
	it("is callable on the default entrypoint and never throws", async () => {
		const result = await (exports.default as unknown as { purge(tags: string[]): Promise<unknown> }).purge([`l:${TOKEN_A}`]);
		expect(result).toEqual({ ok: false, error: "cache_unavailable" });
	});
});
