import { beforeEach, describe, expect, it } from "vitest";
import { call, resetStorage, seedFile, testApp } from "./helpers.ts";

const app = testApp();

beforeEach(resetStorage);

describe("GET /api/usage", () => {
	it("reports usage, limit, remaining bytes, and file count", async () => {
		await seedFile({ id: "used000001", body: "x".repeat(300) });
		await seedFile({ id: "pend000001", body: "y".repeat(100), status: "pending" });
		const res = await call(app, "GET", "/api/usage");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ usedBytes: 400, limitBytes: 1000, remainingBytes: 600, fileCount: 2 });
	});

	it("never reports negative remaining bytes", async () => {
		await seedFile({ id: "used000001", body: "x".repeat(900) });
		await seedFile({ id: "used000002", body: "y".repeat(900), withObject: false });
		const body = (await (await call(app, "GET", "/api/usage")).json()) as { remainingBytes: number };
		expect(body.remainingBytes).toBe(0);
	});
});
