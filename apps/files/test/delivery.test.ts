import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStorage, seed, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, TOKEN_UNKNOWN } from "./helpers.ts";

const BASE = "https://kumo.meshnode.workers.dev";
const CSP = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

function get(path: string, method = "GET"): Promise<Response> {
	return exports.default.fetch(new Request(`${BASE}${path}`, { method }));
}

function expectCommonHeaders(res: Response): void {
	expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
	expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
}

beforeEach(resetStorage);

describe("delivery", () => {
	it("serves a linked ready file with every header", async () => {
		await seed({ id: "file000001", body: "<!doctype html><p>hi", name: "ページ.html", contentType: "text/html", links: [{ token: TOKEN_A }] });
		const res = await get(`/${TOKEN_A}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("<!doctype html><p>hi");
		expectCommonHeaders(res);
		expect(res.headers.get("Content-Type")).toBe("text/html");
		expect(res.headers.get("Content-Length")).toBe("20");
		expect(res.headers.get("ETag")).toBe(`"${"file000001".padEnd(64, "0")}"`);
		expect(res.headers.get("Content-Disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("ページ.html")}`);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("public, max-age=3600, stale-if-error=0");
		expect(res.headers.get("Cache-Tag")).toBe(`l:${TOKEN_A},f:file000001`);
	});

	it("answers HEAD without a body", async () => {
		await seed({ id: "file000001", body: "abc", links: [{ token: TOKEN_A }] });
		const res = await get(`/${TOKEN_A}`, "HEAD");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Length")).toBe("3");
		expect(await res.text()).toBe("");
	});

	it("returns the same 404 for unknown, revoked, pending, deleting, and object-less files", async () => {
		await seed({ id: "revo000001", links: [{ token: TOKEN_A, revoked: true }] });
		await seed({ id: "pend000001", status: "pending", links: [{ token: TOKEN_B }] });
		await seed({ id: "dele000001", status: "deleting", links: [{ token: TOKEN_C }] });
		await seed({ id: "gone000001", withObject: false, links: [{ token: TOKEN_D }] });
		const bodies = new Set<string>();
		for (const token of [TOKEN_UNKNOWN, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D]) {
			const res = await get(`/${token}`);
			expect(res.status).toBe(404);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expectCommonHeaders(res);
			bodies.add(await res.text());
		}
		expect([...bodies]).toEqual(["Not Found"]);
	});

	it("returns 404 for the root and for extra path segments", async () => {
		await seed({ id: "file000001", links: [{ token: TOKEN_A }] });
		for (const path of ["/", `/${TOKEN_A}/extra`, `/${TOKEN_A}.png`, "/favicon.ico"]) {
			expect((await get(path)).status).toBe(404);
		}
	});

	it("rejects other methods with 405", async () => {
		const res = await get(`/${TOKEN_A}`, "POST");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET, HEAD");
	});
});
