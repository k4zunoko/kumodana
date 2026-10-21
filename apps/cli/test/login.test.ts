import * as fs from "node:fs/promises";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { login } from "../src/commands/login.ts";
import { list } from "../src/commands/ls.ts";
import { put } from "../src/commands/put.ts";
import { usage } from "../src/commands/usage.ts";
import { type LoginFs, type LoginRecord, readLogin, writeLogin } from "../src/login-store.ts";
import { runCommand } from "../src/runtime.ts";
import { type AuthServer, loginRuntime, mockAuthServer, sampleRecord, TEST_USAGE, tempConfigHome } from "./auth-server.ts";
import { allOutput, type Captured, sendJson } from "./helpers.ts";

const TEST_URLS = { allowHttpLoopback: true };

let server: AuthServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function paths(dir: string) {
	return { login: join(dir, "kumodana", "login.json"), config: join(dir, "kumodana", "config.json") };
}

async function writeConfig(dir: string, config: unknown): Promise<void> {
	await mkdir(join(dir, "kumodana"), { recursive: true });
	await writeFile(paths(dir).config, JSON.stringify(config));
}

async function record(dir: string): Promise<LoginRecord> {
	return (await readLogin(paths(dir).login, TEST_URLS)) as LoginRecord;
}

/** Runs `kumo login` like the command line does: errors become output and an exit code. */
async function runLogin(
	dir: string,
	url: string | undefined,
	options: { open?: boolean; status?: boolean } = {},
	extra: Parameters<typeof loginRuntime>[2] = {},
): Promise<{ code: number; captured: Captured }> {
	const { runtime, captured } = loginRuntime(server, dir, extra);
	const code = await runCommand(runtime, () => login(runtime, url, options));
	return { code, captured };
}

function expectNoTokens(server: AuthServer, captured: Captured): void {
	const text = allOutput(captured);
	for (const token of server.issued) expect(text).not.toContain(token);
}

describe("kumo login (specs/003-cli-login contracts/cli.md)", () => {
	it("logs in through the browser, saves login.json, and checks the admin API", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(0);

		const saved = await record(dir);
		expect(saved.adminUrl).toBe(server.url);
		expect(saved.resource).toBe(`${server.url}/`);
		expect(saved.endpoints.token).toBe(`${server.url}/oauth/token`);
		expect(saved.client.clientId).toMatch(/^client-/);
		expect(saved.session?.accessToken).toMatch(/^oauth:at-/);
		await expect(access(paths(dir).config)).rejects.toThrow();

		expect(captured.stdout).toEqual([`ログインしました: ${server.url}`, "使用量: 1.2 GB / 8.0 GB（15.0%）"]);
		expect(captured.stderr.join("\n")).toContain("ブラウザでログインしてください");
		expect(captured.stderr.join("\n")).toContain(`${server.url}/oauth/authorize?`);
		expect(server.requests.some((r) => r.path === "/api/usage" && r.authorization === `Bearer ${saved.session?.accessToken}`)).toBe(true);
		expectNoTokens(server, captured);
	});

	it("listens before registering and registers with that redirect URI (review item 2)", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await runLogin(dir, server.url);
		const registered = (server.registrations[0]?.redirect_uris as string[])[0];
		expect(registered).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(server.lastAuthorize?.get("redirect_uri")).toBe(registered);
	});

	it("prints JSON with --json and keeps the prompt on stderr", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url, {}, { json: true });
		expect(code).toBe(0);
		const result = JSON.parse(captured.stdout.join("\n")) as Record<string, unknown>;
		expect(result).toMatchObject({ method: "login", adminUrl: server.url, usage: TEST_USAGE });
		expect(typeof result.loggedInAt).toBe("string");
		expect(typeof result.accessTokenExpiresAt).toBe("string");
		expect(captured.stderr.join("\n")).toContain("/oauth/authorize?");
		expectNoTokens(server, captured);
	});

	it("does not open the browser with --no-open, and waits for the URL to be opened by hand", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		let opened = 0;
		const { runtime, captured } = loginRuntime(server, dir, {
			context: {
				openUrl: async () => {
					opened++;
				},
			},
		});
		const out = runtime.out;
		const original = out.stderr;
		out.stderr = (text) => {
			original(text);
			if (text.startsWith(`${server?.url}/oauth/authorize?`)) void server?.browser(text);
		};
		expect(await runCommand(runtime, () => login(runtime, server?.url, { open: false }))).toBe(0);
		expect(opened).toBe(0);
		expect(captured.stdout[0]).toContain("ログインしました");
	});

	it("keeps waiting when the browser cannot be opened", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		const { runtime, captured } = loginRuntime(server, dir, {
			context: { openUrl: async () => Promise.reject(new Error("spawn rundll32.exe ENOENT")) },
		});
		const out = runtime.out;
		const original = out.stderr;
		out.stderr = (text) => {
			original(text);
			if (text.startsWith(`${server?.url}/oauth/authorize?`)) void server?.browser(text);
		};
		expect(await runCommand(runtime, () => login(runtime, server?.url, {}))).toBe(0);
		expect(captured.stderr.join("\n")).toContain("ブラウザを開けませんでした");
	});

	it("reuses this PC's registration and revokes the grant it replaces", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await runLogin(dir, server.url);
		const first = await record(dir);
		const { code } = await runLogin(dir, undefined);
		expect(code).toBe(0);
		const second = await record(dir);
		expect(server.registrations).toHaveLength(1);
		expect(second.client.clientId).toBe(first.client.clientId);
		expect(second.session?.refreshToken).not.toBe(first.session?.refreshToken);
		expect(server.revocations).toEqual([first.session?.refreshToken]);
	});

	it("registers again for a different admin URL", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await writeLogin(paths(dir).login, sampleRecord("http://127.0.0.1:1", null));
		expect((await runLogin(dir, server.url)).code).toBe(0);
		expect(server.registrations).toHaveLength(1);
		expect((await record(dir)).adminUrl).toBe(server.url);
	});

	it("registers again once and starts over when the exchange says invalid_client", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await runLogin(dir, server.url);
		await writeLogin(paths(dir).login, { ...(await record(dir)), session: null });
		server.options.exchangeError = "invalid_client";
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(0);
		expect(server.registrations).toHaveLength(2);
		expect(server.exchanges).toBe(3);
		expect(captured.stderr.join("\n")).toContain("登録し直して");
	});

	it("saves the registration at once when there is no session, but no token on a timeout", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url, {}, { context: { openUrl: async () => {}, callbackTimeoutMs: 200 } });
		expect(code).toBe(1);
		expect(captured.stderr.join("\n")).toContain("（login_timeout）");
		expect(captured.stderr.join("\n")).toContain("所有者のアカウント");
		expect(captured.stderr.join("\n")).toContain("login.json を削除");
		const saved = await record(dir);
		expect(saved.client.clientId).toMatch(/^client-/);
		expect(saved.session).toBeNull();
	});

	it("keeps the previous login and its client together when a re-login under another URL times out", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		const previous = sampleRecord("http://127.0.0.1:1");
		await writeLogin(paths(dir).login, previous);
		const { code } = await runLogin(dir, server.url, {}, { context: { openUrl: async () => {}, callbackTimeoutMs: 200 } });
		expect(code).toBe(1);
		expect(await record(dir)).toEqual(previous);
	});

	it("revokes the new grant and asks to log in again when login.json cannot be saved (PR #12 review)", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		let lastWritten = "";
		const lockedOnSession: LoginFs = {
			readFile: (p, e) => fs.readFile(p, e),
			writeFile: async (p, d, o) => {
				lastWritten = d;
				await fs.writeFile(p, d, o);
			},
			rename: async (from, to) => {
				if (lastWritten.includes('"accessToken"')) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
				await fs.rename(from, to);
			},
			unlink: (p) => fs.unlink(p),
			mkdir: (p, o) => fs.mkdir(p, o),
		};
		const { code, captured } = await runLogin(dir, server.url, {}, { context: { loginFs: lockedOnSession } });
		expect(code).toBe(1);
		const text = captured.stderr.join("\n");
		expect(text).toContain("（login_write_failed）");
		expect(text).toContain("今回のログインの許可は取り消しました");
		expect(text).toContain("もう一度 kumo login を実行してください");
		// The new refresh token (the last one issued) was revoked; the registration stays, without a session.
		expect(server.revocations).toEqual([server.issued.at(-1)]);
		const saved = await record(dir);
		expect(saved.session).toBeNull();
		expect(saved.client.clientId).toMatch(/^client-/);
		expectNoTokens(server, captured);
	});

	it("ends with login_denied and saves no token when the authorization is refused", async () => {
		server = await mockAuthServer({ authorizeError: "access_denied" });
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(1);
		expect(captured.stderr.join("\n")).toContain("（login_denied）");
		expect((await record(dir)).session).toBeNull();
	});

	it("ends with login_failed when the exchange is refused", async () => {
		server = await mockAuthServer({ exchangeError: "invalid_grant" });
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(1);
		expect(captured.stderr.join("\n")).toContain("（login_failed）");
	});

	it("explains login_unavailable when Managed OAuth is not there", async () => {
		server = await mockAuthServer({ metadata: { code_challenge_methods_supported: [] } });
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(1);
		const text = captured.stderr.join("\n");
		expect(text).toContain("（login_unavailable）");
		expect(text).toContain("サービストークン");
		expect(text).toContain("runbook");
	});

	it("rebuilds a broken login.json", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await mkdir(join(dir, "kumodana"), { recursive: true });
		await writeFile(paths(dir).login, "{ broken");
		const { code, captured } = await runLogin(dir, server.url);
		expect(code).toBe(0);
		expect(captured.stderr.join("\n")).toContain("作り直します");
		expect(server.registrations).toHaveLength(1);
	});

	it.each([
		["http:", "http://admin.example.invalid"],
		["a path", "https://admin.example.invalid/api"],
		["a query", "https://admin.example.invalid/?x=1"],
		["not a URL", "admin"],
	])("refuses a URL with %s as invalid_argument (exit code 2)", async (_name, url) => {
		const dir = await tempConfigHome();
		const { runtime, captured } = loginRuntime(undefined, dir, { context: { urls: { allowHttpLoopback: false } } });
		expect(await runCommand(runtime, () => login(runtime, url, {}))).toBe(2);
		expect(captured.stderr.join("\n")).toContain("（invalid_argument）");
	});

	it("asks for a URL when none is known", async () => {
		const dir = await tempConfigHome();
		const { code, captured } = await runLogin(dir, undefined);
		expect(code).toBe(2);
		expect(captured.stderr.join("\n")).toContain("（invalid_argument）");
	});

	it("takes the URL from KUMODANA_ADMIN_URL, then login.json, then config.json", async () => {
		server = await mockAuthServer();
		const fromEnv = await tempConfigHome();
		expect((await runLogin(fromEnv, undefined, {}, { env: { KUMODANA_ADMIN_URL: `${server.url}/` } })).code).toBe(0);
		expect((await record(fromEnv)).adminUrl).toBe(server.url);

		const fromConfig = await tempConfigHome();
		await writeConfig(fromConfig, { adminUrl: server.url });
		expect((await runLogin(fromConfig, undefined)).code).toBe(0);

		const fromLogin = await tempConfigHome();
		expect((await runLogin(fromLogin, server.url)).code).toBe(0);
		await writeLogin(paths(fromLogin).login, { ...(await record(fromLogin)), session: null });
		await writeConfig(fromLogin, { adminUrl: "https://old.example.invalid" });
		expect((await runLogin(fromLogin, undefined)).code).toBe(0);
		expect((await record(fromLogin)).adminUrl).toBe(server.url);
	});

	it("warns about credentials that win over the login or are no longer used", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await writeConfig(dir, { adminUrl: server.url, clientId: "id", clientSecret: "config-secret-value" });
		const env = { KUMODANA_CLIENT_ID: "env-id", KUMODANA_ADMIN_URL: "https://other.example.invalid" };
		const { code, captured } = await runLogin(dir, server.url, {}, { env });
		expect(code).toBe(0);
		const text = captured.stderr.join("\n");
		expect(text).toContain("環境変数 KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET があるため");
		expect(text).toContain("KUMODANA_ADMIN_URL（https://other.example.invalid）がログインした URL と違う");

		const quiet = await tempConfigHome();
		await writeConfig(quiet, { adminUrl: server.url, clientId: "id", clientSecret: "config-secret-value" });
		const second = await runLogin(quiet, server.url);
		expect(second.captured.stderr.join("\n")).toContain("config.json の clientId・clientSecret は、ログインしている間は使われません");
	});

	it("suggests logout then login when revoking the previous grant also ended the new one (review item 7)", async () => {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		await runLogin(dir, server.url);
		// Make the revocation of the old grant end every grant, as it would if Access revoked per client.
		const revokeAll = server.revokeAll;
		const { runtime, captured } = loginRuntime(server, dir, {
			context: {
				fetchImpl: async (input, init) => {
					const response = await fetch(input, init);
					if (String(input).endsWith("/cdn-cgi/access/oauth/revoke")) revokeAll();
					return response;
				},
			},
		});
		expect(await runCommand(runtime, () => login(runtime, undefined, {}))).toBe(1);
		const text = captured.stderr.join("\n");
		expect(text).toContain("（login_required）");
		expect(text).toContain("kumo logout の後に kumo login");
		expect((await record(dir)).session).not.toBeNull();
	});
});

describe("using the login for management operations (#7)", () => {
	async function loggedIn(): Promise<string> {
		server = await mockAuthServer();
		const dir = await tempConfigHome();
		expect((await runLogin(dir, server.url)).code).toBe(0);
		return dir;
	}

	it("sends the bearer token and the client header, not the service-token headers", async () => {
		const dir = await loggedIn();
		const { runtime } = loginRuntime(server, dir);
		let headers: Record<string, string | string[] | undefined> = {};
		server!.options.api = (req, _body, res) => {
			headers = req.headers;
			sendJson(res, 200, TEST_USAGE);
			return true;
		};
		expect(await usage(runtime)).toBe(0);
		expect(headers.authorization).toBe(`Bearer ${(await record(dir)).session?.accessToken}`);
		expect(headers["x-kumodana-client"]).toBe("cli");
		expect(headers["cf-access-client-id"]).toBeUndefined();
		expect(headers["cf-access-client-secret"]).toBeUndefined();
	});

	it("never prints a token, across a refresh, in human or JSON output (SC-004)", async () => {
		const dir = await loggedIn();
		const source = join(dir, "note.md");
		await writeFile(source, "# note\n");
		server!.options.api = (req, _body, res) => {
			if (req.method === "PUT") {
				sendJson(res, 201, {
					file: { id: "f1", name: "note.md.html", contentType: "text/html; charset=utf-8", size: 10, sha256: "0".repeat(64), createdAt: new Date().toISOString(), tags: [], activeLinkCount: 0 },
					duplicate: false,
				});
				return true;
			}
			return false;
		};
		for (const json of [false, true]) {
			server!.expireAccessTokens();
			const { runtime, captured } = loginRuntime(server, dir, { json });
			expect(await runCommand(runtime, () => usage(runtime))).toBe(0);
			expect(await runCommand(runtime, () => list(runtime, {}))).toBe(0);
			expect(await runCommand(runtime, () => put(runtime, [source], {}))).toBe(0);
			expectNoTokens(server!, captured);
		}
		expect(server!.refreshes).toBeGreaterThanOrEqual(2);
		// And when it fails after a revocation:
		server!.revokeAll();
		server!.expireAccessTokens();
		const { runtime, captured } = loginRuntime(server, dir, { json: true });
		expect(await runCommand(runtime, () => usage(runtime))).toBe(1);
		expect(captured.stderr.join("\n")).toContain("login_required");
		expectNoTokens(server!, captured);
	});

	it("keeps using the environment service token when it is set", async () => {
		const dir = await loggedIn();
		let headers: Record<string, string | string[] | undefined> = {};
		const other = await mockAuthServer({});
		try {
			const { runtime } = loginRuntime(server, dir, {
				env: { KUMODANA_ADMIN_URL: other.url, KUMODANA_CLIENT_ID: "env-id", KUMODANA_CLIENT_SECRET: "env-secret-value" },
				context: {
					fetchImpl: async (input, init) => {
						headers = Object.fromEntries(new Headers(init?.headers).entries());
						return new Response(JSON.stringify(TEST_USAGE), { status: 200 });
					},
				},
			});
			expect(await usage(runtime)).toBe(0);
		} finally {
			await other.close();
		}
		expect(headers["cf-access-client-id"]).toBe("env-id");
		expect(headers.authorization).toBeUndefined();
	});
});

describe("kumo login --status (#6, FR-020)", () => {
	async function status(dir: string, env: Record<string, string> = {}, json = false, loginFs?: LoginFs) {
		let calls = 0;
		const { runtime, captured } = loginRuntime(undefined, dir, {
			json,
			env,
			context: {
				fetchImpl: async () => {
					calls++;
					throw new Error("no network in --status");
				},
				...(loginFs ? { loginFs } : {}),
			},
		});
		const code = await runCommand(runtime, () => login(runtime, undefined, { status: true }));
		return { code, captured, calls };
	}

	it("shows the login without any network access", async () => {
		const dir = await tempConfigHome();
		await writeLogin(paths(dir).login, sampleRecord("http://127.0.0.1:1"));
		const { code, captured, calls } = await status(dir);
		expect(code).toBe(0);
		expect(calls).toBe(0);
		const text = captured.stdout.join("\n");
		expect(text).toContain("方法: ログイン（login.json）");
		expect(text).toContain("管理 API: http://127.0.0.1:1");
		expect(text).toContain("ログインした日時:");
		expect(text).toContain("アクセストークンの期限:");
		expect(text).toContain("kumo usage");
		expect(text).not.toContain("sample-access-token");
		expect(text).not.toContain("sample-refresh-token");
	});

	it("prints JSON with the method, URL, login, and notes", async () => {
		const dir = await tempConfigHome();
		const saved = sampleRecord("http://127.0.0.1:1");
		await writeLogin(paths(dir).login, saved);
		const { captured } = await status(dir, {}, true);
		expect(JSON.parse(captured.stdout.join("\n"))).toEqual({
			method: "login",
			adminUrl: "http://127.0.0.1:1",
			login: {
				adminUrl: "http://127.0.0.1:1",
				loggedInAt: saved.session?.loggedInAt,
				accessTokenExpiresAt: saved.session?.accessTokenExpiresAt,
				refreshedAt: saved.session?.refreshedAt,
			},
			notes: [],
		});
	});

	it("shows the environment service token, with missing settings as notes (review item 1)", async () => {
		const dir = await tempConfigHome();
		await writeLogin(paths(dir).login, sampleRecord("http://127.0.0.1:1"));
		const { code, captured } = await status(dir, { KUMODANA_CLIENT_ID: "x" }, true);
		expect(code).toBe(0);
		const result = JSON.parse(captured.stdout.join("\n")) as { method: string; adminUrl: string | null; notes: string[] };
		expect(result.method).toBe("env_service_token");
		expect(result.adminUrl).toBeNull();
		expect(result.notes.join("\n")).toContain("KUMODANA_CLIENT_SECRET");
		expect(result.notes.join("\n")).toContain("KUMODANA_ADMIN_URL");
		expect(result.notes.join("\n")).toContain("使われていません");
	});

	it("shows the config.json service token", async () => {
		const dir = await tempConfigHome();
		await writeConfig(dir, { adminUrl: "https://admin.example.invalid", clientId: "id", clientSecret: "config-secret-value" });
		const { code, captured } = await status(dir);
		expect(code).toBe(0);
		expect(captured.stdout.join("\n")).toContain("方法: サービストークン（config.json）");
		expect(allOutput(captured)).not.toContain("config-secret-value");
	});

	it("shows none and points to kumo login", async () => {
		const { code, captured } = await status(await tempConfigHome());
		expect(code).toBe(0);
		expect(captured.stdout.join("\n")).toContain("方法: なし");
		expect(captured.stdout.join("\n")).toContain("kumo login");
	});

	it("notes a KUMODANA_ADMIN_URL or config.json adminUrl that differs from the login", async () => {
		const dir = await tempConfigHome();
		await writeConfig(dir, { adminUrl: "https://old.example.invalid" });
		await writeLogin(paths(dir).login, sampleRecord("http://127.0.0.1:1"));
		const { captured } = await status(dir, { KUMODANA_ADMIN_URL: "https://other.example.invalid" });
		const text = captured.stdout.join("\n");
		expect(text).toContain("admin_url_mismatch");
		expect(text).toContain("config.json の adminUrl（https://old.example.invalid）");
	});

	it.each([
		["no other credentials", {}, "none"],
		["an environment service token", { KUMODANA_CLIENT_ID: "x" }, "env_service_token"],
	])("notes a broken config.json and still exits with 0, with %s (PR #12 review)", async (_name, env, method) => {
		const dir = await tempConfigHome();
		await mkdir(join(dir, "kumodana"), { recursive: true });
		await writeFile(paths(dir).config, "{ broken");
		const { code, captured } = await status(dir, env, true);
		expect(code).toBe(0);
		const result = JSON.parse(captured.stdout.join("\n")) as { method: string; notes: string[] };
		expect(result.method).toBe(method);
		expect(result.notes.join("\n")).toContain("config.json を読み込めません");
		expect(captured.stderr).toEqual([]);
	});

	it("notes a broken config.json next to a login too", async () => {
		const dir = await tempConfigHome();
		await writeLogin(paths(dir).login, sampleRecord("http://127.0.0.1:1"));
		await writeFile(paths(dir).config, "{ broken");
		const { code, captured } = await status(dir);
		expect(code).toBe(0);
		const text = captured.stdout.join("\n");
		expect(text).toContain("方法: ログイン（login.json）");
		expect(text).toContain("config.json を読み込めません");
	});

	it("ends with login_read_failed (exit code 1) when login.json stays unreadable", async () => {
		const dir = await tempConfigHome();
		const busy: LoginFs = {
			readFile: async () => Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" })),
			writeFile: (p, d, o) => fs.writeFile(p, d, o),
			rename: (a, b) => fs.rename(a, b),
			unlink: (p) => fs.unlink(p),
			mkdir: (p, o) => fs.mkdir(p, o),
		};
		const { code, captured } = await status(dir, {}, false, busy);
		expect(code).toBe(1);
		expect(captured.stderr.join("\n")).toContain("（login_read_failed）");
	});

	it("fails with login_invalid only for a broken login.json", async () => {
		const dir = await tempConfigHome();
		await mkdir(join(dir, "kumodana"), { recursive: true });
		await writeFile(paths(dir).login, "{ broken");
		const { code, captured } = await status(dir);
		expect(code).toBe(2);
		expect(captured.stderr.join("\n")).toContain("（login_invalid）");
	});

	it("cannot be combined with a URL or --no-open", async () => {
		const dir = await tempConfigHome();
		const { runtime } = loginRuntime(undefined, dir);
		expect(await runCommand(runtime, () => login(runtime, "https://admin.example.invalid", { status: true }))).toBe(2);
		expect(await runCommand(runtime, () => login(runtime, undefined, { status: true, open: false }))).toBe(2);
	});
});
