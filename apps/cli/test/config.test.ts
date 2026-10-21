import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configFilePath, loadConfig, loginFilePath } from "../src/config.ts";
import { CliError } from "../src/errors.ts";

const created: string[] = [];
afterEach(async () => {
	// Retry while Windows keeps a file busy, and never fail a test over cleanup (PR #12 re-review).
	await Promise.all(
		created.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)),
	);
});

async function tempConfigDir(content?: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kumo-config-"));
	created.push(dir);
	if (content !== undefined) {
		await mkdir(join(dir, "kumodana"), { recursive: true });
		await writeFile(join(dir, "kumodana", "config.json"), JSON.stringify(content));
	}
	return dir;
}

describe("config", () => {
	it("uses %APPDATA% on Windows and XDG_CONFIG_HOME elsewhere", () => {
		expect(configFilePath({ APPDATA: String.raw`C:\Users\me\AppData\Roaming` }, "win32")).toBe(
			join(String.raw`C:\Users\me\AppData\Roaming`, "kumodana", "config.json"),
		);
		expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(join("/xdg", "kumodana", "config.json"));
	});

	it("keeps login.json next to config.json (specs/003-cli-login research L9)", () => {
		expect(loginFilePath({ APPDATA: String.raw`C:\Users\me\AppData\Roaming` }, "win32")).toBe(
			join(String.raw`C:\Users\me\AppData\Roaming`, "kumodana", "login.json"),
		);
		expect(loginFilePath({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe(join("/xdg", "kumodana", "login.json"));
	});

	it("reads the file and lets environment variables override it", async () => {
		const dir = await tempConfigDir({ adminUrl: "https://file.example/", clientId: "file-id", clientSecret: "file-secret" });
		const config = await loadConfig({ APPDATA: dir, KUMODANA_CLIENT_ID: "env-id" }, "win32");
		expect(config).toEqual({ adminUrl: "https://file.example", clientId: "env-id", clientSecret: "file-secret" });
	});

	it("names the missing keys without showing any secret", async () => {
		const dir = await tempConfigDir();
		const error = await loadConfig({ APPDATA: dir, KUMODANA_CLIENT_SECRET: "hidden-secret-value" }, "win32").catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(CliError);
		const cliError = error as CliError;
		expect(cliError.message).toContain("KUMODANA_ADMIN_URL");
		expect(cliError.message).toContain("KUMODANA_CLIENT_ID");
		expect(cliError.message).not.toContain("KUMODANA_CLIENT_SECRET");
		expect(`${cliError.message}${cliError.hint}`).not.toContain("hidden-secret-value");
		expect(cliError.exitCode).toBe(2);
	});
});
