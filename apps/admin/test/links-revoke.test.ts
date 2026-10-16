import type { PurgeResult } from "@kumodana/shared/api-types";
import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, testApp } from "./helpers.ts";

const TOKEN_1 = "1111111111111111111111";
const TOKEN_2 = "2222222222222222222222";
const TOKEN_3 = "3333333333333333333333";

let purgeCalls: string[][] = [];
let purgeResult: PurgeResult = { ok: true };
const app = testApp({
	purge: async (_env, tags) => {
		purgeCalls.push(tags);
		return purgeResult;
	},
});

async function seedLink(token: string, fileId: string, createdAt: number, revokedAt: number | null = null) {
	await env.DB.prepare("INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
		.bind(token, fileId, `label-${token[0]}`, createdAt, revokedAt)
		.run();
}

beforeEach(async () => {
	await resetStorage();
	purgeCalls = [];
	purgeResult = { ok: true };
	await seedFile({ id: "fa00000001" });
	await seedFile({ id: "fa00000002" });
	await seedLink(TOKEN_1, "fa00000001", 1000);
	await seedLink(TOKEN_2, "fa00000001", 2000);
	await seedLink(TOKEN_3, "fa00000002", 3000, 3500);
});

describe("DELETE /api/links/:token", () => {
	it("records the revocation and purges the link's cache", async () => {
		const res = await call(app, "DELETE", `/api/links/${TOKEN_1}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { link: { revokedAt: string | null }; purge: PurgeResult };
		expect(body.link.revokedAt).not.toBeNull();
		expect(body.purge).toEqual({ ok: true });
		expect(purgeCalls).toEqual([[`l:${TOKEN_1}`]]);
		const row = await env.DB.prepare("SELECT revoked_at FROM links WHERE token = ?").bind(TOKEN_1).first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();
	});

	it("keeps the revocation and reports a purge failure", async () => {
		purgeResult = { ok: false, error: "429: rate limited" };
		const res = await call(app, "DELETE", `/api/links/${TOKEN_1}`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { purge: PurgeResult }).purge).toEqual({ ok: false, error: "429: rate limited" });
		const row = await env.DB.prepare("SELECT revoked_at FROM links WHERE token = ?").bind(TOKEN_1).first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();
	});

	it("only retries the purge when revoking again", async () => {
		const first = (await (await call(app, "DELETE", `/api/links/${TOKEN_3}`)).json()) as { link: { revokedAt: string } };
		expect(first.link.revokedAt).toBe(new Date(3500).toISOString());
		expect(purgeCalls).toEqual([[`l:${TOKEN_3}`]]);
	});

	it("returns 404 for unknown tokens", async () => {
		expect((await call(app, "DELETE", "/api/links/9999999999999999999999")).status).toBe(404);
		expect((await call(app, "DELETE", "/api/links/not-a-token")).status).toBe(404);
	});
});

describe("GET /api/links", () => {
	it("lists active links newest first", async () => {
		const res = await call(app, "GET", "/api/links");
		const { links } = (await res.json()) as { links: { token: string }[] };
		expect(links.map((l) => l.token)).toEqual([TOKEN_2, TOKEN_1]);
	});

	it("includes revoked links on request and filters by file", async () => {
		const all = (await (await call(app, "GET", "/api/links?includeRevoked=true")).json()) as { links: { token: string }[] };
		expect(all.links.map((l) => l.token)).toEqual([TOKEN_3, TOKEN_2, TOKEN_1]);
		const one = (await (await call(app, "GET", "/api/links?fileId=fa00000002&includeRevoked=true")).json()) as {
			links: { token: string; url: string; revokedAt: string | null }[];
		};
		expect(one.links).toHaveLength(1);
		expect(one.links[0]).toMatchObject({ token: TOKEN_3, url: `${env.FILES_BASE_URL}/${TOKEN_3}` });
		expect(one.links[0]?.revokedAt).not.toBeNull();
	});

	it("validates the query", async () => {
		expect((await call(app, "GET", "/api/links?includeRevoked=maybe")).status).toBe(400);
		expect((await call(app, "GET", "/api/links?fileId=../x")).status).toBe(400);
	});
});
