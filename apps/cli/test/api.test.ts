import { afterEach, describe, expect, it } from "vitest";
import type { ApiError } from "../src/api.ts";
import { mockApi, SECRET, sendJson, testRuntime } from "./helpers.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

async function errorFor(handler: Parameters<typeof mockApi>[0]): Promise<ApiError> {
	const server = await mockApi(handler);
	close = server.close;
	const { runtime } = testRuntime(server.url);
	const api = await runtime.api();
	return (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
}

describe("admin API client", () => {
	it("sends the service-token and client headers", async () => {
		let seen: Record<string, string | string[] | undefined> = {};
		const server = await mockApi((req, _body, res) => {
			seen = req.headers;
			sendJson(res, 200, { ok: true });
		});
		close = server.close;
		const { runtime } = testRuntime(server.url);
		await (await runtime.api()).request("GET", "/api/usage");
		expect(seen["cf-access-client-id"]).toBe("cli-id.access");
		expect(seen["cf-access-client-secret"]).toBe(SECRET);
		expect(seen["x-kumodana-client"]).toBe("cli");
		expect(seen.origin).toBeUndefined();
	});

	it("explains 401 in terms of the client ID, secret, and expiry", async () => {
		const error = await errorFor((_req, _body, res) =>
			sendJson(res, 401, { error: { code: "unauthenticated", message: "認証情報がないか、無効です。" } }),
		);
		expect(error.code).toBe("unauthenticated");
		expect(error.hint).toContain("KUMODANA_CLIENT_ID");
		expect(error.hint).toContain("KUMODANA_CLIENT_SECRET");
		expect(error.hint).toContain("期限");
	});

	it("explains 403 forbidden", async () => {
		const error = await errorFor((_req, _body, res) =>
			sendJson(res, 403, { error: { code: "forbidden", message: "権限がありません。" } }),
		);
		expect(error.hint).toContain("CLI_CLIENT_ID");
	});

	it("detects a redirect to the Access login page", async () => {
		const error = await errorFor((_req, _body, res) => {
			res.writeHead(302, { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" });
			res.end();
		});
		expect(error.code).toBe("access_login_required");
		expect(error.hint).toContain("Service Auth");
	});

	it("explains a non-JSON Access denial", async () => {
		const error = await errorFor((_req, _body, res) => {
			res.writeHead(403, { "Content-Type": "text/html" });
			res.end("<html>Forbidden</html>");
		});
		expect(error.code).toBe("access_denied");
		expect(error.hint).toContain("KUMODANA_CLIENT_SECRET");
	});

	it("mentions the daily free limit for 429/5xx without a JSON body", async () => {
		const error = await errorFor((_req, _body, res) => {
			res.writeHead(429, { "Content-Type": "text/html" });
			res.end("Error 1027");
		});
		expect(error.hint).toContain("無料枠");
	});
});
