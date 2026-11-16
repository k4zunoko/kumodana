import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { put } from "../src/commands/put.ts";
import { endExiftool, stripMetadata } from "../src/exif.ts";
import { formatBytes } from "../src/output.ts";
import { runCommand } from "../src/runtime.ts";
import { allOutput, mockApi, SECRET, sendJson, testRuntime } from "./helpers.ts";

// kumo put <path> --replace <id|url> (specs/005-replace-content), against a stand-in for the admin API.

type StoredFile = { id: string; name: string; contentType: string; body: Buffer; tags: string[] };
type StoredLink = { token: string; fileId: string; label: string | null; revokedAt: string | null };
type Sent = { ifMatch?: string; contentType?: string; sha256?: string; filename?: string; body: Buffer };

const TARGET = "abcdefghjk";
const OTHER = "mnpqrstvwx";
const ACTIVE = "AbCdEfGhIjKlMnOpQrStUv";
const SECOND = "BbBbBbBbBbBbBbBbBbBbBb";
const REVOKED = "CcCcCcCcCcCcCcCcCcCcCc";
const V1 = "<!doctype html><p>しおり 第 1 版</p>";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const url = (token: string) => `https://kumo.example/${token}`;

let files: StoredFile[] = [];
let links: StoredLink[] = [];
let requests: string[] = [];
let sent: Sent[] = [];
let purgeResult: { ok: true } | { ok: false; error: string } = { ok: true };
/** Changes the file just before the replacement arrives, as another client would. */
let changeFirst = false;
/** Drops the connection of the replacement after it is applied, as a lost response. */
let dropResponse = false;
let server: Awaited<ReturnType<typeof mockApi>>;
let dir: string;

function summary(file: StoredFile) {
	return {
		id: file.id,
		name: file.name,
		contentType: file.contentType,
		size: file.body.length,
		sha256: sha(file.body),
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		tags: file.tags,
		activeLinkCount: links.filter((l) => l.fileId === file.id && !l.revokedAt).length,
	};
}

function link(stored: StoredLink) {
	return { ...stored, url: url(stored.token), createdAt: new Date(0).toISOString() };
}

const notFound = (res: ServerResponse) => sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });

beforeEach(async () => {
	files = [
		{ id: TARGET, name: "しおり.html", contentType: "text/html; charset=utf-8", body: Buffer.from(V1), tags: ["旅行"] },
		{ id: OTHER, name: "other.html", contentType: "text/html", body: Buffer.from("<!doctype html><p>other"), tags: [] },
	];
	links = [
		{ token: ACTIVE, fileId: TARGET, label: "Aさん", revokedAt: null },
		{ token: SECOND, fileId: TARGET, label: null, revokedAt: null },
		{ token: REVOKED, fileId: TARGET, label: "Bさん", revokedAt: new Date(1).toISOString() },
	];
	requests = [];
	sent = [];
	purgeResult = { ok: true };
	changeFirst = false;
	dropResponse = false;
	dir = await mkdtemp(join(tmpdir(), "kumo-replace-test-"));
	server = await mockApi((req, body, res) => {
		const path = new URL(req.url ?? "/", "http://x");
		requests.push(`${req.method} ${path.pathname}${path.search}`);
		if (req.method === "GET" && path.pathname === "/api/links") {
			const all = path.searchParams.get("includeRevoked") === "true";
			return sendJson(res, 200, { links: links.filter((l) => all || !l.revokedAt).map(link) });
		}
		if (req.method === "GET" && path.pathname === "/api/files") {
			const wanted = path.searchParams.get("sha256");
			return sendJson(res, 200, { files: files.filter((f) => sha(f.body) === wanted).map(summary), nextCursor: null });
		}
		const match = /^\/api\/files\/(\w+)(\/content|\/links|\/tags)?$/.exec(path.pathname);
		const file = files.find((f) => f.id === match?.[1]);
		if (!match || !file) return notFound(res);
		if (req.method === "GET" && !match[2]) {
			return sendJson(res, 200, { file: summary(file), links: links.filter((l) => l.fileId === file.id).map(link) });
		}
		if (req.method === "PUT" && match[2] === "/content") {
			sent.push({
				ifMatch: req.headers["if-match"],
				contentType: req.headers["content-type"],
				sha256: req.headers["x-kumodana-sha256"] as string | undefined,
				filename: decodeURIComponent(String(req.headers["x-kumodana-filename"])),
				body,
			});
			if (changeFirst) file.body = Buffer.from("<!doctype html><p>changed by someone else");
			const previous = { name: file.name, contentType: file.contentType, size: file.body.length, sha256: sha(file.body) };
			const everLinked = links.some((l) => l.fileId === file.id);
			const purge = everLinked ? purgeResult : null;
			if (sha(body) === previous.sha256) return sendJson(res, 200, { file: summary(file), replaced: false, previous, purge });
			if (req.headers["if-match"] !== `"${previous.sha256}"`) {
				return sendJson(res, 412, { error: { code: "precondition_failed", message: "ファイルの今の内容が、If-Match の SHA-256 と違います。" } });
			}
			Object.assign(file, { name: String(sent.at(-1)?.filename), contentType: String(req.headers["content-type"]), body });
			if (dropResponse) return void req.socket.destroy();
			return sendJson(res, 200, { file: summary(file), replaced: true, previous, purge });
		}
		if (req.method === "PATCH" && match[2] === "/tags") {
			file.tags = [...file.tags, ...((JSON.parse(body.toString()) as { add?: string[] }).add ?? [])];
			return sendJson(res, 200, { tags: file.tags });
		}
		if (req.method === "POST" && match[2] === "/links") {
			const created = { token: "D".repeat(22), fileId: file.id, label: (JSON.parse(body.toString()) as { label?: string }).label ?? null, revokedAt: null };
			links.push(created);
			return sendJson(res, 201, { link: link(created) });
		}
		notFound(res);
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

const replaceRequests = () => requests.filter((r) => r.startsWith("PUT"));

describe("kumo put --replace", () => {
	it("replaces by file ID with the same preprocessing as put: an image goes as the copy without metadata", async () => {
		const path = await fixture("gps.png");
		const original = await readFile(path);
		// What kumo put sends for an image: the copy without metadata. The CLI ends exiftool when a command ends,
		// so in this file only this first test can remove metadata.
		const stripped = await stripMetadata(path);
		const putBody = await readFile(stripped.path);
		await stripped.cleanup();

		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [path], { replace: TARGET })).toBe(0);
		expect(requests).toEqual([
			`GET /api/files/${TARGET}`,
			`GET /api/files?sha256=${sha(putBody)}`,
			`PUT /api/files/${TARGET}/content`,
		]);
		const request = sent[0] as Sent;
		expect(request).toMatchObject({ ifMatch: `"${sha(V1)}"`, contentType: "image/png", filename: "gps.png", sha256: sha(request.body) });
		expect(request.body.equals(putBody)).toBe(true);
		expect(request.body.equals(original)).toBe(false);
		expect(await readFile(path)).toEqual(original);

		const out = captured.stdout.join("\n");
		expect(out).toContain(`${TARGET}  しおり.html → gps.png  ${formatBytes(putBody.length)}  画像  置き換えました`);
		expect(out).toContain(`  リンク: ${url(ACTIVE)}  Aさん`);
		expect(out).toContain(`  リンク: ${url(SECOND)}`);
		expect(out).not.toContain(REVOKED);
		expect(captured.stderr.join("\n")).toContain(`警告: ${path}: 形式の種類が変わりました（HTML → 画像）`);
		expect(allOutput(captured)).not.toContain(SECRET);
	});

	it("sends the original image with --keep-exif and warns that the metadata is kept", async () => {
		const path = await fixture("gps.png");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [path], { replace: TARGET, keepExif: true })).toBe(0);
		expect((sent[0] as Sent).body.equals(await readFile(path))).toBe(true);
		expect(captured.stderr.join("\n")).toContain("--keep-exif を付けたため");
	});

	it("finds the file from a link URL or a token, and sends a Markdown document as HTML", async () => {
		const note = join(dir, "note.md");
		await writeFile(note, "# しおり\n\n- 集合は 9 時\n");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [note], { replace: `${url(ACTIVE)}?utm_source=chat` })).toBe(0);
		expect(requests.slice(0, 2)).toEqual(["GET /api/links?includeRevoked=true", `GET /api/files/${TARGET}`]);
		const request = sent[0] as Sent;
		expect(request).toMatchObject({ contentType: "text/html; charset=utf-8", filename: "note.md.html", ifMatch: `"${sha(V1)}"` });
		expect(request.body.toString()).toMatch(/^<!doctype html>\n/);
		expect(request.body.toString()).toContain("<h1>しおり</h1>");
		expect(captured.stdout.join("\n")).toContain("しおり.html → note.md.html");
		expect(captured.stdout.join("\n")).toContain("Markdown → HTML  置き換えました");
		expect(captured.stderr).toEqual([]);

		const memo = join(dir, "memo.txt");
		await writeFile(memo, "集合は 9 時\n");
		const { runtime: byToken } = testRuntime(server.url);
		expect(await put(byToken, [memo], { replace: SECOND })).toBe(0);
		expect(sent[1]).toMatchObject({ filename: "memo.txt.html", ifMatch: `"${sha(request.body)}"` });
		expect(replaceRequests()).toEqual([`PUT /api/files/${TARGET}/content`, `PUT /api/files/${TARGET}/content`]);
	});

	it("refuses a revoked link, an unknown link, and an unknown file without sending anything", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		for (const [target, code, text] of [
			[url(REVOKED), "link_revoked", "取り消し済みのリンクです"],
			["ZzZzZzZzZzZzZzZzZzZzZz", "not_found", "リンクが見つかりません"],
			["zzzzzzzzzz", "not_found", "置き換えるファイルが見つかりません: zzzzzzzzzz"],
		]) {
			const { runtime, captured } = testRuntime(server.url, true);
			expect(await runCommand(runtime, () => put(runtime, [page], { replace: target })), target).toBe(1);
			const error = JSON.parse(captured.stderr.join("\n")) as { error: { code: string; message: string } };
			expect(error.error.code).toBe(code);
			expect(error.error.message).toContain(text);
		}
		expect(replaceRequests()).toEqual([]);
	});

	it("takes exactly one path and a file ID or a link, otherwise it is a usage error (exit code 2)", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await runCommand(runtime, () => put(runtime, [page, page], { replace: TARGET }))).toBe(2);
		expect(JSON.parse(captured.stderr.join("\n"))).toMatchObject({ error: { code: "invalid_argument" } });

		const { runtime: second, captured: secondOut } = testRuntime(server.url);
		expect(await runCommand(second, () => put(second, [page], { replace: "nope" }))).toBe(2);
		expect(allOutput(secondOut)).toContain("ファイル ID（10 文字）か、リンクの URL");
		expect(requests).toEqual([]);
	});

	it("prints replaced, previous, purge, and the active links with --json", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		const { runtime, captured } = testRuntime(server.url, true);
		expect(await put(runtime, [page], { replace: TARGET })).toBe(0);
		const output = JSON.parse(captured.stdout.join("\n")) as { results: Record<string, unknown>[]; summary: unknown };
		expect(output.results).toEqual([
			{
				path: page,
				kind: "html",
				warnings: [],
				file: expect.objectContaining({ id: TARGET, name: "page.html", contentType: "text/html; charset=utf-8", sha256: sha("<!doctype html><p>v2") }),
				replaced: true,
				previous: { name: "しおり.html", contentType: "text/html; charset=utf-8", size: Buffer.byteLength(V1), sha256: sha(V1) },
				purge: { ok: true },
				links: [expect.objectContaining({ token: ACTIVE, label: "Aさん" }), expect.objectContaining({ token: SECOND })],
			},
		]);
		expect(output.summary).toEqual({ kinds: { html: 1 }, warnings: 0 });
		expect(captured.stderr).toEqual([]);
	});

	it("says the replacement is done when the purge fails, exits with 1, and the same command retries only the purge", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		purgeResult = { ok: false, error: "429: rate limited" };
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [page], { replace: url(ACTIVE) })).toBe(1);
		const warning = captured.stderr.join("\n");
		expect(warning).toContain(`${TARGET} の置き換えは完了しましたが、配信側のキャッシュ削除に失敗しました（429: rate limited）`);
		expect(warning).toContain("同じコマンドで削除をやり直せます");
		expect(warning).toContain("1 時間以内");

		purgeResult = { ok: true };
		const { runtime: again, captured: againOut } = testRuntime(server.url);
		expect(await put(again, [page], { replace: url(ACTIVE) })).toBe(0);
		expect(againOut.stdout.join("\n")).toContain(`${TARGET}  page.html  `);
		expect(againOut.stdout.join("\n")).toContain("内容が同じため、置き換えていません（キャッシュの削除だけをやり直しました）");
		expect(sent.map((s) => s.ifMatch)).toEqual([`"${sha(V1)}"`, `"${sha("<!doctype html><p>v2")}"`]);
	});

	it("explains a change by someone else (412) and content that another file has (409)", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		changeFirst = true;
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [page], { replace: TARGET })).toBe(1);
		expect(allOutput(captured)).toContain("ほかの操作で変わりました");
		expect(allOutput(captured)).toContain("precondition_failed");

		changeFirst = false;
		requests = [];
		const same = join(dir, "same.html");
		await writeFile(same, "<!doctype html><p>other");
		const { runtime: dup, captured: dupOut } = testRuntime(server.url, true);
		expect(await put(dup, [same], { replace: TARGET })).toBe(1);
		const { results } = JSON.parse(dupOut.stdout.join("\n")) as { results: { error: { code: string; message: string } }[] };
		expect(results[0]?.error).toEqual({ code: "duplicate_content", message: expect.stringContaining(`（${OTHER}）`) });
		expect(replaceRequests()).toEqual([]);
	});

	it("says how to retry when the response is lost", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		dropResponse = true;
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [page], { replace: TARGET })).toBe(1);
		expect(allOutput(captured)).toContain("置き換えが済んだかは分かりません。同じコマンドをもう一度実行すると");
	});

	it("tags and links the replaced file with --tag and --link", async () => {
		const page = join(dir, "page.html");
		await writeFile(page, "<!doctype html><p>v2");
		const { runtime, captured } = testRuntime(server.url);
		expect(await put(runtime, [page], { replace: TARGET, tag: ["2026"], link: true, label: "Cさん" })).toBe(0);
		expect(requests.slice(-2)).toEqual([`PATCH /api/files/${TARGET}/tags`, `POST /api/files/${TARGET}/links`]);
		expect(captured.stdout.join("\n")).toContain(`  リンク: ${url("D".repeat(22))}  Cさん`);
		expect(files.find((f) => f.id === TARGET)?.tags).toEqual(["旅行", "2026"]);
	});
});
