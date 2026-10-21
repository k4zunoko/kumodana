import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { login } from "../src/commands/login.ts";
import { logout } from "../src/commands/logout.ts";
import { usage } from "../src/commands/usage.ts";
import { type LoginRecord, readLogin, writeLogin } from "../src/login-store.ts";
import { runCommand } from "../src/runtime.ts";
import { type AuthServer, loginRuntime, mockAuthServer, tempConfigHome } from "./auth-server.ts";
import { allOutput, type Captured } from "./helpers.ts";

const TEST_URLS = { allowHttpLoopback: true };

let server: AuthServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function loginPath(dir: string): string {
	return join(dir, "kumodana", "login.json");
}

async function loggedIn(): Promise<{ dir: string; before: LoginRecord }> {
	server = await mockAuthServer();
	const dir = await tempConfigHome();
	const { runtime } = loginRuntime(server, dir);
	expect(await login(runtime, server.url, {})).toBe(0);
	return { dir, before: (await readLogin(loginPath(dir), TEST_URLS)) as LoginRecord };
}

async function runLogout(
	dir: string,
	options: Parameters<typeof loginRuntime>[2] = {},
): Promise<{ code: number; captured: Captured }> {
	const { runtime, captured } = loginRuntime(server, dir, options);
	const code = await runCommand(runtime, () => logout(runtime));
	return { code, captured };
}

describe("kumo logout (specs/003-cli-login contracts/cli.md, #8)", () => {
	it("revokes the grant, clears the session, and keeps the URL and the registration", async () => {
		const { dir, before } = await loggedIn();
		const { code, captured } = await runLogout(dir);
		expect(code).toBe(0);
		expect(server!.revocations).toEqual([before.session?.refreshToken]);
		const after = (await readLogin(loginPath(dir), TEST_URLS)) as LoginRecord;
		expect(after.session).toBeNull();
		expect(after.adminUrl).toBe(before.adminUrl);
		expect(after.endpoints).toEqual(before.endpoints);
		expect(after.client).toEqual(before.client);
		expect(captured.stdout).toEqual([`ログアウトしました: ${before.adminUrl}（この PC の許可を取り消しました）`]);
		for (const token of server!.issued) expect(allOutput(captured)).not.toContain(token);
	});

	it("makes the old tokens useless at once (SC-003)", async () => {
		const { dir, before } = await loggedIn();
		await runLogout(dir);
		// Put the old record back, as if it had been copied before the logout.
		await writeLogin(loginPath(dir), before);
		const { runtime, captured } = loginRuntime(server, dir);
		expect(await runCommand(runtime, () => usage(runtime))).toBe(1);
		expect(captured.stderr.join("\n")).toContain("（login_required）");
	});

	it("prints JSON with --json", async () => {
		const { dir, before } = await loggedIn();
		const { captured } = await runLogout(dir, { json: true });
		expect(JSON.parse(captured.stdout.join("\n"))).toEqual({ loggedOut: true, revoked: true, adminUrl: before.adminUrl });
	});

	it("still clears the session when the revocation fails, then exits with revoke_failed (review item 10)", async () => {
		const { dir, before } = await loggedIn();
		server!.options.revokeFails = true;
		const { code, captured } = await runLogout(dir, { json: true });
		expect(code).toBe(1);
		expect(JSON.parse(captured.stdout.join("\n"))).toEqual({ loggedOut: true, revoked: false, adminUrl: before.adminUrl });
		const error = JSON.parse(captured.stderr.at(-1) ?? "{}") as { error: { code: string; hint: string } };
		expect(error.error.code).toBe("revoke_failed");
		expect(error.error.hint).toContain("revoke-tokens");
		expect(error.error.hint).toContain("users revoke");
		expect((await readLogin(loginPath(dir), TEST_URLS))?.session).toBeNull();
		for (const token of server!.issued) expect(allOutput(captured)).not.toContain(token);
	});

	it("still clears the session when the network is down", async () => {
		const { dir } = await loggedIn();
		const { code, captured } = await runLogout(dir, {
			context: {
				fetchImpl: async () => {
					throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
				},
			},
		});
		expect(code).toBe(1);
		expect(captured.stdout[0]).toContain("許可は取り消せていません");
		expect(captured.stderr.join("\n")).toContain("（revoke_failed）");
		expect((await readLogin(loginPath(dir), TEST_URLS))?.session).toBeNull();
	});

	it("warns that an environment service token keeps being used", async () => {
		const { dir } = await loggedIn();
		const { code, captured } = await runLogout(dir, { env: { KUMODANA_CLIENT_ID: "id", KUMODANA_CLIENT_SECRET: "secret-value" } });
		expect(code).toBe(0);
		expect(captured.stderr.join("\n")).toContain("今後もそのサービストークンで管理操作が行われます");
	});

	it("tells that config.json's service token will be used from now on", async () => {
		const { dir } = await loggedIn();
		await writeFile(join(dir, "kumodana", "config.json"), JSON.stringify({ clientId: "id", clientSecret: "secret-value" }));
		const { captured } = await runLogout(dir);
		expect(captured.stderr.join("\n")).toContain("今後は config.json のサービストークン");
	});

	it("says so and succeeds when there is no login", async () => {
		const dir = await tempConfigHome();
		const { code, captured } = await runLogout(dir);
		expect(code).toBe(0);
		expect(captured.stdout).toEqual(["ログインしていません。"]);
		const json = await runLogout(dir, { json: true });
		expect(JSON.parse(json.captured.stdout.join("\n"))).toEqual({ loggedOut: false, revoked: false, adminUrl: null });
	});

	it("succeeds with nothing to do after a logout", async () => {
		const { dir } = await loggedIn();
		await runLogout(dir);
		const again = await runLogout(dir);
		expect(again.code).toBe(0);
		expect(again.captured.stdout).toEqual(["ログインしていません。"]);
	});

	it("reports a broken login.json as login_invalid with what to do", async () => {
		const dir = await tempConfigHome();
		await mkdir(join(dir, "kumodana"), { recursive: true });
		await writeFile(loginPath(dir), "{ broken");
		const { code, captured } = await runLogout(dir);
		expect(code).toBe(2);
		const text = captured.stderr.join("\n");
		expect(text).toContain("（login_invalid）");
		expect(text).toContain("削除してかまいません");
		expect(text).toContain("revoke-tokens");
	});
});
