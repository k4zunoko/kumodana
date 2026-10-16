import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { get } from "../src/commands/get.ts";
import { put } from "../src/commands/put.ts";
import { endExiftool } from "../src/exif.ts";
import { runCommand } from "../src/runtime.ts";
import { allOutput, mockApi, SECRET, sendJson, testRuntime } from "./helpers.ts";

type StoredFile = { id: string; name: string; contentType: string; size: number; sha256: string; body: Buffer };

let files: StoredFile[] = [];
let requests: string[] = [];
let server: Awaited<ReturnType<typeof mockApi>>;
let dir: string;

function summary(file: StoredFile) {
	const { body: _body, ...rest } = file;
	return { ...rest, createdAt: new Date(0).toISOString(), tags: [], activeLinkCount: 0 };
}

beforeEach(async () => {
	files = [];
	requests = [];
	dir = await mkdtemp(join(tmpdir(), "kumo-put-test-"));
	server = await mockApi((req, body, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://x");
		requests.push(`${req.method} ${url.pathname}${url.search}`);
		if (req.method === "GET" && url.pathname === "/api/files") {
			const sha = url.searchParams.get("sha256");
			return sendJson(res, 200, { files: files.filter((f) => f.sha256 === sha).map(summary), nextCursor: null });
		}
		if (req.method === "PUT" && url.pathname === "/api/files") {
			const file: StoredFile = {
				id: `id${String(files.length).padStart(8, "0")}`,
				name: decodeURIComponent(String(req.headers["x-kumodana-filename"])),
				contentType: String(req.headers["content-type"]),
				size: body.length,
				sha256: String(req.headers["x-kumodana-sha256"]),
				body,
			};
			files.push(file);
			return sendJson(res, 201, { file: summary(file), duplicate: false });
		}
		const linkMatch = /^\/api\/files\/(\w+)\/links$/.exec(url.pathname);
		if (req.method === "POST" && linkMatch) {
			const payload = JSON.parse(body.toString() || "{}") as { label?: string };
			return sendJson(res, 201, {
				link: {
					token: "T".repeat(22),
					fileId: linkMatch[1],
					url: `https://kumo.example/${"T".repeat(22)}`,
					label: payload.label ?? null,
					createdAt: new Date(0).toISOString(),
					revokedAt: null,
				},
			});
		}
		const contentMatch = /^\/api\/files\/(\w+)\/content$/.exec(url.pathname);
		if (req.method === "GET" && contentMatch) {
			const file = files.find((f) => f.id === contentMatch[1]);
			if (!file) return sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });
			res.writeHead(200, {
				"Content-Type": file.contentType,
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			});
			return void res.end(file.body);
		}
		sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });
	});
});

afterEach(async () => {
	await server.close();
	await rm(dir, { recursive: true, force: true });
});

afterAll(endExiftool);

async function fixture(name: string): Promise<string> {
	const path = join(dir, name);
	await copyFile(new URL(`./fixtures/${name}`, import.meta.url), path);
	return path;
}

describe("kumo put", () => {
	it("uploads a stripped copy, creates a link, and prints the ID and URL", async () => {
		const path = await fixture("gps.png");
		const original = await readFile(path);
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [path], { link: true, label: "Aさん" });
		expect(code).toBe(0);
		expect(files).toHaveLength(1);
		const stored = files[0] as StoredFile;
		expect(stored.contentType).toBe("image/png");
		expect(stored.name).toBe("gps.png");
		expect(stored.sha256).toBe(createHash("sha256").update(stored.body).digest("hex"));
		expect(stored.body.equals(original)).toBe(false);
		expect(await readFile(path)).toEqual(original);
		const out = allOutput(captured);
		expect(out).toContain(stored.id);
		expect(out).toContain(`https://kumo.example/${"T".repeat(22)}`);
		expect(out).not.toContain(SECRET);
	});

	it("uploads the original bytes with --keep-exif", async () => {
		const path = await fixture("gps.png");
		const { runtime } = testRuntime(server.url);
		await put(runtime, [path], { keepExif: true });
		expect((files[0] as StoredFile).body.equals(await readFile(path))).toBe(true);
	});

	it("uses the existing file when the same content is already stored", async () => {
		const path = join(dir, "page.html");
		await writeFile(path, "<!doctype html><p>hi</p>");
		const { runtime: first } = testRuntime(server.url);
		await put(first, [path], {});
		requests = [];
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [path], {});
		expect(code).toBe(0);
		expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
		expect(allOutput(captured)).toContain("重複");
	});

	it("rejects files of 100MB or more before sending", async () => {
		const path = join(dir, "huge.png");
		const handle = await open(path, "w");
		await handle.truncate(100_000_000);
		await handle.close();
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [path], {});
		expect(code).toBe(1);
		expect(requests).toEqual([]);
		expect(allOutput(captured)).toContain("100MB");
	});

	it("continues after a failure and exits with 1", async () => {
		const good = join(dir, "page.html");
		await writeFile(good, "<!doctype html><p>ok</p>");
		const bad = join(dir, "movie.mp4");
		await writeFile(bad, Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 0, 0]));
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [bad, good], {});
		expect(code).toBe(1);
		expect(files).toHaveLength(1);
		expect(allOutput(captured)).toContain("動画");
	});

	it("prints JSON with --json", async () => {
		const path = join(dir, "page.html");
		await writeFile(path, "<!doctype html><p>json</p>");
		const { runtime, captured } = testRuntime(server.url, true);
		await put(runtime, [path], { link: true });
		const result = JSON.parse(captured.stdout.join("\n")) as { results: { file: { id: string }; link: { url: string } }[] };
		expect(result.results[0]?.file.id).toBe((files[0] as StoredFile).id);
		expect(result.results[0]?.link.url).toContain("kumo.example");
	});
});

describe("kumo get", () => {
	it("saves the file under its original name and refuses to overwrite", async () => {
		files.push({ id: "abcdefghjk", name: "写真.png", contentType: "image/png", size: 3, sha256: "x", body: Buffer.from("png") });
		const { runtime } = testRuntime(server.url);
		const code = await get(runtime, "abcdefghjk", { cwd: dir });
		expect(code).toBe(0);
		expect((await readFile(join(dir, "写真.png"))).toString()).toBe("png");

		const { runtime: again, captured } = testRuntime(server.url);
		const second = await runCommand(again, () => get(again, "abcdefghjk", { cwd: dir }));
		expect(second).toBe(2);
		expect(allOutput(captured)).toContain("既に");
		expect((await stat(join(dir, "写真.png"))).size).toBe(3);
	});
});
