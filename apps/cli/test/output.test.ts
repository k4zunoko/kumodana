import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import { formatBytes, printError, printResult } from "../src/output.ts";
import { captureOutput, SECRET } from "./helpers.ts";

describe("output", () => {
	it("prints human text, or JSON with --json", () => {
		const human = captureOutput(false);
		printResult(human.out, ["line 1", "line 2"], { a: 1 });
		expect(human.captured.stdout).toEqual(["line 1", "line 2"]);

		const json = captureOutput(true);
		printResult(json.out, "ignored", { a: 1 });
		expect(JSON.parse(json.captured.stdout[0] ?? "")).toEqual({ a: 1 });
	});

	it("writes errors to stderr with hint and code, and returns the exit code", () => {
		const { out, captured } = captureOutput(false);
		const code = printError(out, new CliError("壊れた", { hint: "直す", code: "broken", exitCode: 2 }));
		expect(code).toBe(2);
		expect(captured.stdout).toEqual([]);
		expect(captured.stderr.join("\n")).toContain("エラー: 壊れた");
		expect(captured.stderr.join("\n")).toContain("対処: 直す");
		expect(captured.stderr.join("\n")).toContain("broken");
	});

	it("never prints the secret, in either mode", () => {
		for (const json of [false, true]) {
			const { out, captured } = captureOutput(json);
			out.secrets.push(SECRET);
			printResult(out, `token ${SECRET}`, { secret: SECRET });
			printError(out, new CliError(`failed with ${SECRET}`, { hint: SECRET }));
			const all = [...captured.stdout, ...captured.stderr].join("\n");
			expect(all).not.toContain(SECRET);
			expect(all).toContain("[REDACTED]");
		}
	});

	it("formats sizes", () => {
		expect(formatBytes(999)).toBe("999 B");
		expect(formatBytes(1500)).toBe("1.5 KB");
		expect(formatBytes(5_000_000)).toBe("5.0 MB");
	});
});
