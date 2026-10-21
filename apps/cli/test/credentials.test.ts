import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/context.ts";
import { LoginCredentials, REFRESH_MARGIN_MS, resolveCredentials } from "../src/credentials.ts";
import { CliError } from "../src/errors.ts";
import { type LoginRecord, readLogin, writeLogin } from "../src/login-store.ts";
import { createAdminApi } from "../src/runtime.ts";
import { type AuthServer, loginEnv, loginRuntime, mockAuthServer, sampleRecord, tempConfigHome } from "./auth-server.ts";
import { captureOutput } from "./helpers.ts";

const TEST_URLS = { allowHttpLoopback: true };

let server: AuthServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function home(files: { config?: unknown; login?: LoginRecord } = {}): Promise<string> {
	const dir = await tempConfigHome();
	await mkdir(join(dir, "kumodana"), { recursive: true });
	if (files.config !== undefined) await writeFile(join(dir, "kumodana", "config.json"), JSON.stringify(files.config));
	if (files.login) await writeLogin(join(dir, "kumodana", "login.json"), files.login);
	return dir;
}

function context(dir: string, env: Record<string, string> = {}) {
	return createContext({ env: loginEnv(dir, env), urls: TEST_URLS });
}

const SERVICE = { adminUrl: "https://admin.example.invalid", clientId: "file-id", clientSecret: "file-secret-value" };

describe("choosing credentials (specs/003-cli-login research L10)", () => {
	it("uses the environment service token first, combined with config.json as before", async () => {
		const dir = await home({ config: SERVICE, login: sampleRecord("http://127.0.0.1:1") });
		const resolved = await resolveCredentials(context(dir, { KUMODANA_CLIENT_ID: "env-id" }));
		expect(resolved.method).toBe("env_service_token");
		expect(resolved.serviceToken?.values).toEqual({ ...SERVICE, clientId: "env-id" });
		expect(resolved.serviceToken?.missing).toEqual([]);
	});

	it("uses the login next, and ignores config.json's service token", async () => {
		const dir = await home({ config: SERVICE, login: sampleRecord("http://127.0.0.1:1") });
		const resolved = await resolveCredentials(context(dir));
		expect(resolved.method).toBe("login");
		expect(resolved.login?.adminUrl).toBe("http://127.0.0.1:1");
	});

	it("falls back to config.json's service token when there is no session", async () => {
		const dir = await home({ config: SERVICE, login: sampleRecord("http://127.0.0.1:1", null) });
		const resolved = await resolveCredentials(context(dir));
		expect(resolved.method).toBe("config_service_token");
		expect(resolved.serviceToken?.values).toEqual(SERVICE);
	});

	it("chooses the method even when values are missing, and names them (review item 1)", async () => {
		const dir = await home();
		const resolved = await resolveCredentials(context(dir, { KUMODANA_CLIENT_ID: "x" }));
		expect(resolved.method).toBe("env_service_token");
		expect(resolved.serviceToken?.missing.join()).toContain("KUMODANA_ADMIN_URL");
		expect(resolved.serviceToken?.missing.join()).toContain("KUMODANA_CLIENT_SECRET");
		const { out } = captureOutput();
		const error = (() => {
			try {
				createAdminApi(resolved, context(dir), out);
			} catch (e) {
				return e as CliError;
			}
		})();
		expect(error?.code).toBe("config_missing");
		expect(error?.exitCode).toBe(2);
	});

	it("reports no credentials as config_missing and points to kumo login", async () => {
		const dir = await home({ config: { adminUrl: "https://admin.example.invalid" } });
		const resolved = await resolveCredentials(context(dir));
		expect(resolved.method).toBe("none");
		const { out } = captureOutput();
		let error: CliError | undefined;
		try {
			createAdminApi(resolved, context(dir), out);
		} catch (e) {
			error = e as CliError;
		}
		expect(error?.code).toBe("config_missing");
		expect(error?.exitCode).toBe(2);
		expect(error?.hint).toContain("kumo login");
	});

	it("refuses to send the login to a different KUMODANA_ADMIN_URL", async () => {
		server = await mockAuthServer();
		const dir = await home({ login: sampleRecord(server.url) });
		const ctx = context(dir, { KUMODANA_ADMIN_URL: "https://other.example.invalid" });
		const resolved = await resolveCredentials(ctx);
		const { out } = captureOutput();
		let error: CliError | undefined;
		try {
			createAdminApi(resolved, ctx, out);
		} catch (e) {
			error = e as CliError;
		}
		expect(error?.code).toBe("admin_url_mismatch");
		expect(error?.exitCode).toBe(2);
		expect(server.requests).toEqual([]);
	});

	it("accepts the same KUMODANA_ADMIN_URL with a trailing slash, and a different config.json adminUrl", async () => {
		server = await mockAuthServer();
		const dir = await home({ config: { adminUrl: "https://old.example.invalid" }, login: sampleRecord(server.url) });
		const ctx = context(dir, { KUMODANA_ADMIN_URL: `${server.url}/` });
		const { out } = captureOutput();
		const api = createAdminApi(await resolveCredentials(ctx), ctx, out);
		expect(api.adminUrl).toBe(server.url);
	});
});

/** Logs in through the fake server and returns the folder; the access token can then be aged on disk. */
async function loggedIn(): Promise<{ dir: string; path: string }> {
	server = await mockAuthServer();
	const dir = await tempConfigHome();
	const { runtime } = loginRuntime(server, dir);
	const { login } = await import("../src/commands/login.ts");
	expect(await login(runtime, server.url, {})).toBe(0);
	return { dir, path: join(dir, "kumodana", "login.json") };
}

async function age(path: string): Promise<LoginRecord> {
	const record = (await readLogin(path, TEST_URLS)) as LoginRecord;
	const aged = { ...record, session: { ...record.session!, accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() } };
	await writeLogin(path, aged);
	return aged;
}

function credentialsFor(record: LoginRecord, path: string, dir: string) {
	const { out, captured } = captureOutput();
	const credentials = new LoginCredentials({ ...record, session: record.session! }, path, context(dir), out);
	return { credentials, out, captured };
}

describe("refreshing and saving (specs/003-cli-login research L8・L9)", () => {
	it("saves the new tokens and keeps the login date", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		const { credentials, out } = credentialsFor(before, path, dir);
		const headers = await credentials.headers();
		const after = (await readLogin(path, TEST_URLS)) as LoginRecord;
		expect(after.session?.refreshToken).not.toBe(before.session?.refreshToken);
		expect(after.session?.accessToken).not.toBe(before.session?.accessToken);
		expect(headers.Authorization).toBe(`Bearer ${after.session?.accessToken}`);
		expect(after.session?.loggedInAt).toBe(before.session?.loggedInAt);
		expect(Date.parse(after.session?.accessTokenExpiresAt ?? "")).toBeGreaterThan(Date.now() + REFRESH_MARGIN_MS);
		expect(after.session?.refreshedAt).not.toBe(before.session?.refreshedAt);
		expect(out.secrets).toContain(after.session?.refreshToken);
		expect(out.secrets).toContain(after.session?.accessToken);
	});

	it("keeps the old refresh token when the response leaves it out", async () => {
		const { dir, path } = await loggedIn();
		server!.options.omitRefreshTokenOnRefresh = true;
		const before = await age(path);
		await credentialsFor(before, path, dir).credentials.headers();
		expect((await readLogin(path, TEST_URLS))?.session?.refreshToken).toBe(before.session?.refreshToken);
	});

	it("warns and goes on when login.json cannot be saved", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		await writeFile(path, "{ broken");
		const { credentials, captured } = credentialsFor(before, path, dir);
		const headers = await credentials.headers();
		expect(headers.Authorization).toMatch(/^Bearer oauth:at-/);
		expect(captured.stderr.join("\n")).toContain("ログインの記録を保存できませんでした");
	});

	it("lets two refreshes at the same time both succeed and leaves valid JSON", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		const a = credentialsFor(before, path, dir).credentials;
		const b = credentialsFor(before, path, dir).credentials;
		const [ha, hb] = await Promise.all([a.headers(), b.headers()]);
		expect(ha.Authorization).not.toBe(hb.Authorization);
		expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
		expect(server!.refreshes).toBe(2);
	});

	it("does not write back over a newer login (review item 4)", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		const newer = { ...before, session: { ...before.session!, loggedInAt: new Date(Date.now() + 5000).toISOString(), refreshToken: "oauth:rt-newer-login" } };
		const { credentials } = credentialsFor(before, path, dir);
		await writeLogin(path, newer);
		await credentials.headers();
		expect((await readLogin(path, TEST_URLS))?.session?.refreshToken).toBe("oauth:rt-newer-login");
	});

	it("does not bring back a session that a logout cleared (review item 4)", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		const { credentials } = credentialsFor(before, path, dir);
		await writeLogin(path, { ...before, session: null });
		await credentials.headers();
		expect((await readLogin(path, TEST_URLS))?.session).toBeNull();
	});

	it("uses a refresh token that another kumo wrote when its own is rejected", async () => {
		const { dir, path } = await loggedIn();
		const stale = await age(path);
		// Another kumo has refreshed and saved a newer refresh token; this one holds a token the server rejects.
		const other = credentialsFor(stale, path, dir).credentials;
		await other.headers();
		const latest = (await readLogin(path, TEST_URLS)) as LoginRecord;
		const rejected = { ...stale, session: { ...stale.session!, refreshToken: "oauth:rt-unknown" } };
		const { credentials } = credentialsFor(rejected, path, dir);
		const headers = await credentials.headers();
		expect(headers.Authorization).toBe(`Bearer ${latest.session?.accessToken}`);
	});

	it("asks for kumo login when the grant is gone", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		server!.revokeAll();
		const error = await credentialsFor(before, path, dir)
			.credentials.headers()
			.catch((e: unknown) => e as CliError);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe("login_required");
		expect((error as CliError).hint).toContain("kumo login");
	});

	it("reports refresh_failed when the authorization server fails for another reason", async () => {
		const { dir, path } = await loggedIn();
		const before = await age(path);
		server!.options.refreshError = { status: 503, error: "temporarily_unavailable" };
		const error = (await credentialsFor(before, path, dir)
			.credentials.headers()
			.catch((e: unknown) => e)) as CliError;
		expect(error.code).toBe("refresh_failed");
	});
});
