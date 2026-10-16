import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usage } from "../src/commands/usage.ts";
import { allOutput, mockApi, sendJson, testRuntime } from "./helpers.ts";

let server: Awaited<ReturnType<typeof mockApi>>;

beforeEach(async () => {
	server = await mockApi((_req, _body, res) =>
		sendJson(res, 200, { usedBytes: 1_500_000_000, limitBytes: 8_000_000_000, remainingBytes: 6_500_000_000, fileCount: 42 }),
	);
});

afterEach(() => server.close());

describe("kumo usage", () => {
	it("shows usage, limit, remaining, and file count", async () => {
		const { runtime, captured } = testRuntime(server.url);
		expect(await usage(runtime)).toBe(0);
		const out = allOutput(captured);
		expect(out).toContain("1.5 GB");
		expect(out).toContain("8.0 GB");
		expect(out).toContain("6.5 GB");
		expect(out).toContain("42");
	});

	it("prints the raw numbers with --json", async () => {
		const { runtime, captured } = testRuntime(server.url, true);
		await usage(runtime);
		expect(JSON.parse(captured.stdout.join("\n"))).toMatchObject({ usedBytes: 1_500_000_000, fileCount: 42 });
	});
});
