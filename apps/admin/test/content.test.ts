import { beforeEach, describe, expect, it } from "vitest";
import { call, resetStorage, seedFile, testApp } from "./helpers.ts";

const app = testApp();

beforeEach(resetStorage);

describe("GET /api/files/:id/content", () => {
	it("returns the content as an attachment with the original name", async () => {
		await seedFile({ id: "file000001", name: "旅行 (1).png", body: "png-bytes", contentType: "image/png" });
		const res = await call(app, "GET", "/api/files/file000001/content");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("png-bytes");
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Content-Disposition")).toBe(
			`attachment; filename*=UTF-8''${encodeURIComponent("旅行 ").replace(/'/g, "%27")}%281%29.png`,
		);
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("returns 404 unless the file is ready", async () => {
		await seedFile({ id: "pend000001", status: "pending" });
		await seedFile({ id: "dele000001", status: "deleting" });
		for (const id of ["none000001", "pend000001", "dele000001"]) {
			expect((await call(app, "GET", `/api/files/${id}/content`)).status).toBe(404);
		}
	});
});
