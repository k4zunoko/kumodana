import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import { type CallbackServer, startCallbackServer } from "../src/loopback.ts";

let server: CallbackServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** Sends a GET with an explicit Host header (fetch does not allow changing it). */
function get(url: string, host?: string): Promise<Answer> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const req = request(
			{ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers: host ? { Host: host } : {} },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function callback(redirectUri: string, query: Record<string, string>): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return url.toString();
}

describe("receiving the browser's redirect on 127.0.0.1 (research L6)", () => {
	it("listens on a free port of 127.0.0.1 and returns the code for the right state", async () => {
		server = await startCallbackServer("state-1");
		expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const answer = await get(callback(server.redirectUri, { state: "state-1", code: "code-1" }));
		expect(answer.status).toBe(200);
		expect(answer.headers["cache-control"]).toBe("no-store");
		expect(answer.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'");
		expect(answer.headers["referrer-policy"]).toBe("no-referrer");
		expect(answer.body).toContain("ログインしました");
		expect(await server.waitForCode(15_000)).toBe("code-1");
	});

	it("keeps waiting after a wrong state, so another page cannot end the login", async () => {
		server = await startCallbackServer("state-1");
		const wrong = await get(callback(server.redirectUri, { state: "other", code: "evil" }));
		expect(wrong.status).toBe(400);
		expect(wrong.body).toContain("いま実行中の kumo login のものではありません");
		const waiting = server.waitForCode(15_000);
		await get(callback(server.redirectUri, { state: "state-1", code: "code-1" }));
		expect(await waiting).toBe("code-1");
	});

	it("ends with login_denied when the authorization server sends an error", async () => {
		server = await startCallbackServer("state-1");
		const waiting = server.waitForCode(15_000).catch((e: unknown) => e as CliError);
		const answer = await get(
			callback(server.redirectUri, { state: "state-1", error: "access_denied", error_description: "no <b>" }),
		);
		expect(answer.status).toBe(400);
		const error = (await waiting) as CliError;
		expect(error.code).toBe("login_denied");
		expect(error.message).toContain("access_denied");
		expect(error.hint).toContain("所有者のアカウント");
	});

	it("answers 404 for other paths and refuses a different Host", async () => {
		server = await startCallbackServer("state-1");
		const port = new URL(server.redirectUri).port;
		expect((await get(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
		const rebound = await get(callback(server.redirectUri, { state: "state-1", code: "code-1" }), `evil.example:${port}`);
		expect(rebound.status).toBe(400);
		await expect(server.waitForCode(200)).rejects.toMatchObject({ code: "login_timeout" });
	});

	it("times out with login_timeout and a hint about the account and a client error", async () => {
		server = await startCallbackServer("state-1");
		const error = (await server.waitForCode(100).catch((e: unknown) => e)) as CliError;
		expect(error.code).toBe("login_timeout");
		expect(error.hint).toContain("所有者のアカウント");
		expect(error.hint).toContain("login.json を削除");
	});

	it("reports callback_unavailable when it cannot listen", async () => {
		const error = (await startCallbackServer("state-1", async () => {
			throw new Error("listen EADDRNOTAVAIL 127.0.0.1");
		}).catch((e: unknown) => e)) as CliError;
		expect(error).toBeInstanceOf(CliError);
		expect(error.code).toBe("callback_unavailable");
	});
});
