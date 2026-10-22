import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStorage, seed, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D, TOKEN_UNKNOWN } from "./helpers.ts";

const BASE = "https://kumo.example.workers.dev";
const TOKEN_E = "EEEEEEEEEEEEEEEEEEEEEE";
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

	it("returns one identical 404 for every link or path that cannot be shown", async () => {
		await seed({ id: "read000001", links: [{ token: TOKEN_E }] });
		await seed({ id: "revo000001", links: [{ token: TOKEN_A, revoked: true }] });
		await seed({ id: "pend000001", status: "pending", links: [{ token: TOKEN_B }] });
		await seed({ id: "dele000001", status: "deleting", links: [{ token: TOKEN_C }] });
		await seed({ id: "gone000001", withObject: false, links: [{ token: TOKEN_D }] });
		// Unknown (also a deleted file, whose links are gone), revoked, pending, deleting, object-less, and paths that are not links.
		const requests: [path: string, method: string][] = [
			...[TOKEN_UNKNOWN, TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_D].map((token): [string, string] => [`/${token}`, "GET"]),
			["/", "GET"],
			["/favicon.ico", "GET"],
			[`/${TOKEN_E}/extra`, "GET"],
			[`/${TOKEN_E}.png`, "GET"],
			[`/${TOKEN_D}`, "HEAD"],
			[`/${TOKEN_UNKNOWN}`, "HEAD"],
		];
		const headers = new Set<string>();
		const bodies = new Set<string>();
		for (const [path, method] of requests) {
			const res = await get(path, method);
			expect(res.status).toBe(404);
			headers.add(JSON.stringify([...res.headers]));
			if (method === "GET") bodies.add(await res.text());
		}
		expect(headers.size).toBe(1);
		expect(bodies.size).toBe(1);

		const res = await get(`/${TOKEN_UNKNOWN}`);
		expectCommonHeaders(res);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		const page = await res.text();
		expect(page).toContain("<p>このリンクは使えません。取り消されたか、URL が違います。</p>");
		expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
		expect(page).not.toMatch(/<script|\s(?:src|href)=|url\(/i);
	});

	it("rejects other methods with 405", async () => {
		const res = await get(`/${TOKEN_A}`, "POST");
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET, HEAD");
	});
});
