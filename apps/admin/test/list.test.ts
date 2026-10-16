import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, testApp } from "./helpers.ts";

const app = testApp();

type ListBody = { files: { id: string; tags: string[]; activeLinkCount: number }[]; nextCursor: string | null };

async function list(query = ""): Promise<ListBody> {
	const res = await call(app, "GET", `/api/files${query}`);
	expect(res.status).toBe(200);
	return (await res.json()) as ListBody;
}

beforeEach(async () => {
	await resetStorage();
	await seedFile({ id: "aaaa000001", createdAt: 1000, tags: ["旅行", "2026"] });
	await seedFile({ id: "aaaa000002", createdAt: 2000, tags: ["旅行", "2025"] });
	await seedFile({ id: "aaaa000003", createdAt: 3000, tags: ["家族"] });
	await seedFile({ id: "aaaa000004", createdAt: 4000, tags: ["旅行"], status: "pending" });
	await seedFile({ id: "aaaa000005", createdAt: 5000, tags: ["旅行"], status: "deleting" });
	await env.DB.prepare("INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, NULL, 1, NULL), (?, ?, NULL, 2, 3)")
		.bind("1111111111111111111111", "aaaa000001", "2222222222222222222222", "aaaa000001")
		.run();
});

describe("GET /api/files", () => {
	it("lists ready files newest first with every summary field", async () => {
		const body = await list();
		expect(body.files.map((f) => f.id)).toEqual(["aaaa000003", "aaaa000002", "aaaa000001"]);
		expect(body.nextCursor).toBeNull();
		expect(body.files[2]).toEqual({
			id: "aaaa000001",
			name: "aaaa000001.png",
			contentType: "image/png",
			size: "content-aaaa000001".length,
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			createdAt: new Date(1000).toISOString(),
			tags: ["2026", "旅行"],
			activeLinkCount: 1,
		});
	});

	it("filters by one tag and by several tags (AND), normalizing the query", async () => {
		expect((await list(`?tag=${encodeURIComponent("旅行")}`)).files.map((f) => f.id)).toEqual(["aaaa000002", "aaaa000001"]);
		expect(
			(await list(`?tag=${encodeURIComponent(" 旅行 ")}&tag=2026`)).files.map((f) => f.id),
		).toEqual(["aaaa000001"]);
		expect((await list("?tag=unknown")).files).toEqual([]);
	});

	it("rejects more than 10 tags and invalid tags", async () => {
		const many = Array.from({ length: 11 }, (_, i) => `tag=t${i}`).join("&");
		const res = await call(app, "GET", `/api/files?${many}`);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "invalid_tag" } });
		expect((await call(app, "GET", "/api/files?tag=a%2Cb")).status).toBe(400);
	});

	it("pages with a cursor and validates the limit", async () => {
		const first = await list("?limit=2");
		expect(first.files.map((f) => f.id)).toEqual(["aaaa000003", "aaaa000002"]);
		expect(first.nextCursor).not.toBeNull();
		const second = await list(`?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
		expect(second.files.map((f) => f.id)).toEqual(["aaaa000001"]);
		expect(second.nextCursor).toBeNull();
		expect((await call(app, "GET", "/api/files?limit=0")).status).toBe(400);
		expect((await call(app, "GET", "/api/files?limit=201")).status).toBe(400);
		expect((await call(app, "GET", "/api/files?cursor=garbage")).status).toBe(400);
	});
});

describe("GET /api/files/:id", () => {
	it("includes revoked links", async () => {
		const res = await call(app, "GET", "/api/files/aaaa000001");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { id: string }; links: { revokedAt: string | null }[] };
		expect(body.file.id).toBe("aaaa000001");
		expect(body.links).toHaveLength(2);
		expect(body.links.some((l) => l.revokedAt !== null)).toBe(true);
	});

	it("returns 404 for pending and deleting files", async () => {
		expect((await call(app, "GET", "/api/files/aaaa000004")).status).toBe(404);
		expect((await call(app, "GET", "/api/files/aaaa000005")).status).toBe(404);
	});
});
