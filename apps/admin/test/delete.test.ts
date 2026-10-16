import type { PurgeResult } from "@kumodana/shared/api-types";
import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, testApp } from "./helpers.ts";

const ACTIVE = "1111111111111111111111";
const REVOKED = "2222222222222222222222";

type Snapshot = { status: string | undefined; hasObject: boolean; listed: boolean };

let purgeCalls: string[][] = [];
let snapshots: Snapshot[] = [];
let purgeResult: PurgeResult = { ok: true };

async function snapshot(id: string): Promise<Snapshot> {
	const row = await env.DB.prepare("SELECT status FROM files WHERE id = ?").bind(id).first<{ status: string }>();
	const listed = await env.DB.prepare("SELECT 1 FROM files WHERE id = ? AND status = 'ready'").bind(id).first();
	return { status: row?.status, hasObject: (await env.BUCKET.head(`files/${id}`)) !== null, listed: listed !== null };
}

const app = testApp({
	purge: async (_env, tags) => {
		purgeCalls.push(tags);
		const id = (tags[0] ?? "").slice(2);
		snapshots.push(await snapshot(id));
		return purgeResult;
	},
});

async function usedBytes(): Promise<number> {
	const row = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files").first<{ n: number }>();
	return row?.n ?? 0;
}

beforeEach(async () => {
	await resetStorage();
	purgeCalls = [];
	snapshots = [];
	purgeResult = { ok: true };
	await seedFile({ id: "cccc000001", body: "x".repeat(100), tags: ["旅行"] });
	await env.DB.prepare("INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, NULL, 1, NULL), (?, ?, NULL, 2, 3)")
		.bind(ACTIVE, "cccc000001", REVOKED, "cccc000001")
		.run();
});

describe("DELETE /api/files/:id", () => {
	it("revokes links, hides the file, purges, then removes the object and rows", async () => {
		const before = await usedBytes();
		const res = await call(app, "DELETE", "/api/files/cccc000001");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: "cccc000001", revokedLinks: 1, purge: { ok: true } });
		expect(purgeCalls).toEqual([["f:cccc000001"]]);
		// While purging, the file is already out of lists and delivery, and its object still exists.
		expect(snapshots).toEqual([{ status: "deleting", hasObject: true, listed: false }]);
		expect(await snapshot("cccc000001")).toEqual({ status: undefined, hasObject: false, listed: false });
		const links = await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{ n: number }>();
		const tags = await env.DB.prepare("SELECT COUNT(*) AS n FROM file_tags").first<{ n: number }>();
		expect([links?.n, tags?.n]).toEqual([0, 0]);
		expect(await usedBytes()).toBe(before - 100);
	});

	it("skips the purge for files that never had a link", async () => {
		await seedFile({ id: "cccc000002" });
		const res = await call(app, "DELETE", "/api/files/cccc000002");
		expect(await res.json()).toEqual({ deleted: "cccc000002", revokedLinks: 0, purge: null });
		expect(purgeCalls).toEqual([]);
	});

	it("still completes the deletion when the purge fails", async () => {
		purgeResult = { ok: false, error: "429: rate limited" };
		const res = await call(app, "DELETE", "/api/files/cccc000001");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ purge: { ok: false, error: "429: rate limited" } });
		expect(await snapshot("cccc000001")).toEqual({ status: undefined, hasObject: false, listed: false });
	});

	it("resumes a deletion that stopped midway", async () => {
		await env.DB.prepare("UPDATE files SET status = 'deleting' WHERE id = 'cccc000001'").run();
		const res = await call(app, "DELETE", "/api/files/cccc000001");
		expect(res.status).toBe(200);
		expect(purgeCalls).toEqual([["f:cccc000001"]]);
		expect(await snapshot("cccc000001")).toEqual({ status: undefined, hasObject: false, listed: false });
	});

	it("returns 404 for pending and unknown files", async () => {
		await seedFile({ id: "cccc000003", status: "pending" });
		expect((await call(app, "DELETE", "/api/files/cccc000003")).status).toBe(404);
		expect((await call(app, "DELETE", "/api/files/none000001")).status).toBe(404);
	});
});
