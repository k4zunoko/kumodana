import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { list } from "../src/commands/ls.ts";
import { put } from "../src/commands/put.ts";
import { remove } from "../src/commands/rm.ts";
import { tag, tagList } from "../src/commands/tag.ts";
import { endExiftool } from "../src/exif.ts";
import { runCommand } from "../src/runtime.ts";
import { allOutput, mockApi, sendJson, testRuntime } from "./helpers.ts";

function summary(id: string, tags: string[] = []) {
	return {
		id,
		name: `${id}.png`,
		contentType: "image/png",
		size: 2048,
		sha256: "0".repeat(64),
		createdAt: "2026-10-15T00:00:00.000Z",
		tags,
		activeLinkCount: 1,
	};
}

let server: Awaited<ReturnType<typeof mockApi>>;
let requests: { method: string; path: string; body: string }[] = [];
let purgeFailFor = new Set<string>();
let dir: string;

beforeEach(async () => {
	requests = [];
	purgeFailFor = new Set();
	dir = await mkdtemp(join(tmpdir(), "kumo-organize-test-"));
	server = await mockApi((req, body, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		requests.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, body: body.toString() });
		if (req.method === "GET" && url.pathname === "/api/files") {
			if (url.searchParams.has("sha256")) {
				return sendJson(res, 200, { files: [summary("dupe000001")], nextCursor: null });
			}
			const cursor = url.searchParams.get("cursor");
			if (!cursor) return sendJson(res, 200, { files: [summary("aaaa000002", ["旅行"])], nextCursor: "c1" });
			return sendJson(res, 200, { files: [summary("aaaa000001", ["旅行", "2026"])], nextCursor: null });
		}
		if (req.method === "GET" && url.pathname === "/api/tags") {
			return sendJson(res, 200, { tags: [{ tag: "旅行", fileCount: 2 }, { tag: "2026", fileCount: 1 }] });
		}
		const tagsMatch = /^\/api\/files\/(\w+)\/tags$/.exec(url.pathname);
		if (req.method === "PATCH" && tagsMatch) {
			const payload = JSON.parse(body.toString()) as { add?: string[] };
			return sendJson(res, 200, { tags: payload.add ?? [] });
		}
		const deleteMatch = /^\/api\/files\/(\w+)$/.exec(url.pathname);
		if (req.method === "DELETE" && deleteMatch) {
			const id = deleteMatch[1] ?? "";
			return sendJson(res, 200, {
				deleted: id,
				revokedLinks: 1,
				purge: purgeFailFor.has(id) ? { ok: false, error: "429: rate limited" } : { ok: true },
			});
		}
		sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });
	});
});

afterEach(async () => {
	await server.close();
	await rm(dir, { recursive: true, force: true });
});

afterAll(endExiftool);

describe("kumo ls", () => {
	it("follows cursors, repeats --tag, and shows each file", async () => {
		const { runtime, captured } = testRuntime(server.url);
		expect(await list(runtime, { tag: ["旅行", "2026"] })).toBe(0);
		expect(requests.map((r) => r.path)).toEqual([
			`/api/files?tag=${encodeURIComponent("旅行")}&tag=2026&limit=200`,
			`/api/files?tag=${encodeURIComponent("旅行")}&tag=2026&limit=200&cursor=c1`,
		]);
		const out = allOutput(captured);
		expect(out).toContain("aaaa000002");
		expect(out).toContain("aaaa000001");
		expect(out).toContain("旅行, 2026");
		expect(out).toContain("2.0 KB");
	});

	it("stops at --limit", async () => {
		const { runtime, captured } = testRuntime(server.url);
		await list(runtime, { limit: "1" });
		expect(requests).toHaveLength(1);
		expect(allOutput(captured)).not.toContain("aaaa000001");
	});
});

describe("kumo tag / kumo tags", () => {
	it("parses +tag and -tag", async () => {
		const { runtime } = testRuntime(server.url);
		expect(await tag(runtime, "aaaa000001", ["+旅行", "+2026", "-draft"])).toBe(0);
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ add: ["旅行", "2026"], remove: ["draft"] });
	});

	it("rejects arguments without + or - with exit code 2", async () => {
		const { runtime } = testRuntime(server.url);
		expect(await runCommand(runtime, () => tag(runtime, "aaaa000001", ["旅行"]))).toBe(2);
		expect(await runCommand(runtime, () => tag(runtime, "aaaa000001", ["+a,b"]))).toBe(2);
		expect(requests).toEqual([]);
	});

	it("lists tags with counts", async () => {
		const { runtime, captured } = testRuntime(server.url);
		expect(await tagList(runtime)).toBe(0);
		const out = allOutput(captured);
		expect(out).toMatch(/旅行\s+2/);
		expect(out).toMatch(/2026\s+1/);
	});
});

describe("kumo rm", () => {
	it("continues after a purge failure, mentions the 1-hour bound, and exits with 1", async () => {
		purgeFailFor.add("aaaa000001");
		const { runtime, captured } = testRuntime(server.url);
		expect(await remove(runtime, ["aaaa000001", "aaaa000002"])).toBe(1);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"DELETE /api/files/aaaa000001",
			"DELETE /api/files/aaaa000002",
		]);
		const out = allOutput(captured);
		expect(out).toContain("1 時間");
	});

	it("exits with 0 when everything is purged", async () => {
		const { runtime } = testRuntime(server.url);
		expect(await remove(runtime, ["aaaa000001"])).toBe(0);
	});
});

describe("kumo put --tag", () => {
	it("tags an existing file when the content is a duplicate", async () => {
		const path = join(dir, "page.html");
		await writeFile(path, "<!doctype html><p>dupe</p>");
		const { runtime } = testRuntime(server.url);
		expect(await put(runtime, [path], { tag: ["旅行"] })).toBe(0);
		const patch = requests.find((r) => r.method === "PATCH");
		expect(patch?.path).toBe("/api/files/dupe000001/tags");
		expect(JSON.parse(patch?.body ?? "{}")).toEqual({ add: ["旅行"] });
	});
});
