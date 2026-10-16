import { beforeEach, describe, expect, it } from "vitest";
import { call, env, resetStorage, seedFile, sha256Hex, testApp } from "./helpers.ts";

const app = testApp();

type UploadOptions = {
	contentType?: string;
	length?: string | null;
	sha256?: string;
	filename?: string;
};

async function upload(body: string, options: UploadOptions = {}) {
	const bytes = new TextEncoder().encode(body);
	const headers: Record<string, string> = {
		"Content-Type": options.contentType ?? "image/png",
		"X-Kumodana-Sha256": options.sha256 ?? (await sha256Hex(bytes)),
		"X-Kumodana-Filename": encodeURIComponent(options.filename ?? "写真.png"),
	};
	if (options.length !== null) headers["Content-Length"] = options.length ?? String(bytes.length);
	return call(app, "PUT", "/api/files", { headers, body: bytes });
}

beforeEach(resetStorage);

describe("PUT /api/files", () => {
	it("stores a new file and returns 201", async () => {
		const res = await upload("hello image");
		expect(res.status).toBe(201);
		const body = (await res.json()) as { file: { id: string; name: string; size: number }; duplicate: boolean };
		expect(body.duplicate).toBe(false);
		expect(body.file).toMatchObject({ name: "写真.png", size: 11, contentType: "image/png", tags: [], activeLinkCount: 0 });
		const row = await env.DB.prepare("SELECT status, r2_key FROM files WHERE id = ?").bind(body.file.id).first();
		expect(row).toEqual({ status: "ready", r2_key: `files/${body.file.id}` });
		const object = await env.BUCKET.get(`files/${body.file.id}`);
		expect(await object?.text()).toBe("hello image");
		expect(object?.httpMetadata?.contentType).toBe("image/png");
	});

	it("returns the existing ready file for the same content without storing it again", async () => {
		const first = (await (await upload("same")).json()) as { file: { id: string } };
		const res = await upload("same", { filename: "other.png" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { id: string; name: string }; duplicate: boolean };
		expect(body).toMatchObject({ duplicate: true, file: { id: first.file.id, name: "写真.png" } });
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>();
		expect(count?.n).toBe(1);
	});

	it("rejects a pending duplicate updated within 10 minutes with 409", async () => {
		await seedFile({ id: "pend000001", body: "busy", status: "pending", withObject: false });
		const res = await upload("busy");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: "upload_in_progress" } });
	});

	it("rejects unsupported types with the allowed list", async () => {
		const res = await upload("x", { contentType: "video/mp4" });
		expect(res.status).toBe(415);
		const body = (await res.json()) as { error: { code: string; details: { allowed: string[] } } };
		expect(body.error.code).toBe("unsupported_type");
		expect(body.error.details.allowed).toContain("image/jpeg");
	});

	it("requires Content-Length", async () => {
		const res = await upload("x", { length: null });
		expect(res.status).toBe(411);
	});

	it("rejects files of 100000000 bytes or more", async () => {
		const res = await upload("x", { length: "100000000" });
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: { code: "file_too_large" } });
	});

	it("rejects a malformed SHA-256 or filename", async () => {
		expect((await upload("x", { sha256: "ABC" })).status).toBe(400);
		expect((await upload("x", { filename: "dir/name.png" })).status).toBe(400);
		expect((await upload("x", { filename: "" })).status).toBe(400);
		expect((await upload("x", { filename: "a".repeat(256) })).status).toBe(400);
	});

	it("leaves no row when the content does not match the SHA-256", async () => {
		const res = await upload("actual content", { sha256: await sha256Hex("something else") });
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({ error: { code: "checksum_mismatch" } });
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it("rejects uploads over the storage limit", async () => {
		await seedFile({ id: "big0000001", body: "x".repeat(900) });
		const res = await upload("y".repeat(200));
		expect(res.status).toBe(413);
		expect(await res.json()).toMatchObject({ error: { code: "quota_exceeded" } });
	});
});
