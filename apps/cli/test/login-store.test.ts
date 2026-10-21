import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import {
	allowedUrl,
	type LoginFs,
	normalizeAdminUrl,
	RETRY_DELAYS_MS,
	readLogin,
	writeLogin,
} from "../src/login-store.ts";
import { removeTempDirs, sampleRecord, tempConfigHome } from "./auth-server.ts";

const TEST_URLS = { allowHttpLoopback: true };
const STRICT = { allowHttpLoopback: false };
const BASE = "https://kumodana-admin.example.invalid";

async function loginPath(): Promise<string> {
	const dir = await tempConfigHome();
	return join(dir, "kumodana", "login.json");
}

async function save(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

async function errorOf(promise: Promise<unknown>): Promise<CliError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(CliError);
	return error as CliError;
}

function busy(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe("login.json store (specs/003-cli-login data-model)", () => {
	it("writes a record and reads it back", async () => {
		const path = await loginPath();
		const record = sampleRecord(BASE);
		await writeLogin(path, record);
		expect(await readLogin(path, STRICT)).toEqual(record);
	});

	it("treats a missing file as no record", async () => {
		expect(await readLogin(await loginPath(), STRICT)).toBeUndefined();
	});

	it("keeps the URL, endpoints, and client when the session is cleared", async () => {
		const path = await loginPath();
		const record = sampleRecord(BASE);
		await writeLogin(path, { ...record, session: null });
		const read = await readLogin(path, STRICT);
		expect(read?.session).toBeNull();
		expect(read?.adminUrl).toBe(BASE);
		expect(read?.endpoints).toEqual(record.endpoints);
		expect(read?.client).toEqual(record.client);
	});

	it.each([
		["not JSON", "{", "JSON"],
		["an array", "[]", "JSON"],
		["version 2", { ...sampleRecord(BASE), version: 2 }, "version"],
		["no resource", { ...sampleRecord(BASE), resource: undefined }, "resource"],
		["a trailing slash in adminUrl", { ...sampleRecord(BASE), adminUrl: `${BASE}/` }, "adminUrl"],
		["an http adminUrl", { ...sampleRecord(BASE), adminUrl: "http://kumodana-admin.example.invalid" }, "adminUrl"],
		["no endpoints", { ...sampleRecord(BASE), endpoints: undefined }, "endpoints"],
		["an http token endpoint", { ...sampleRecord(BASE), endpoints: { ...sampleRecord(BASE).endpoints, token: "http://x.invalid/t" } }, "endpoints.token"],
		["no client", { ...sampleRecord(BASE), client: undefined }, "client"],
		["no client ID", sampleRecord(BASE, {}, { clientId: "" }), "client.clientId"],
		["no registration date", sampleRecord(BASE, {}, { registeredAt: "x" }), "client.registeredAt"],
		["a session that is a string", { ...sampleRecord(BASE), session: "x" }, "session"],
		["no access token", sampleRecord(BASE, { accessToken: "" }), "session.accessToken"],
		["no refresh token", sampleRecord(BASE, { refreshToken: undefined as unknown as string }), "session.refreshToken"],
		["an unreadable expiry", sampleRecord(BASE, { accessTokenExpiresAt: "soon" }), "session.accessTokenExpiresAt"],
		["no login date", sampleRecord(BASE, { loggedInAt: undefined as unknown as string }), "session.loggedInAt"],
	])("rejects %s as login_invalid without showing a value", async (_name, content, field) => {
		const path = await loginPath();
		await save(path, content);
		const error = await errorOf(readLogin(path, STRICT));
		expect(error.code).toBe("login_invalid");
		expect(error.exitCode).toBe(2);
		expect(error.message).toContain(field);
		expect(`${error.message}${error.hint}`).not.toContain("sample-refresh-token");
		expect(`${error.message}${error.hint}`).not.toContain("sample-access-token");
	});

	it("accepts loopback http only when the URL policy allows it (tests)", async () => {
		const path = await loginPath();
		const record = sampleRecord("http://127.0.0.1:8787");
		await writeLogin(path, record);
		expect((await errorOf(readLogin(path, STRICT))).code).toBe("login_invalid");
		expect(await readLogin(path, TEST_URLS)).toEqual(record);
		expect(allowedUrl("http://127.0.0.1:1/x", STRICT)).toBeUndefined();
		expect(allowedUrl("http://example.invalid/x", TEST_URLS)).toBeUndefined();
		expect(allowedUrl("https://user:pw@example.invalid/", STRICT)).toBeUndefined();
	});

	it("normalizes admin URLs to an origin with no path or query", () => {
		expect(normalizeAdminUrl("https://admin.example.invalid/", STRICT)).toBe("https://admin.example.invalid");
		expect(normalizeAdminUrl(" https://admin.example.invalid ", STRICT)).toBe("https://admin.example.invalid");
		expect(normalizeAdminUrl("https://admin.example.invalid/api", STRICT)).toBeUndefined();
		expect(normalizeAdminUrl("https://admin.example.invalid/?a=1", STRICT)).toBeUndefined();
		expect(normalizeAdminUrl("http://admin.example.invalid", STRICT)).toBeUndefined();
	});

	it("retries reads that fail with EPERM, EACCES, or EBUSY for about 2.5 seconds (Windows)", async () => {
		const path = await loginPath();
		await writeLogin(path, sampleRecord(BASE));
		expect(RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(2500);
		let failures = RETRY_DELAYS_MS.length;
		const fs = {
			readFile: async (p: string, encoding: "utf8") => {
				if (failures-- > 0) throw busy("EPERM");
				return readFile(p, encoding);
			},
		} as LoginFs;
		expect((await readLogin(path, STRICT, fs))?.adminUrl).toBe(BASE);
	});

	it("reports login_read_failed when the file stays busy", async () => {
		const fs = { readFile: async () => Promise.reject(busy("EBUSY")) } as unknown as LoginFs;
		const error = await errorOf(readLogin(await loginPath(), STRICT, fs));
		expect(error.code).toBe("login_read_failed");
		expect(error.exitCode).toBe(1);
	});

	it("replaces the file through a temporary file and keeps the old content when renaming fails", async () => {
		const path = await loginPath();
		const first = sampleRecord(BASE);
		await writeLogin(path, first);
		let renames = 0;
		const fs: LoginFs = {
			readFile: (p, e) => readFile(p, e),
			writeFile: (p, d, o) => writeFile(p, d, o),
			rename: async () => {
				renames++;
				throw busy("EACCES");
			},
			unlink: async (p) => (await import("node:fs/promises")).unlink(p),
			mkdir: (p, o) => mkdir(p, o),
		};
		const error = await errorOf(writeLogin(path, sampleRecord(BASE, null), fs));
		expect(error.code).toBe("login_write_failed");
		expect(renames).toBe(RETRY_DELAYS_MS.length + 1);
		expect(error.details?.errno).toBe("EACCES");
		expect(await readLogin(path, STRICT)).toEqual(first);
		expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("retries the cleanup of test folders and never fails over it (PR #12 re-review)", async () => {
		const seen: { dir: string; maxRetries: number }[] = [];
		await expect(
			removeTempDirs(["a", "b"], async (dir, options) => {
				seen.push({ dir, maxRetries: options.maxRetries });
				throw busy("EBUSY");
			}),
		).resolves.toBeUndefined();
		expect(seen).toEqual([
			{ dir: "a", maxRetries: 10 },
			{ dir: "b", maxRetries: 10 },
		]);
	});

	it.skipIf(process.platform === "win32")("makes the file 600 and a new folder 700", async () => {
		const path = await loginPath();
		await writeLogin(path, sampleRecord(BASE));
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
	});
});
