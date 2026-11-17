import type { FileDetailResponse, PurgeResult, ReplaceContentResponse } from "@kumodana/shared/api-types";
import { beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.ts";
import { claimStalePending, switchContent } from "../src/db/files.ts";
import { call, deferred, env, lateFirstLookup, resetStorage, seedFile, sha256Hex, testApp } from "./helpers.ts";

// specs/005-replace-content: PUT /api/files/{id}/content.

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const MINUTE = 60 * 1000;
const TARGET = "tttt000001";
const ACTIVE = "1111111111111111111111";
const REVOKED = "2222222222222222222222";
const ORIGINAL = "<!doctype html><p>旅のしおり（第 1 版）";
const NEW = "png: 旅のしおりの地図（第 2 版）";

type Row = { id: string; status: string; r2_key: string; size: number };
type Storage = { rows: Row[]; keys: string[] };

let now = NOW;
let purgeCalls: string[][] = [];
let purgeResult: PurgeResult = { ok: true };
let duringPurge: Storage[] = [];

async function storage(): Promise<Storage> {
	const { results } = await env.DB.prepare("SELECT id, status, r2_key, size FROM files ORDER BY id").all<Row>();
	const listed = await env.BUCKET.list();
	return { rows: results, keys: listed.objects.map((o) => o.key).sort() };
}

const app = testApp({
	now: () => now,
	purge: async (_env, tags) => {
		purgeCalls.push(tags);
		duringPurge.push(await storage());
		return purgeResult;
	},
});

type ReplaceOptions = {
	id?: string;
	contentType?: string;
	filename?: string;
	sha256?: string;
	/** The If-Match header; null leaves it out. Defaults to the SHA-256 of ORIGINAL in quotes. */
	ifMatch?: string | null;
	env?: Partial<Record<keyof Env, unknown>>;
	/** The app to call. Defaults to the one above. */
	app?: ReturnType<typeof testApp>;
};

async function replace(body: string, options: ReplaceOptions = {}): Promise<Response> {
	const bytes = new TextEncoder().encode(body);
	const headers: Record<string, string> = {
		"Content-Type": options.contentType ?? "image/png",
		"Content-Length": String(bytes.length),
		"X-Kumodana-Sha256": options.sha256 ?? (await sha256Hex(bytes)),
		"X-Kumodana-Filename": encodeURIComponent(options.filename ?? "しおり-v2.png"),
	};
	const ifMatch = options.ifMatch === undefined ? `"${await sha256Hex(ORIGINAL)}"` : options.ifMatch;
	if (ifMatch !== null) headers["If-Match"] = ifMatch;
	return call(options.app ?? app, "PUT", `/api/files/${options.id ?? TARGET}/content`, { headers, body: bytes, env: options.env });
}

async function detail(id = TARGET): Promise<FileDetailResponse> {
	const res = await call(app, "GET", `/api/files/${id}`);
	expect(res.status).toBe(200);
	return (await res.json()) as FileDetailResponse;
}

/** What a viewer gets for a token: the lookup of the delivery Worker (apps/files/src/index.ts), then the R2 object. */
async function delivered(token: string) {
	const row = await env.DB.prepare(
		`SELECT f.id, f.r2_key, f.name, f.content_type, f.size, f.sha256
		 FROM links l JOIN files f ON f.id = l.file_id
		 WHERE l.token = ? AND l.revoked_at IS NULL AND f.status = 'ready'`,
	)
		.bind(token)
		.first<{ r2_key: string; name: string; content_type: string; size: number; sha256: string }>();
	if (!row) return null;
	const object = await env.BUCKET.get(row.r2_key);
	return { name: row.name, contentType: row.content_type, size: row.size, etag: `"${row.sha256}"`, body: (await object?.text()) ?? null };
}

/** Constitution III: every ready row has its R2 object. */
async function expectReadyRowsHaveObjects(): Promise<void> {
	const { results } = await env.DB.prepare("SELECT r2_key FROM files WHERE status = 'ready'").all<{ r2_key: string }>();
	for (const row of results) expect(await env.BUCKET.head(row.r2_key), row.r2_key).not.toBeNull();
}

async function usedBytes(): Promise<number> {
	const row = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files").first<{ n: number }>();
	return row?.n ?? 0;
}

function bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

beforeEach(async () => {
	await resetStorage();
	now = NOW;
	purgeCalls = [];
	purgeResult = { ok: true };
	duringPurge = [];
	await seedFile({
		id: TARGET,
		name: "しおり.html",
		contentType: "text/html; charset=utf-8",
		body: ORIGINAL,
		tags: ["2026", "旅行"],
		createdAt: NOW - 60 * MINUTE,
	});
	await env.DB.prepare(
		"INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, 'Aさん', ?, NULL), (?, ?, 'Bさん', ?, ?)",
	)
		.bind(ACTIVE, TARGET, NOW - 50 * MINUTE, REVOKED, TARGET, NOW - 40 * MINUTE, NOW - 30 * MINUTE)
		.run();
});

describe("PUT /api/files/:id/content", () => {
	it("serves the new content with its own headers on the same link, and the revoked link stays 404", async () => {
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
		const res = await replace(NEW);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ReplaceContentResponse;
		const newSha = await sha256Hex(NEW);
		expect(body).toEqual({
			file: expect.objectContaining({
				id: TARGET,
				name: "しおり-v2.png",
				contentType: "image/png",
				size: bytes(NEW),
				sha256: newSha,
				updatedAt: new Date(NOW).toISOString(),
			}),
			replaced: true,
			previous: {
				name: "しおり.html",
				contentType: "text/html; charset=utf-8",
				size: bytes(ORIGINAL),
				sha256: await sha256Hex(ORIGINAL),
			},
			purge: { ok: true },
		});
		expect(await delivered(ACTIVE)).toEqual({
			name: "しおり-v2.png",
			contentType: "image/png",
			size: bytes(NEW),
			etag: `"${newSha}"`,
			body: NEW,
		});
		expect(await delivered(REVOKED)).toBeNull();

		// kumo get (the owner's download) returns the new content under the new name.
		const content = await call(app, "GET", `/api/files/${TARGET}/content`);
		expect(content.status).toBe(200);
		expect(new TextDecoder().decode(await content.arrayBuffer())).toBe(NEW);
		expect(content.headers.get("Content-Type")).toBe("image/png");
		expect(content.headers.get("Content-Disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("しおり-v2.png")}`);
	});

	it("keeps the ID, creation time, tags, and every link with its token, URL, label, and dates", async () => {
		const before = await detail();
		expect(before.links).toHaveLength(2);
		expect((await replace(NEW)).status).toBe(200);
		const after = await detail();
		expect(after.links).toEqual(before.links);
		const { id, createdAt, tags, activeLinkCount } = before.file;
		expect(after.file).toMatchObject({ id, createdAt, tags, activeLinkCount });
		expect(after.file.updatedAt).toBe(new Date(NOW).toISOString());
		expect(after.file.createdAt).toBe(new Date(NOW - 60 * MINUTE).toISOString());
	});

	it("purges f:<id> once while the old object still exists, then removes the old object and row", async () => {
		const before = await storage();
		expect((await replace(NEW)).status).toBe(200);
		expect(purgeCalls).toEqual([[`f:${TARGET}`]]);

		const after = await storage();
		const newKey = after.rows[0]?.r2_key ?? "";
		expect(newKey).toMatch(new RegExp(`^files/${TARGET}/[0-9a-hjkmnp-tv-z]{10}$`));
		expect(after).toEqual({ rows: [{ id: TARGET, status: "ready", r2_key: newKey, size: bytes(NEW) }], keys: [newKey] });
		// While purging, the file already had the new content and the old content waited as a deleting row.
		const oldRow = { id: expect.any(String), status: "deleting", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) };
		expect(duringPurge).toHaveLength(1);
		expect(duringPurge[0]?.rows).toHaveLength(2);
		expect(duringPurge[0]?.rows).toEqual(expect.arrayContaining([after.rows[0], oldRow]));
		expect(duringPurge[0]?.keys).toEqual([...before.keys, newKey].sort());
		expect(await usedBytes()).toBe(bytes(NEW));
	});

	it("does not purge a file that never had a link", async () => {
		await seedFile({ id: "nnnn000001", body: "no links" });
		const res = await replace(NEW, { id: "nnnn000001", ifMatch: `"${await sha256Hex("no links")}"` });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ replaced: true, purge: null });
		expect(purgeCalls).toEqual([]);
	});

	it("completes the replacement when the purge fails and reports it", async () => {
		purgeResult = { ok: false, error: "429: rate limited" };
		const res = await replace(NEW);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ replaced: true, purge: { ok: false, error: "429: rate limited" } });
		expect((await delivered(ACTIVE))?.body).toBe(NEW);
		expect((await storage()).keys).toHaveLength(1);
	});

	it("changes nothing and retries only the purge for the same content, also with the If-Match of a lost response", async () => {
		const res = await replace(ORIGINAL, { contentType: "text/html; charset=utf-8", filename: "別の名前.html" });
		expect(res.status).toBe(200);
		const same = (await res.json()) as ReplaceContentResponse;
		expect(same).toMatchObject({ replaced: false, purge: { ok: true }, file: { name: "しおり.html" } });
		expect(same.previous).toEqual({
			name: same.file.name,
			contentType: same.file.contentType,
			size: same.file.size,
			sha256: same.file.sha256,
		});
		expect(same.file.updatedAt).toBe(new Date(NOW - 60 * MINUTE).toISOString());
		expect(await storage()).toEqual({
			rows: [{ id: TARGET, status: "ready", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) }],
			keys: [`files/${TARGET}`],
		});
		expect(purgeCalls).toEqual([[`f:${TARGET}`]]);

		// Replace, then send the very same request again (its If-Match is now out of date): only the purge again.
		expect((await replace(NEW)).status).toBe(200);
		const after = await storage();
		now = NOW + MINUTE;
		const again = await replace(NEW);
		expect(again.status).toBe(200);
		expect(await again.json()).toMatchObject({ replaced: false, purge: { ok: true } });
		expect(await storage()).toEqual(after);
		expect(purgeCalls).toHaveLength(3);
	});

	it("can go back to an earlier content: the new content gets a new key every time", async () => {
		expect((await replace(NEW)).status).toBe(200);
		const middle = await storage();
		const back = await replace(ORIGINAL, {
			contentType: "text/html; charset=utf-8",
			filename: "しおり.html",
			ifMatch: `"${await sha256Hex(NEW)}"`,
		});
		expect(back.status).toBe(200);
		const after = await storage();
		expect(after.rows).toHaveLength(1);
		expect(after.keys).toEqual([after.rows[0]?.r2_key]);
		expect(after.keys[0]).not.toBe(middle.keys[0]);
		expect(after.keys[0]).not.toBe(`files/${TARGET}`);
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
	});

	it("can delete a replaced file", async () => {
		expect((await replace(NEW)).status).toBe(200);
		const res = await call(app, "DELETE", `/api/files/${TARGET}`);
		expect(res.status).toBe(200);
		expect(await storage()).toEqual({ rows: [], keys: [] });
	});

	describe("changes nothing when it refuses", () => {
		let before: Storage;
		let beforeDetail: FileDetailResponse;

		beforeEach(async () => {
			await seedFile({ id: "dddd000001", body: "other file" });
			before = await storage();
			beforeDetail = await detail();
		});

		async function expectUnchanged(): Promise<void> {
			expect(await storage()).toEqual(before);
			expect(await detail()).toEqual(beforeDetail);
			expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
			expect(purgeCalls).toEqual([]);
		}

		it("answers 412 when If-Match is not the current SHA-256", async () => {
			const res = await replace(NEW, { ifMatch: `"${await sha256Hex("an older content")}"` });
			expect(res.status).toBe(412);
			expect(await res.json()).toMatchObject({ error: { code: "precondition_failed" } });
			await expectUnchanged();
		});

		it("requires If-Match with the SHA-256 in double quotes", async () => {
			const sha = await sha256Hex(ORIGINAL);
			for (const ifMatch of [null, sha, "*", `W/"${sha}"`, `"${sha.toUpperCase()}"`]) {
				const res = await replace(NEW, { ifMatch });
				expect(res.status, String(ifMatch)).toBe(400);
				expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
			}
			await expectUnchanged();
		});

		it("answers 409 with the other file's ID when another file already has the content", async () => {
			const res = await replace("other file");
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: { code: "duplicate_content", details: { fileId: "dddd000001" } } });
			await expectUnchanged();
		});

		it("answers 404 unless the file is ready", async () => {
			await seedFile({ id: "pend000001", status: "pending", body: "pending" });
			await seedFile({ id: "dele000001", status: "deleting", body: "deleting" });
			before = await storage();
			for (const id of ["pend000001", "dele000001", "none000001"]) {
				const res = await replace(NEW, { id });
				expect(res.status, id).toBe(404);
				expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
			}
			await expectUnchanged();
		});

		it("validates the content headers as an upload does", async () => {
			expect((await replace(NEW, { contentType: "video/mp4" })).status).toBe(415);
			expect((await replace(NEW, { filename: "dir/name.png" })).status).toBe(400);
			expect((await replace(NEW, { sha256: "ABC" })).status).toBe(400);
			await expectUnchanged();
		});

		it("answers 422 when the content does not match its SHA-256", async () => {
			const res = await replace(NEW, { sha256: await sha256Hex("something else") });
			expect(res.status).toBe(422);
			expect(await res.json()).toMatchObject({ error: { code: "checksum_mismatch" } });
			await expectUnchanged();
		});

		it("answers 502 when R2 cannot store the content", async () => {
			const failing = {
				put: async () => {
					throw new Error("R2 is unavailable");
				},
				get: (key: string) => env.BUCKET.get(key),
				head: (key: string) => env.BUCKET.head(key),
				delete: (keys: string | string[]) => env.BUCKET.delete(keys),
			};
			const res = await replace(NEW, { env: { BUCKET: failing } });
			expect(res.status).toBe(502);
			expect(await res.json()).toMatchObject({ error: { code: "storage_error" } });
			await expectUnchanged();
		});
	});

	it("answers 409 while the same content is still uploading, and replaces a pending one left for over 10 minutes", async () => {
		await seedFile({ id: "pend000001", status: "pending", body: NEW, updatedAt: NOW - 4 * MINUTE });
		const busy = await replace(NEW);
		expect(busy.status).toBe(409);
		expect(await busy.json()).toMatchObject({ error: { code: "upload_in_progress", details: { retryAfterSeconds: 360 } } });
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);

		now = NOW + 7 * MINUTE;
		expect((await replace(NEW)).status).toBe(200);
		expect(await env.DB.prepare("SELECT id FROM files WHERE id = 'pend000001'").first()).toBeNull();
		expect(await env.BUCKET.head("files/pend000001")).toBeNull();
		expect((await delivered(ACTIVE))?.body).toBe(NEW);
	});

	describe("storage limit (STORAGE_LIMIT_BYTES = 1000 in tests)", () => {
		beforeEach(async () => {
			// 900 bytes in use, with the file to replace.
			await seedFile({ id: "ffff000001", body: "f".repeat(900 - bytes(ORIGINAL)) });
		});

		it("counts the old and the new content together and refuses with usage, limit, and requested size", async () => {
			const before = await storage();
			const res = await replace("n".repeat(101));
			expect(res.status).toBe(413);
			expect(await res.json()).toMatchObject({
				error: { code: "quota_exceeded", details: { usedBytes: 900, limitBytes: 1000, requestedBytes: 101 } },
			});
			expect(await storage()).toEqual(before);
			expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
		});

		it("counts only the new content after the replacement", async () => {
			expect((await replace("n".repeat(100))).status).toBe(200);
			expect(await usedBytes()).toBe(900 - bytes(ORIGINAL) + 100);
			const usage = await call(app, "GET", "/api/usage");
			expect(await usage.json()).toMatchObject({ usedBytes: 900 - bytes(ORIGINAL) + 100, fileCount: 2 });
		});
	});

	it("lets one of two replacements at the same time win; the other gets 412 and leaves nothing", async () => {
		const results = await Promise.all([replace("first new content"), replace("second new content")]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
		const after = await storage();
		expect(after.rows).toHaveLength(1);
		expect(after.keys).toEqual([after.rows[0]?.r2_key]);
		expect(["first new content", "second new content"]).toContain((await delivered(ACTIVE))?.body);
		await expectReadyRowsHaveObjects();
	});
});

describe("a replacement that takes long or meets a deletion", () => {
	it("does not switch to new content that took 10 minutes or more to store, and leaves nothing", async () => {
		// Storing ends 10 minutes after the pending row was made: by then it may be taken over (FR-008).
		const slow = {
			put: async (key: string, value: ReadableStream | null, options?: R2PutOptions) => {
				const object = await env.BUCKET.put(key, value, options);
				now += 10 * MINUTE;
				return object;
			},
			get: (key: string) => env.BUCKET.get(key),
			head: (key: string) => env.BUCKET.head(key),
			delete: (keys: string | string[]) => env.BUCKET.delete(keys),
		};
		const before = await storage();
		const res = await replace(NEW, { env: { BUCKET: slow } });
		expect(res.status).toBe(502);
		expect(await res.json()).toMatchObject({ error: { code: "storage_error", message: expect.stringContaining("10 分") } });
		expect(await storage()).toEqual(before);
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
	});

	it("deletes the new object when a replacement switched the file just before the deletion marked it", async () => {
		// The pending row of a replacement, stored and about to be switched.
		const newKey = `files/${TARGET}/pend000001`;
		await seedFile({ id: "pend000001", status: "pending", body: NEW, r2Key: newKey, updatedAt: NOW });
		let switched = false;
		const db = {
			prepare: (query: string) => env.DB.prepare(query),
			batch: async (statements: D1PreparedStatement[]) => {
				// The deletion has read the file (with its old key); the replacement switches right before it is marked.
				if (!switched) {
					switched = await switchContent(env.DB, {
						targetId: TARGET,
						expectedSha256: await sha256Hex(ORIGINAL),
						pendingId: "pend000001",
						r2Key: newKey,
						name: "しおり-v2.png",
						contentType: "image/png",
						size: bytes(NEW),
						sha256: await sha256Hex(NEW),
						now: NOW,
						maxPendingAgeMs: 10 * MINUTE,
					});
				}
				return env.DB.batch(statements);
			},
		};
		const res = await call(app, "DELETE", `/api/files/${TARGET}`, { env: { DB: db } });
		expect(res.status).toBe(200);
		expect(switched).toBe(true);
		// The file and its new object are gone. The old content is the replacement's leftover row, for the cron.
		expect(await storage()).toEqual({
			rows: [{ id: "pend000001", status: "deleting", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) }],
			keys: [`files/${TARGET}`],
		});
		await runCleanup(env, NOW + 16 * MINUTE);
		expect(await storage()).toEqual({ rows: [], keys: [] });
	});
});

describe("another request whose lookup of the new content arrives after the switch", () => {
	// The order found in the review of PR #27: another request with the same content reads the replacement's pending row
	// when it is 9:59.9 old, the replacement switches the file to it before 10 minutes, and the lookup arrives 200 ms
	// late, when the row looks 10 minutes old. The other request must not remove the object the file now has
	// (constitution III), nor the row that now holds the old content.
	async function raceWithReplacement(other: (db: unknown) => Promise<Response>) {
		const stored = deferred(); // the replacement has made its pending row (at NOW) and stored the new content
		const looked = deferred(); // the other request has read that pending row
		const switched = deferred(); // the replacement has switched the file and purges before removing the old content
		const otherDone = deferred();

		const replacing = testApp({
			now: () => now,
			purge: async () => {
				switched.resolve();
				await otherDone.promise;
				return { ok: true };
			},
		});
		const waitsAfterStoring = {
			put: async (key: string, value: ReadableStream | null, options?: R2PutOptions) => {
				const object = await env.BUCKET.put(key, value, options);
				stored.resolve();
				await looked.promise;
				return object;
			},
			get: (key: string) => env.BUCKET.get(key),
			head: (key: string) => env.BUCKET.head(key),
			delete: (keys: string | string[]) => env.BUCKET.delete(keys),
		};
		// The other request's first lookup by SHA-256 reads D1 at 9:59.9 and arrives after the switch, at 10:00.1.
		const late = lateFirstLookup(async () => {
			looked.resolve();
			await switched.promise;
			now = NOW + 10 * MINUTE + 100;
		});

		const replacement = replace(NEW, { app: replacing, env: { BUCKET: waitsAfterStoring } });
		await stored.promise;
		now = NOW + 10 * MINUTE - 100;
		const otherResponse = await other(late.db);
		const whenOtherDone = await storage();
		otherDone.resolve();
		const replaced = await replacement;

		// The lookup that arrived late saw the pending row of the new content, made at NOW.
		const seen = late.lookups[0] as (Row & { sha256: string; updated_at: number }) | null;
		expect(seen).toMatchObject({ status: "pending", sha256: await sha256Hex(NEW), updated_at: NOW });
		// When the other request was done, the file had its new object (the row's old key), and the row still held the
		// old content with its object, for the replacement to remove.
		const file = whenOtherDone.rows.find((r) => r.id === TARGET);
		expect(file).toMatchObject({ status: "ready", r2_key: seen?.r2_key, size: bytes(NEW) });
		expect(whenOtherDone.keys).toContain(seen?.r2_key);
		expect(whenOtherDone.rows).toContainEqual({
			id: seen?.id,
			status: "deleting",
			r2_key: `files/${TARGET}`,
			size: bytes(ORIGINAL),
		});
		expect(whenOtherDone.keys).toContain(`files/${TARGET}`);
		return { replaced, other: otherResponse };
	}

	/** The file has the new content and its object; the old content and the pending row are gone. */
	async function expectReplacedAndClean(others: Row[] = [], otherKeys: string[] = []): Promise<void> {
		await expectReadyRowsHaveObjects();
		expect((await delivered(ACTIVE))?.body).toBe(NEW);
		const after = await storage();
		const file = after.rows.find((r) => r.id === TARGET);
		expect(file).toMatchObject({ status: "ready", size: bytes(NEW) });
		expect(file?.r2_key).toMatch(new RegExp(`^files/${TARGET}/`));
		expect(after).toEqual({
			rows: [file, ...others].sort((a, b) => (a?.id ?? "").localeCompare(b?.id ?? "")),
			keys: [file?.r2_key, ...otherKeys].sort(),
		});
	}

	it("an upload of the same content: answers that the file has it, and the file keeps its new object", async () => {
		const { replaced, other } = await raceWithReplacement(async (db) => {
			const body = new TextEncoder().encode(NEW);
			const headers = {
				"Content-Type": "image/png",
				"Content-Length": String(body.length),
				"X-Kumodana-Sha256": await sha256Hex(body),
				"X-Kumodana-Filename": "same.png",
			};
			return call(app, "PUT", "/api/files", { headers, body, env: { DB: db } });
		});
		await expectReplacedAndClean();
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({ replaced: true, file: { id: TARGET } });
		expect(other.status).toBe(200);
		expect(await other.json()).toMatchObject({ duplicate: true, file: { id: TARGET, sha256: await sha256Hex(NEW) } });
	});

	it("a replacement of another file with the same content: answers 409 with this file's ID, and changes neither", async () => {
		await seedFile({ id: "dddd000001", body: "other file" });
		const { replaced, other } = await raceWithReplacement(async (db) =>
			replace(NEW, { id: "dddd000001", ifMatch: `"${await sha256Hex("other file")}"`, env: { DB: db } }),
		);
		const otherFile = { id: "dddd000001", status: "ready", r2_key: "files/dddd000001", size: bytes("other file") };
		await expectReplacedAndClean([otherFile], ["files/dddd000001"]);
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({ replaced: true, file: { id: TARGET } });
		expect(other.status).toBe(409);
		expect(await other.json()).toMatchObject({ error: { code: "duplicate_content", details: { fileId: TARGET } } });
	});

	it("a replacement of this file with the same content: answers that it already has it, as a retry would", async () => {
		const { replaced, other } = await raceWithReplacement((db) => replace(NEW, { env: { DB: db } }));
		await expectReplacedAndClean();
		expect(replaced.status).toBe(200);
		expect(await replaced.json()).toMatchObject({ replaced: true, file: { id: TARGET } });
		expect(other.status).toBe(200);
		expect(await other.json()).toMatchObject({ replaced: false, file: { id: TARGET, sha256: await sha256Hex(NEW) } });
	});
});

describe("taking over a pending row and switching to it", () => {
	// The replacement's switch and another request's claim (FR-008) need the same pending row, so only one can win.
	const newKey = `files/${TARGET}/pend000001`;
	const pendingRow = { id: "pend000001", r2_key: newKey, updated_at: NOW };

	beforeEach(async () => {
		await seedFile({ id: "pend000001", status: "pending", body: NEW, r2Key: newKey, updatedAt: NOW });
	});

	async function switchTo(at: number, maxPendingAgeMs = 10 * MINUTE): Promise<boolean> {
		return switchContent(env.DB, {
			targetId: TARGET,
			expectedSha256: await sha256Hex(ORIGINAL),
			pendingId: "pend000001",
			r2Key: newKey,
			name: "しおり-v2.png",
			contentType: "image/png",
			size: bytes(NEW),
			sha256: await sha256Hex(NEW),
			now: at,
			maxPendingAgeMs,
		});
	}

	it("a claim after the switch fails, and the row that holds the old content stays", async () => {
		expect(await switchTo(NOW + 10 * MINUTE - 100)).toBe(true);
		const switched = await storage();
		expect(await claimStalePending(env.DB, pendingRow, NOW + 10 * MINUTE + 100)).toBe(false);
		expect(await storage()).toEqual(switched);
		expect(switched.rows).toEqual([
			{ id: "pend000001", status: "deleting", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) },
			{ id: TARGET, status: "ready", r2_key: newKey, size: bytes(NEW) },
		]);
	});

	it("a switch after the claim fails, even without the 10-minute limit, and the file keeps its content", async () => {
		expect(await claimStalePending(env.DB, pendingRow, NOW + 10 * MINUTE + 100)).toBe(true);
		expect(await switchTo(NOW + 10 * MINUTE - 100, Number.MAX_SAFE_INTEGER)).toBe(false);
		const after = await storage();
		expect(after.rows).toEqual([
			{ id: "pend000001", status: "deleting", r2_key: newKey, size: bytes(NEW) },
			{ id: TARGET, status: "ready", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) },
		]);
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
		// A second claim of the same row fails too.
		expect(await claimStalePending(env.DB, pendingRow, NOW + 10 * MINUTE + 200)).toBe(false);
	});

	it("claims only the row as it was read", async () => {
		for (const changed of [{ r2_key: `files/${TARGET}/pend000002` }, { updated_at: NOW + 1 }, { id: "pend000002" }]) {
			expect(await claimStalePending(env.DB, { ...pendingRow, ...changed }, NOW + 11 * MINUTE)).toBe(false);
		}
		expect((await storage()).rows).toContainEqual({ id: "pend000001", status: "pending", r2_key: newKey, size: bytes(NEW) });
	});
});

describe("a replacement that stops midway", () => {
	it("before the switch: the file keeps its content, and the cron removes the new content", async () => {
		// The pending row and object of the new content, as left when the Worker stopped right after storing it.
		const leftover = `files/${TARGET}/pend000001`;
		await seedFile({ id: "pend000001", status: "pending", body: NEW, r2Key: leftover, updatedAt: NOW });
		expect((await delivered(ACTIVE))?.body).toBe(ORIGINAL);
		const content = await call(app, "GET", `/api/files/${TARGET}/content`);
		expect(await content.text()).toBe(ORIGINAL);
		await expectReadyRowsHaveObjects();

		await runCleanup(env, NOW + 31 * MINUTE);
		expect(await storage()).toEqual({
			rows: [{ id: TARGET, status: "ready", r2_key: `files/${TARGET}`, size: bytes(ORIGINAL) }],
			keys: [`files/${TARGET}`],
		});
	});

	it("after the switch: the file has the new content, and the cron removes the old content", async () => {
		// Removing the old object fails, as if the Worker stopped after the switch and the purge.
		const keepsObjects = {
			put: (key: string, value: ReadableStream | null, options?: R2PutOptions) => env.BUCKET.put(key, value, options),
			get: (key: string) => env.BUCKET.get(key),
			head: (key: string) => env.BUCKET.head(key),
			delete: async () => {
				throw new Error("stopped");
			},
		};
		const res = await replace(NEW, { env: { BUCKET: keepsObjects } });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ replaced: true, purge: { ok: true } });
		const left = await storage();
		expect(left.rows.map((r) => [r.status, r.size]).sort()).toEqual([["deleting", bytes(ORIGINAL)], ["ready", bytes(NEW)]]);
		expect(left.keys).toHaveLength(2);
		expect((await delivered(ACTIVE))?.body).toBe(NEW);
		await expectReadyRowsHaveObjects();

		await runCleanup(env, NOW + 14 * MINUTE);
		expect(await storage()).toEqual(left);
		await runCleanup(env, NOW + 16 * MINUTE);
		const after = await storage();
		expect(after.rows).toEqual([expect.objectContaining({ id: TARGET, status: "ready", size: bytes(NEW) })]);
		expect(after.keys).toEqual([after.rows[0]?.r2_key]);
		expect(await usedBytes()).toBe(bytes(NEW));
	});
});
