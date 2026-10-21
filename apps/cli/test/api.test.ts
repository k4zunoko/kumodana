import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiError } from "../src/api.ts";
import { type LoginRecord, readLogin, writeLogin } from "../src/login-store.ts";
import { type AuthServer, loginRuntime, mockAuthServer, tempConfigHome } from "./auth-server.ts";
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

describe("admin API client with the login (specs/003-cli-login research L8・L11)", () => {
	let auth: AuthServer | undefined;
	afterEach(async () => {
		await auth?.close();
		auth = undefined;
	});

	/** An AdminApi on a saved login whose admin API answers with `answer` (after the token checks of the fake server). */
	async function loginApi(answer?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) {
		auth = await mockAuthServer();
		const dir = await tempConfigHome();
		const { runtime } = loginRuntime(auth, dir);
		const { login } = await import("../src/commands/login.ts");
		expect(await login(runtime, auth.url, {})).toBe(0);
		if (answer) {
			auth.options.api = (req, body, res) => {
				answer(req, res, body);
				return true;
			};
		}
		const { runtime: next } = loginRuntime(auth, dir);
		return { api: await next.api(), path: join(dir, "kumodana", "login.json") };
	}

	it("refreshes before the request when the access token is about to expire", async () => {
		const { path } = await loginApi();
		const saved = (await readLogin(path, { allowHttpLoopback: true })) as LoginRecord;
		const soon = { ...saved, session: { ...saved.session!, accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString() } };
		await writeLogin(path, soon);
		const { runtime } = loginRuntime(auth, join(path, "..", ".."));
		await (await runtime.api()).request("GET", "/api/usage");
		expect(auth!.refreshes).toBe(1);
		expect(auth!.requests.filter((r) => r.path === "/api/usage").at(-1)?.authorization).not.toBe(
			`Bearer ${saved.session?.accessToken}`,
		);
	});

	it("refreshes once after a 401 and repeats the same request, JSON body included", async () => {
		const received: string[] = [];
		const { api } = await loginApi((req, res, body) => {
			received.push(`${req.method} ${req.url} ${body.toString("utf8")}`);
			sendJson(res, 201, { ok: true });
		});
		auth!.expireAccessTokens();
		const result = await api.request<{ ok: boolean }>("POST", "/api/files/x/links", { json: { label: "a" } });
		expect(result.ok).toBe(true);
		expect(auth!.refreshes).toBe(1);
		// The first attempt stopped at the token check; the retry reached the API once.
		expect(received).toEqual(['POST /api/files/x/links {"label":"a"}']);
		const posts = auth!.requests.filter((r) => r.path === "/api/files/x/links");
		expect(posts).toHaveLength(2);
	});

	it("gives up with login_required when the retry is refused again", async () => {
		const { api } = await loginApi((_req, res) => {
			res.writeHead(401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
			res.end("Unauthorized");
		});
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("login_required");
		expect(error.hint).toContain("kumo login");
		expect(auth!.refreshes).toBe(1);
	});

	it("asks for kumo login when the grant was revoked", async () => {
		const { api } = await loginApi();
		auth!.revokeAll();
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("login_required");
	});

	it("reports refresh_failed when the authorization server fails for another reason", async () => {
		const { api } = await loginApi();
		auth!.expireAccessTokens();
		auth!.options.refreshError = { status: 502 };
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("refresh_failed");
	});

	it("explains a Worker 403 forbidden in terms of the owner account", async () => {
		const { api } = await loginApi((_req, res) =>
			sendJson(res, 403, { error: { code: "forbidden", message: "権限がありません。" } }),
		);
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("forbidden");
		expect(error.hint).toContain("OWNER_EMAIL");
		expect(error.hint).not.toContain("CLI_CLIENT_ID");
	});

	it("explains a non-JSON Access 403 in terms of the owner account and policy (review item 6)", async () => {
		const { api } = await loginApi((_req, res) => {
			res.writeHead(403, { "Content-Type": "text/html" });
			res.end("<html>Forbidden</html>");
		});
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("access_denied");
		expect(error.hint).toContain("owner ポリシー");
		expect(error.hint).not.toContain("KUMODANA_CLIENT_SECRET");
	});

	it("treats a redirect to the Access login page as login_required", async () => {
		const { api } = await loginApi((_req, res) => {
			res.writeHead(302, { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" });
			res.end();
		});
		const error = (await api.request("GET", "/api/usage").catch((e: unknown) => e)) as ApiError;
		expect(error.code).toBe("login_required");
	});
});
