import { HEADER_FILENAME, HEADER_SHA256 } from "@kumodana/shared/api-types";
import { contentDisposition } from "@kumodana/shared/http";
import { ALLOWED_CONTENT_TYPES, isAllowedContentType, MAX_FILE_BYTES, MAX_NAME_LENGTH } from "@kumodana/shared/limits";
import { newFileId } from "@kumodana/shared/ids";
import type { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import {
	deleteRow,
	findLiveBySha256,
	getFileSummary,
	insertPendingWithinQuota,
	listBySha256,
	markReady,
} from "../db/files.ts";
import { getUsage } from "../db/usage.ts";
import { ApiError } from "../errors.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** A pending upload younger than this is treated as still in progress (FR-008). */
export const PENDING_GRACE_MS = 10 * 60 * 1000;

export function storageLimit(env: Env): number {
	return Number(env.STORAGE_LIMIT_BYTES);
}

function parseFilename(raw: string | undefined): string {
	if (raw === undefined) throw new ApiError(400, "invalid_request", "X-Kumodana-Filename ヘッダーが必要です。");
	let name: string;
	try {
		name = decodeURIComponent(raw).normalize("NFC").trim();
	} catch {
		throw new ApiError(400, "invalid_request", "X-Kumodana-Filename をデコードできません。");
	}
	const length = [...name].length;
	if (length < 1 || length > MAX_NAME_LENGTH || /[/\\\u0000-\u001f\u007f]/.test(name)) {
		throw new ApiError(400, "invalid_request", `ファイル名は 1〜${MAX_NAME_LENGTH} 文字で、パスを含めないでください。`);
	}
	return name;
}

function isChecksumError(error: unknown): boolean {
	return /sha-?256|checksum|digest|did not match/i.test(String(error));
}

export function filesRoutes(app: Hono<AppEnv>): void {
	app.put("/api/files", async (c) => {
		const deps = c.get("deps");
		const contentType = c.req.header("Content-Type") ?? "";
		if (!isAllowedContentType(contentType)) {
			throw new ApiError(415, "unsupported_type", undefined, { allowed: [...ALLOWED_CONTENT_TYPES] });
		}
		const lengthHeader = c.req.header("Content-Length");
		if (lengthHeader === undefined) throw new ApiError(411, "length_required");
		const size = Number(lengthHeader);
		if (!Number.isInteger(size) || size < 1) throw new ApiError(400, "invalid_request", "Content-Length が不正です。");
		if (size > MAX_FILE_BYTES) throw new ApiError(413, "file_too_large");
		const sha256 = c.req.header(HEADER_SHA256) ?? "";
		if (!SHA256_PATTERN.test(sha256)) {
			throw new ApiError(400, "invalid_request", `${HEADER_SHA256} は小文字 16 進 64 文字にしてください。`);
		}
		const name = parseFilename(c.req.header(HEADER_FILENAME));

		const existing = await findLiveBySha256(c.env.DB, sha256);
		if (existing?.status === "ready") {
			const file = await getFileSummary(c.env.DB, existing.id);
			return c.json({ file, duplicate: true }, 200);
		}
		if (existing?.status === "pending") {
			const age = deps.now() - existing.updated_at;
			if (age < PENDING_GRACE_MS) {
				throw new ApiError(409, "upload_in_progress", undefined, {
					retryAfterSeconds: Math.ceil((PENDING_GRACE_MS - age) / 1000),
				});
			}
			// An interrupted upload of the same content: replace it (FR-008).
			await c.env.BUCKET.delete(existing.r2_key);
			await deleteRow(c.env.DB, existing.id);
		}

		let id = newFileId();
		let inserted = await insertPendingWithinQuota(
			c.env.DB,
			{ id, name, contentType, size, sha256, now: deps.now() },
			storageLimit(c.env),
		);
		if (inserted === "id_conflict") {
			id = newFileId();
			inserted = await insertPendingWithinQuota(
				c.env.DB,
				{ id, name, contentType, size, sha256, now: deps.now() },
				storageLimit(c.env),
			);
		}
		if (inserted === "quota") {
			const usage = await getUsage(c.env.DB, storageLimit(c.env));
			throw new ApiError(413, "quota_exceeded", undefined, {
				usedBytes: usage.usedBytes,
				limitBytes: usage.limitBytes,
				requestedBytes: size,
			});
		}
		if (inserted === "duplicate") throw new ApiError(409, "upload_in_progress");
		if (inserted !== "inserted") throw new ApiError(500, "internal_error");

		try {
			await c.env.BUCKET.put(`files/${id}`, c.req.raw.body, { sha256, httpMetadata: { contentType } });
		} catch (error) {
			await deleteRow(c.env.DB, id);
			if (isChecksumError(error)) throw new ApiError(422, "checksum_mismatch");
			console.error("R2 put failed", error);
			throw new ApiError(502, "storage_error");
		}
		await markReady(c.env.DB, id, deps.now());
		return c.json({ file: await getFileSummary(c.env.DB, id), duplicate: false }, 201);
	});

	app.get("/api/files", async (c) => {
		const sha256 = c.req.query("sha256");
		if (sha256 !== undefined) {
			if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, "invalid_request");
			return c.json({ files: await listBySha256(c.env.DB, sha256), nextCursor: null });
		}
		throw new ApiError(400, "invalid_request");
	});

	app.get("/api/files/:id/content", async (c) => {
		const file = await getFileSummary(c.env.DB, c.req.param("id"));
		if (!file) throw new ApiError(404, "not_found");
		const object = await c.env.BUCKET.get(`files/${file.id}`);
		if (!object) throw new ApiError(404, "not_found");
		return new Response(object.body, {
			headers: {
				"Content-Type": file.contentType,
				"Content-Length": String(file.size),
				"Content-Disposition": contentDisposition("attachment", file.name),
			},
		});
	});
}
