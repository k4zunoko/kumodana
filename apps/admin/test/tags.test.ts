import { beforeEach, describe, expect, it } from "vitest";
import { call, resetStorage, seedFile, testApp } from "./helpers.ts";

const app = testApp();

beforeEach(async () => {
	await resetStorage();
	await seedFile({ id: "bbbb000001", tags: ["旅行", "2026"] });
	await seedFile({ id: "bbbb000002", tags: ["旅行"] });
	await seedFile({ id: "bbbb000003", tags: ["家族"] });
	await seedFile({ id: "bbbb000004", tags: ["家族"], status: "pending" });
});

describe("PATCH /api/files/:id/tags", () => {
	it("adds and removes normalized tags", async () => {
		const res = await call(app, "PATCH", "/api/files/bbbb000001/tags", {
			json: { add: [" Sunset ", "海"], remove: ["2026"] },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ tags: ["sunset", "旅行", "海"] });
	});

	it("ignores tags that are already present or absent", async () => {
		const res = await call(app, "PATCH", "/api/files/bbbb000002/tags", { json: { add: ["旅行"], remove: ["nope"] } });
		expect(await res.json()).toEqual({ tags: ["旅行"] });
	});

	it("rejects invalid tags and invalid request sizes", async () => {
		const invalid = await call(app, "PATCH", "/api/files/bbbb000001/tags", { json: { add: ["a,b"] } });
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "invalid_tag" } });
		expect((await call(app, "PATCH", "/api/files/bbbb000001/tags", { json: {} })).status).toBe(400);
		const tooMany = Array.from({ length: 51 }, (_, i) => `t${i}`);
		expect((await call(app, "PATCH", "/api/files/bbbb000001/tags", { json: { add: tooMany } })).status).toBe(400);
	});

	it("returns 404 unless the file is ready", async () => {
		expect((await call(app, "PATCH", "/api/files/bbbb000004/tags", { json: { add: ["x"] } })).status).toBe(404);
		expect((await call(app, "PATCH", "/api/files/none000001/tags", { json: { add: ["x"] } })).status).toBe(404);
	});
});

describe("GET /api/tags", () => {
	it("counts tags on ready files, most used first then by name", async () => {
		const res = await call(app, "GET", "/api/tags");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			tags: [
				{ tag: "旅行", fileCount: 2 },
				{ tag: "2026", fileCount: 1 },
				{ tag: "家族", fileCount: 1 },
			],
		});
	});
});
