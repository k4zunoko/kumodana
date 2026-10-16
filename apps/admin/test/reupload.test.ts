import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, sha256Hex, testApp } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60 * 1000;
const app = testApp({ now: () => NOW });

async function upload(body: string) {
	const bytes = new TextEncoder().encode(body);
	return call(app, "PUT", "/api/files", {
		headers: {
			"Content-Type": "image/png",
			"Content-Length": String(bytes.length),
			"X-Kumodana-Sha256": await sha256Hex(bytes),
			"X-Kumodana-Filename": "again.png",
		},
		body: bytes,
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
