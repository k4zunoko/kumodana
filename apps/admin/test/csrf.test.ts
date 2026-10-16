import { describe, expect, it } from "vitest";
import { call, testApp } from "./helpers.ts";

const app = testApp();

describe("cross-site request protection", () => {
	it("requires X-Kumodana-Client", async () => {
		const res = await call(app, "GET", "/api/x", { client: false });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: { code: "cross_site_request" } });
	});

	it("rejects requests with an Origin header", async () => {
		const res = await call(app, "GET", "/api/x", { headers: { Origin: "https://kumo.meshnode.workers.dev" } });
		expect(res.status).toBe(403);
	});

	it.each(["cross-site", "same-site"])("rejects Sec-Fetch-Site: %s", async (site) => {
		const res = await call(app, "GET", "/api/x", { headers: { "Sec-Fetch-Site": site } });
		expect(res.status).toBe(403);
	});

	it("allows Sec-Fetch-Site: none", async () => {
		const res = await call(app, "GET", "/api/x", { headers: { "Sec-Fetch-Site": "none" } });
		expect(res.status).toBe(404);
	});

	it("adds defensive headers to every response", async () => {
		for (const res of [
			await call(app, "GET", "/api/x", { client: false }),
			await call(app, "GET", "/api/x"),
			await call(app, "GET", "/not-api"),
		]) {
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
		}
	});
});
