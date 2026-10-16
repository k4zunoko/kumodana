import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, testApp } from "./helpers.ts";

const app = testApp();

beforeEach(resetStorage);

describe("POST /api/files/:id/links", () => {
	it("creates a link with a 22-character token and the delivery URL", async () => {
		await seedFile({ id: "file000001" });
		const res = await call(app, "POST", "/api/files/file000001/links", { json: { label: "Aさん" } });
		expect(res.status).toBe(201);
		const { link } = (await res.json()) as { link: { token: string; url: string; label: string; revokedAt: null } };
		expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(link.url).toBe(`${env.FILES_BASE_URL}/${link.token}`);
		expect(link).toMatchObject({ label: "Aさん", fileId: "file000001", revokedAt: null });
	});

	it("creates a link without a label", async () => {
		await seedFile({ id: "file000001" });
		const res = await call(app, "POST", "/api/files/file000001/links", { json: {} });
		expect(res.status).toBe(201);
		expect(((await res.json()) as { link: { label: unknown } }).link.label).toBeNull();
	});

	it("limits labels to 200 characters", async () => {
		await seedFile({ id: "file000001" });
		const ok = await call(app, "POST", "/api/files/file000001/links", { json: { label: "あ".repeat(200) } });
		expect(ok.status).toBe(201);
		const tooLong = await call(app, "POST", "/api/files/file000001/links", { json: { label: "あ".repeat(201) } });
		expect(tooLong.status).toBe(400);
	});

	it("returns 404 for missing, pending, and deleting files", async () => {
		await seedFile({ id: "pend000001", status: "pending" });
		await seedFile({ id: "dele000001", status: "deleting" });
		for (const id of ["none000001", "pend000001", "dele000001"]) {
			const res = await call(app, "POST", `/api/files/${id}/links`, { json: {} });
			expect(res.status).toBe(404);
		}
	});
});
