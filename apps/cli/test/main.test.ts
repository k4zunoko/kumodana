import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const KUMO = fileURLToPath(new URL("../bin/kumo.js", import.meta.url));

/** Runs the real kumo command, as an agent would, and returns what it printed and its exit code. */
function kumo(...args: string[]): { code: number | null; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [KUMO, ...args], { encoding: "utf8", input: "" });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("usage errors with --json", () => {
	it.each([
		[["--json", "frobnicate"], "unknown command 'frobnicate'", "kumo --help"],
		[["frobnicate", "--json"], "unknown command 'frobnicate'", "kumo --help"],
		[["put", "--json"], "missing required argument 'path'", "kumo put --help"],
		[["--json", "put"], "missing required argument 'path'", "kumo put --help"],
		[["put", "x", "--json", "--bogus"], "unknown option '--bogus'", "kumo put --help"],
		[["--json", "put", "x", "--bogus"], "unknown option '--bogus'", "kumo put --help"],
		[["put", "x", "--json", "--as", "html"], "argument 'html' is invalid", "kumo put --help"],
		[["--json", "put", "x", "--as", "html"], "argument 'html' is invalid", "kumo put --help"],
		[["link", "create", "--json"], "missing required argument 'id'", "kumo link create --help"],
		[["--json", "link", "create"], "missing required argument 'id'", "kumo link create --help"],
	])("kumo %j prints only a JSON error and exits with 2", (args, message, help) => {
		const { code, stdout, stderr } = kumo(...args);
		expect(code).toBe(2);
		expect(stdout).toBe("");
		const body = JSON.parse(stderr);
		expect(Object.keys(body)).toEqual(["error"]);
		expect(Object.keys(body.error)).toEqual(["code", "message", "hint"]);
		expect(body.error.code).toBe("usage_error");
		expect(body.error.message).toContain(message);
		expect(body.error.message).not.toMatch(/^error:/);
		expect(body.error.hint).toBe(`${help} で使い方を確認してください。`);
	});

	it.each([
		[["frobnicate"], "error: unknown command 'frobnicate'\n", "Usage: kumo [options] [command]"],
		[["put", "x", "--bogus"], "error: unknown option '--bogus'\n", "Usage: kumo put [options] <path...>"],
	])("kumo %j still prints Commander's text and the help without --json", (args, error, usage) => {
		const { code, stdout, stderr } = kumo(...args);
		expect(code).toBe(2);
		expect(stdout).toBe("");
		expect(stderr.startsWith(error)).toBe(true);
		expect(stderr).toContain(usage);
	});

	it.each([[["--json", "--help"]], [["put", "--help", "--json"]], [["link", "create", "--json", "--help"]]])(
		"kumo %j still shows the help and exits with 0",
		(args) => {
			const { code, stdout, stderr } = kumo(...args);
			expect(code).toBe(0);
			expect(stdout).toContain("Usage: kumo");
			expect(stderr).toBe("");
		},
	);

	it("kumo --json --version still prints the version and exits with 0", () => {
		const { code, stdout, stderr } = kumo("--json", "--version");
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		expect(stderr).toBe("");
	});
});
