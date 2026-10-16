import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStorage, seed, TOKEN_A } from "./helpers.ts";

beforeEach(resetStorage);

describe("query strings", () => {
	it("redirect to the canonical URL without returning content", async () => {
		await seed({ id: "file000001", body: "secret-bytes", links: [{ token: TOKEN_A }] });
		const res = await exports.default.fetch(new Request(`https://kumo.meshnode.workers.dev/${TOKEN_A}?fbclid=x`, { redirect: "manual" }));
		expect(res.status).toBe(301);
		expect(res.headers.get("Location")).toBe(`/${TOKEN_A}`);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(await res.text()).not.toContain("secret-bytes");
	});
});
