import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, sha256Hex, testApp } from "./helpers.ts";

const app = testApp();

async function upload(body: string) {
	const bytes = new TextEncoder().encode(body);
	return call(app, "PUT", "/api/files", {
		headers: {
			"Content-Type": "image/png",
			"Content-Length": String(bytes.length),
			"X-Kumodana-Sha256": await sha256Hex(bytes),
			"X-Kumodana-Filename": "a.png",
		},
		body: bytes,
	});
}

beforeEach(resetStorage);

describe("storage limit (STORAGE_LIMIT_BYTES = 1000 in tests)", () => {
	it("rejects with usage, limit, and requested size", async () => {
		await seedFile({ id: "used000001", body: "x".repeat(700) });
		const res = await upload("y".repeat(301));
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({
			error: { code: "quota_exceeded", details: { usedBytes: 700, limitBytes: 1000, requestedBytes: 301 } },
		});
		expect((await upload("y".repeat(300))).status).toBe(201);
	});

	it("counts pending and deleting files", async () => {
		await seedFile({ id: "pend000001", body: "p".repeat(400), status: "pending" });
		await seedFile({ id: "dele000001", body: "d".repeat(400), status: "deleting" });
		const res = await upload("z".repeat(201));
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: { details: { usedBytes: 800 } } });
	});

	it("never exceeds the limit with concurrent uploads", async () => {
		const results = await Promise.all([upload("a".repeat(600)), upload("b".repeat(600))]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 413]);
		const total = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files").first<{ n: number }>();
		expect(total?.n).toBe(600);
	});
});
