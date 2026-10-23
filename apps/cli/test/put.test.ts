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
let putConflict = false;

function summary(file: StoredFile) {
	const { body: _body, ...rest } = file;
	return { ...rest, createdAt: new Date(0).toISOString(), tags: [], activeLinkCount: 0 };
}

beforeEach(async () => {
	files = [];
	requests = [];
	putConflict = false;
	dir = await mkdtemp(join(tmpdir(), "kumo-put-test-"));
	server = await mockApi((req, body, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://x");
		requests.push(`${req.method} ${url.pathname}${url.search}`);
		if (req.method === "GET" && url.pathname === "/api/files") {
			const sha = url.searchParams.get("sha256");
			return sendJson(res, 200, { files: files.filter((f) => f.sha256 === sha).map(summary), nextCursor: null });
		}
		if (req.method === "PUT" && url.pathname === "/api/files") {
			if (putConflict) {
				return sendJson(res, 409, {
					error: { code: "upload_in_progress", message: "同じ内容のファイルをアップロード中です。", details: { retryAfterSeconds: 120 } },
				});
			}
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

	it("shows how long to wait when the same content is still uploading", async () => {
		const path = join(dir, "page.html");
		await writeFile(path, "<!doctype html><p>busy</p>");
		putConflict = true;
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [path], {});
		expect(code).toBe(1);
		expect(allOutput(captured)).toContain("2 分");
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

describe("kumo put: Markdown documents and text (002)", () => {
	const html = (file: StoredFile) => file.body.toString("utf8");

	it("converts a Markdown document to HTML named <name>.html and keeps the original", async () => {
		const path = join(dir, "note.md");
		await writeFile(path, "# メモ\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] todo\n");
		const before = await stat(path);
		const { runtime, captured } = testRuntime(server.url);
		const code = await put(runtime, [path], { link: true });
		expect(code).toBe(0);
		const stored = files[0] as StoredFile;
		expect(stored.name).toBe("note.md.html");
		expect(stored.contentType).toBe("text/html; charset=utf-8");
		expect(stored.sha256).toBe(createHash("sha256").update(stored.body).digest("hex"));
		expect(html(stored)).toMatch(/^<!doctype html>\n/);
		expect(html(stored)).toContain("<title>メモ</title>");
		expect(html(stored)).toContain("<table>");
		const out = allOutput(captured);
		expect(out).toContain(`${stored.id}  note.md.html`);
		expect(out).toContain("Markdown → HTML");
		expect(out).toContain(`https://kumo.example/${"T".repeat(22)}`);
		expect((await readFile(path)).toString()).toBe("# メモ\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] todo\n");
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
	});

	it("finds the same converted content again as a duplicate", async () => {
		const path = join(dir, "same.md");
		await writeFile(path, "# 同じ\n");
		await put(testRuntime(server.url).runtime, [path], {});
		requests = [];
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [path], {})).toBe(0);
		expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
		expect(allOutput(captured)).toContain("重複");
	});

	it("reports kind, warnings, and a summary in JSON", async () => {
		const note = join(dir, "note.md");
		await writeFile(note, "# A\n\n<b>raw</b>\n");
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [note], {})).toBe(0);
		const result = JSON.parse(captured.stdout.join("\n")) as {
			results: { kind: string; warnings: string[] }[];
			summary: { kinds: Record<string, number>; warnings: number };
		};
		expect(result.results[0]?.kind).toBe("markdown");
		expect(result.results[0]?.warnings).toEqual([expect.stringContaining("3 行目")]);
		expect(result.summary).toEqual({ kinds: { markdown: 1 }, warnings: 1 });
		expect(captured.stderr).toEqual([]);
	});

	it("warns about a .txt file shown as Markdown and keeps going", async () => {
		const path = join(dir, "memo.txt");
		await writeFile(path, "買い物\n- 牛乳\n");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [path], {})).toBe(0);
		expect((files[0] as StoredFile).name).toBe("memo.txt.html");
		expect(captured.stderr.join("\n")).toContain(`警告: ${path}: 拡張子は .txt ですが`);
		expect(captured.stderr.join("\n")).toContain("--as text");
	});

	it("shows text as it is with --as text", async () => {
		const log = join(dir, "app.log");
		await writeFile(log, "12:00 [INFO] start\n12:01 [WARN] *x* <y>\n");
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>source</p>");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [log, page], { as: "text" })).toBe(0);
		const [logFile, pageFile] = files as [StoredFile, StoredFile];
		expect(logFile.name).toBe("app.log.html");
		expect(html(logFile)).toContain("<pre>\n12:00 [INFO] start\n12:01 [WARN] *x* &#60;y&#62;\n</pre>");
		expect(pageFile.name).toBe("page.html.html");
		expect(html(pageFile)).toContain("&#60;!doctype html&#62;&#60;p&#62;source");
		expect(allOutput(captured)).toContain("テキスト → HTML");
		expect(captured.stderr).toEqual([]);
	});

	it("treats a document that starts with <svg> as Markdown with --as markdown", async () => {
		const path = join(dir, "readme.md");
		await writeFile(path, "<svg></svg>\n\n# Title\n");
		const { runtime } = testRuntime(server.url);
		expect(await put(runtime, [path], { as: "markdown" })).toBe(0);
		expect((files[0] as StoredFile).name).toBe("readme.md.html");
		expect(html(files[0] as StoredFile)).toContain("<h1>Title</h1>");
	});

	it("refuses --as for images and unknown --as values", async () => {
		const image = await fixture("gps.png");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [image], { as: "text" })).toBe(1);
		expect(files).toEqual([]);
		expect(allOutput(captured)).toContain("not_text");

		const { runtime: second, captured: secondOut } = testRuntime(server.url);
		expect(await runCommand(second, () => put(second, [image], { as: "html" }))).toBe(2);
		expect(allOutput(secondOut)).toContain("--as には markdown か text");
	});

	it("refuses UTF-16 and private keys, continues with the rest, and summarizes", async () => {
		const utf16 = join(dir, "ps.md");
		await writeFile(utf16, Buffer.from([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x61, 0x00]));
		const key = join(dir, "key.txt");
		await writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
		const ok = join(dir, "ok.md");
		await writeFile(ok, "# ok\n");
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>x</p>");
		const memo = join(dir, "memo.txt");
		await writeFile(memo, "memo\n");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [utf16, key, ok, page, memo], {})).toBe(1);
		expect(files.map((f) => f.name)).toEqual(["ok.md.html", "page.html", "memo.txt.html"]);
		const out = allOutput(captured);
		expect(out).toContain("UTF-16");
		expect(out).toContain("unsupported_encoding");
		expect(out).toContain("秘密鍵");
		expect(out).toContain("private_key");
		expect(out).toContain("形式: Markdown → HTML 2 件、HTML 1 件 / 警告: 1 件");
		expect(out).toContain("失敗: 2 件");
	});
});

describe("kumo put: SVG metadata", () => {
	type Result = { path: string; kind: string; warnings: string[]; duplicate: boolean; error?: { code: string } };
	const sent = (index: number) => (files[index] as StoredFile).body.toString("utf8");
	const json = (captured: { stdout: string[] }) => JSON.parse(captured.stdout.join("\n")) as { results: Result[] };

	it("removes <metadata>, drawing programs' data, and comments, and keeps the drawing", async () => {
		const inkscape = await fixture("inkscape.svg");
		const illustrator = await fixture("illustrator.svg");
		const originals = [await readFile(inkscape), await readFile(illustrator)];
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [inkscape, illustrator], {})).toBe(0);

		for (const [index, file] of files.entries()) {
			expect(file.contentType).toBe("image/svg+xml");
			expect(file.sha256).toBe(createHash("sha256").update(file.body).digest("hex"));
			expect(file.body.length).toBeLessThan((originals[index] as Buffer).length);
			expect(sent(index)).not.toMatch(/<metadata|<!--|sodipodi|inkscape|xmlns:(dc|cc|rdf|x|i|graph)=|\si:|<i:/);
		}
		expect(sent(0)).not.toMatch(/Taro Yamada|taro\.yamada|間取り図\.(svg|png)|2026-10-01|居間 -->/);
		for (const kept of ['viewBox="0 0 200 120"', 'id="title1">間取り図</title>', 'id="desc1">居間と寝室</desc>',
			'id="layer1"', 'id="floor">', ".wall { stroke: #333;", 'd="M 10,10 H 190 V 110 H 10 Z M 130,10 V 110"',
			'xml:space="preserve"', ">居間  と  台所</tspan>"]) {
			expect(sent(0)).toContain(kept);
		}
		expect(sent(1)).not.toMatch(/Adobe Illustrator|adobe_illustrator_pgf|eJzsvWuTHMdxKPq9f9X5|赤い丸/);
		for (const kept of ['xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"', ".st0{fill:#E60012;}", "<title>ロゴ案</title>",
			"<desc>作業用の書き出し</desc>", '<circle class="st0" cx="50" cy="60" r="35"/>', ">Hanako   Sato</text>"]) {
			expect(sent(1)).toContain(kept);
		}
		expect(json(captured).results.map((r) => [r.kind, r.warnings])).toEqual([["svg", []], ["svg", []]]);
		expect([await readFile(inkscape), await readFile(illustrator)]).toEqual(originals);
	});

	it("judges duplicates by the cleaned content", async () => {
		const first = await fixture("inkscape.svg");
		const second = join(dir, "inkscape-renamed.svg");
		const original = await readFile(first, "utf8");
		await writeFile(second, original.replace("Taro Yamada", "Hanako Sato").replace("<!-- 居間 -->", "<!-- 別のメモ -->"));
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [first, second], {})).toBe(0);
		expect(files).toHaveLength(1);
		expect(json(captured).results.map((r) => r.duplicate)).toEqual([false, true]);
	});

	it("sends images and SVG unchanged with --keep-exif and warns that the metadata is kept", async () => {
		const image = await fixture("gps.png");
		const svg = await fixture("inkscape.svg");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [image, svg], { keepExif: true })).toBe(0);
		expect((files[0] as StoredFile).body.equals(await readFile(image))).toBe(true);
		expect((files[1] as StoredFile).body.equals(await readFile(svg))).toBe(true);
		const stderr = captured.stderr.join("\n");
		expect(stderr).toContain(`警告: ${image}: --keep-exif を付けたため、メタデータ`);
		expect(stderr).toContain(`警告: ${svg}: --keep-exif を付けたため、メタデータ`);

		files = [];
		const { runtime: withJson, captured: jsonOut } = testRuntime(server.url, true);
		await put(withJson, [image, svg], { keepExif: true });
		expect(json(jsonOut).results.map((r) => r.warnings)).toEqual([
			[expect.stringContaining("--keep-exif を付けたため")],
			[expect.stringContaining("--keep-exif を付けたため")],
		]);

		files = [];
		const { runtime: without, captured: withoutOut } = testRuntime(server.url);
		await put(without, [image, svg], {});
		expect(allOutput(withoutOut)).not.toContain("--keep-exif を付けたため");
	});

	it("warns about photos embedded in an SVG, but not about an SVG without them", async () => {
		const embedded = await fixture("embedded-photo.svg");
		const plain = await fixture("plain.svg");
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [embedded, plain], {})).toBe(0);
		expect(json(captured).results.map((r) => r.warnings)).toEqual([[expect.stringContaining("埋め込まれた画像")], []]);
		expect((files[1] as StoredFile).body.equals(await readFile(plain))).toBe(true);
	});

	it("refuses an SVG it cannot read, unless --keep-exif is given", async () => {
		const broken = join(dir, "broken.svg");
		await writeFile(broken, '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>');
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [broken], {})).toBe(1);
		expect(json(captured).results[0]?.error?.code).toBe("invalid_svg");
		expect(files).toHaveLength(0);

		const { runtime: keep } = testRuntime(server.url);
		expect(await put(keep, [broken], { keepExif: true })).toBe(0);
		expect((files[0] as StoredFile).body.equals(await readFile(broken))).toBe(true);
	});
});
