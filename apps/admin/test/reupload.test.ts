import { beforeEach, describe, expect, it } from "vitest";
import { call, deferred, env, lateFirstLookup, resetStorage, seedFile, sha256Hex, testApp } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60 * 1000;
const app = testApp({ now: () => NOW });

type UploadOptions = { app?: ReturnType<typeof testApp>; env?: Partial<Record<keyof Env, unknown>> };

async function upload(body: string, options: UploadOptions = {}) {
	const bytes = new TextEncoder().encode(body);
	return call(options.app ?? app, "PUT", "/api/files", {
		headers: {
			"Content-Type": "image/png",
			"Content-Length": String(bytes.length),
			"X-Kumodana-Sha256": await sha256Hex(bytes),
			"X-Kumodana-Filename": "again.png",
		},
		body: bytes,
		env: options.env,
	});
}

beforeEach(resetStorage);

describe("re-uploading after an interrupted upload", () => {
	it("replaces a pending duplicate updated more than 10 minutes ago", async () => {
		await seedFile({ id: "stale00001", body: "same", status: "pending", createdAt: NOW - 11 * MINUTE });
		const res = await upload("same");
		expect(res.status).toBe(201);
		const { file } = (await res.json()) as { file: { id: string } };
		expect(file.id).not.toBe("stale00001");
		expect(await env.DB.prepare("SELECT id FROM files WHERE id = 'stale00001'").first()).toBeNull();
		expect(await env.BUCKET.head("files/stale00001")).toBeNull();
	});

	it("answers 409 with the wait time within 10 minutes", async () => {
		await seedFile({ id: "fresh00001", body: "same", status: "pending", createdAt: NOW - 4 * MINUTE });
		const res = await upload("same");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: "upload_in_progress", details: { retryAfterSeconds: 360 } } });
	});

	it("is not blocked by a deleting file with the same content", async () => {
		await seedFile({ id: "dele000001", body: "same", status: "deleting" });
		const res = await upload("same");
		expect(res.status).toBe(201);
	});
});

describe("a lookup of a pending upload that arrives after the upload is done", () => {
	it("answers with the file the upload made, and does not remove it", async () => {
		// Another upload of the same content reads the pending row at 9:59.9; the first upload ends before 10 minutes,
		// and the lookup arrives 200 ms late, when the row looks 10 minutes old (the order found in the review of PR #27).
		let now = NOW;
		const clockApp = testApp({ now: () => now });
		const stored = deferred();
		const looked = deferred();
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
		const first = upload("same", { app: clockApp, env: { BUCKET: waitsAfterStoring } });
		await stored.promise;
		now = NOW + 10 * MINUTE - 100;
		const late = lateFirstLookup(async () => {
			looked.resolve();
			await first;
			now = NOW + 10 * MINUTE + 100;
		});
		const second = await upload("same", { app: clockApp, env: { DB: late.db } });

		const firstResponse = await first;
		expect(firstResponse.status).toBe(201);
		const { file } = (await firstResponse.json()) as { file: { id: string } };
		expect(late.lookups[0]).toMatchObject({ id: file.id, status: "pending", updated_at: NOW });
		const { results } = await env.DB.prepare("SELECT id, status, r2_key FROM files").all();
		expect(results).toEqual([{ id: file.id, status: "ready", r2_key: `files/${file.id}` }]);
		expect(await (await env.BUCKET.get(`files/${file.id}`))?.text()).toBe("same");
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ duplicate: true, file: { id: file.id } });
	});
});
