import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { preview } from "../src/commands/preview.ts";
import { put } from "../src/commands/put.ts";
import { endExiftool } from "../src/exif.ts";
import { createRuntime, runCommand } from "../src/runtime.ts";
import { allOutput, captureOutput, mockApi, sendJson, testRuntime } from "./helpers.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kumo-preview-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

afterAll(endExiftool);

/** A runtime whose configuration cannot be loaded: preview must work without it (FR-021). */
function offlineRuntime(json = false) {
	const { out, captured } = captureOutput(json);
	const runtime = createRuntime({
		json,
		out,
		loadConfig: async () => {
			throw new Error("preview must not load the configuration");
		},
	});
	return { runtime, captured };
}

function recordingOpener() {
	const opened: string[] = [];
	return { opened, opener: async (path: string) => void opened.push(path) };
}

describe("kumo preview", () => {
	it("writes the converted page to a temporary file and opens it, without the admin API", async () => {
		const path = join(dir, "note.md");
		await writeFile(path, "# プレビュー\n\n<b>raw</b>\n");
		const { runtime, captured } = offlineRuntime();
		const { opened, opener } = recordingOpener();
		expect(await runCommand(runtime, () => preview(runtime, path, {}, opener))).toBe(0);
		expect(opened).toHaveLength(1);
		const target = opened[0] as string;
		expect(target.endsWith("note.md.html")).toBe(true);
		expect(target.startsWith(join(tmpdir(), "kumo-preview-"))).toBe(true);
		expect(await readFile(target, "utf8")).toContain("<title>プレビュー</title>");
		const out = allOutput(captured);
		expect(out).toContain("形式: Markdown → HTML");
		expect(out).toContain(target);
		expect(captured.stderr.join("\n")).toContain("警告: 生の HTML");
		await rm(join(target, ".."), { recursive: true, force: true });
	});

	it("does not open the page with --no-open", async () => {
		const path = join(dir, "note.md");
		await writeFile(path, "# x\n");
		const { runtime, captured } = offlineRuntime(true);
		const { opened, opener } = recordingOpener();
		expect(await preview(runtime, path, { open: false }, opener)).toBe(0);
		expect(opened).toEqual([]);
		const result = JSON.parse(captured.stdout.join("\n")) as { kind: string; path: string; size: number; opened: boolean; warnings: string[] };
		expect(result).toMatchObject({ kind: "markdown", opened: false, warnings: [] });
		expect((await stat(result.path)).size).toBe(result.size);
		await rm(join(result.path, ".."), { recursive: true, force: true });
	});

	it("saves to --output without opening, and never overwrites", async () => {
		const path = join(dir, "app.log");
		await writeFile(path, "line 1\n  line 2\n");
		const { runtime } = offlineRuntime();
		const { opened, opener } = recordingOpener();
		expect(await preview(runtime, path, { as: "text", output: "check.html", cwd: dir }, opener)).toBe(0);
		expect(opened).toEqual([]);
		expect(await readFile(join(dir, "check.html"), "utf8")).toContain("<pre>\nline 1\n  line 2\n</pre>");

		await writeFile(join(dir, "check.html"), "keep");
		const { runtime: again, captured } = offlineRuntime();
		expect(await runCommand(again, () => preview(again, path, { output: "check.html", cwd: dir }, opener))).toBe(2);
		expect(allOutput(captured)).toContain("file_exists");
		expect(await readFile(join(dir, "check.html"), "utf8")).toBe("keep");
	});

	it("only reports the kind of images and HTML, which need no conversion", async () => {
		const path = join(dir, "page.md");
		await writeFile(path, "<!doctype html><p>x</p>");
		const { runtime, captured } = offlineRuntime(true);
		const { opened, opener } = recordingOpener();
		expect(await preview(runtime, path, {}, opener)).toBe(0);
		expect(opened).toEqual([]);
		const result = JSON.parse(captured.stdout.join("\n")) as { kind: string; path: null; warnings: string[] };
		expect(result.kind).toBe("html");
		expect(result.path).toBeNull();
		expect(result.warnings).toEqual([expect.stringContaining("--as markdown")]);
	});

	it("refuses the same files as kumo put", async () => {
		const path = join(dir, "ps.md");
		await writeFile(path, Buffer.from([0xff, 0xfe, 0x23, 0x00]));
		const { runtime, captured } = offlineRuntime();
		const { opener } = recordingOpener();
		expect(await runCommand(runtime, () => preview(runtime, path, {}, opener))).toBe(1);
		expect(allOutput(captured)).toContain("UTF-16");
	});

	it("produces exactly the bytes that kumo put sends (SC-005)", async () => {
		const path = join(dir, "same.md");
		await writeFile(path, "# 同じ\n\n- [x] done\n\n| a |\n|---|\n| b |\n");
		const { runtime } = offlineRuntime();
		await preview(runtime, path, { output: "preview.html", cwd: dir }, recordingOpener().opener);

		let sent: Buffer | undefined;
		const server = await mockApi((req, body, res) => {
			if (req.method === "GET") return sendJson(res, 200, { files: [], nextCursor: null });
			sent = body;
			const file = { id: "id00000000", name: "same.md.html", contentType: "text/html", size: body.length, sha256: "x", createdAt: new Date(0).toISOString(), tags: [], activeLinkCount: 0 };
			sendJson(res, 201, { file, duplicate: false });
		});
		try {
			expect(await put(testRuntime(server.url).runtime, [path], {})).toBe(0);
		} finally {
			await server.close();
		}
		expect(sent?.equals(await readFile(join(dir, "preview.html")))).toBe(true);
	});
});
