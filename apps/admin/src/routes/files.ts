import { type ContentSummary, HEADER_FILENAME, HEADER_SHA256, type PurgeResult } from "@kumodana/shared/api-types";
import { contentDisposition } from "@kumodana/shared/http";
import {
	ALLOWED_CONTENT_TYPES,
	isAllowedContentType,
	MAX_FILE_BYTES,
	MAX_FILTER_TAGS,
	MAX_NAME_LENGTH,
} from "@kumodana/shared/limits";
import { newFileId } from "@kumodana/shared/ids";
import type { Context, Hono, HonoRequest } from "hono";
import type { AppEnv } from "../app.ts";
import {
	beginDeletion,
	claimStalePending,
	deleteDeletingRow,
	deleteFileRows,
	deleteRow,
	findLiveBySha256,
	getFileRow,
	getFileSummary,
	hasEverHadLinks,
	insertPendingWithinQuota,
	listBySha256,
	listFiles,
	markReady,
	type NewFile,
	switchContent,
} from "../db/files.ts";
import { listLinks } from "../db/links.ts";
import { type FileRow, toLink } from "../db/rows.ts";
import { getUsage } from "../db/usage.ts";
import { ApiError } from "../errors.ts";
import { normalizeTags } from "./tags.ts";

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

function parseCursor(value: string | undefined): { createdAt: number; id: string } | undefined {
	if (value === undefined) return undefined;
	const match = /^(\d+)_([0-9a-z]{1,32})$/.exec(value);
	if (!match) throw new ApiError(400, "invalid_request", "cursor が不正です。");
	return { createdAt: Number(match[1]), id: match[2] ?? "" };
}

function isChecksumError(error: unknown): boolean {
	return /sha-?256|checksum|digest|did not match/i.test(String(error));
}

type ContentHeaders = { contentType: string; size: number; sha256: string; name: string };

/** The headers that describe uploaded content, shared by upload and replacement (contracts/admin-api.md). */
function parseContentHeaders(req: HonoRequest): ContentHeaders {
	const contentType = req.header("Content-Type") ?? "";
	if (!isAllowedContentType(contentType)) {
		throw new ApiError(415, "unsupported_type", undefined, { allowed: [...ALLOWED_CONTENT_TYPES] });
	}
	const lengthHeader = req.header("Content-Length");
	if (lengthHeader === undefined) throw new ApiError(411, "length_required");
	const size = Number(lengthHeader);
	if (!Number.isInteger(size) || size < 1) throw new ApiError(400, "invalid_request", "Content-Length が不正です。");
	if (size > MAX_FILE_BYTES) throw new ApiError(413, "file_too_large");
	const sha256 = req.header(HEADER_SHA256) ?? "";
	if (!SHA256_PATTERN.test(sha256)) {
		throw new ApiError(400, "invalid_request", `${HEADER_SHA256} は小文字 16 進 64 文字にしてください。`);
	}
	return { contentType, size, sha256, name: parseFilename(req.header(HEADER_FILENAME)) };
}

/** `If-Match: "<sha256>"`, required for a replacement (specs/005-replace-content). */
function parseIfMatch(value: string | undefined): string {
	const match = /^"([0-9a-f]{64})"$/.exec(value?.trim() ?? "");
	if (!match?.[1]) {
		throw new ApiError(
			400,
			"invalid_request",
			'If-Match に、置き換える前の内容の SHA-256 を "<小文字 16 進 64 文字>" の形で指定してください。',
		);
	}
	return match[1];
}

/**
 * The ready file with this content, or null when there is none and the content can be stored (FR-007, FR-008).
 * A pending upload of the same content answers 409 while it is younger than 10 minutes. An older one is taken over,
 * but only by claiming its row in D1 first (`claimStalePending`): the row may have changed since it was read (the
 * upload ended, a replacement switched a file to it, another request took it over), and its key may then be the key
 * of a ready file. A lost claim removes nothing, and the content is looked up again.
 */
async function findLiveContent(env: Env, now: () => number, sha256: string): Promise<FileRow | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const existing = await findLiveBySha256(env.DB, sha256);
		if (existing?.status !== "pending") return existing;
		const at = now();
		const age = at - existing.updated_at;
		if (age < PENDING_GRACE_MS) {
			throw new ApiError(409, "upload_in_progress", undefined, {
				retryAfterSeconds: Math.ceil((PENDING_GRACE_MS - age) / 1000),
			});
		}
		if (await claimStalePending(env.DB, existing, at)) {
			await env.BUCKET.delete(existing.r2_key);
			await deleteDeletingRow(env.DB, existing.id);
			return null;
		}
	}
	// Lost the claim again: other requests with the same content are working on it.
	throw new ApiError(409, "upload_in_progress");
}

/**
 * Creates a `pending` row within the storage limit (FR-009), retrying once on an ID collision.
 * `r2KeyFor` gives the R2 key for the new row's ID.
 */
async function createPendingRow(
	env: Env,
	file: Omit<NewFile, "id" | "r2Key">,
	r2KeyFor: (id: string) => string,
): Promise<{ id: string; r2Key: string }> {
	let id = newFileId();
	let inserted = await insertPendingWithinQuota(env.DB, { ...file, id, r2Key: r2KeyFor(id) }, storageLimit(env));
	if (inserted === "id_conflict") {
		id = newFileId();
		inserted = await insertPendingWithinQuota(env.DB, { ...file, id, r2Key: r2KeyFor(id) }, storageLimit(env));
	}
	if (inserted === "quota") {
		const usage = await getUsage(env.DB, storageLimit(env));
		throw new ApiError(413, "quota_exceeded", undefined, {
			usedBytes: usage.usedBytes,
			limitBytes: usage.limitBytes,
			requestedBytes: file.size,
		});
	}
	if (inserted === "duplicate") throw new ApiError(409, "upload_in_progress");
	if (inserted !== "inserted") throw new ApiError(500, "internal_error");
	return { id, r2Key: r2KeyFor(id) };
}

/** Stores the body in R2, checked against its SHA-256. On failure the pending row is removed. */
async function storeObject(
	env: Env,
	pending: { id: string; r2Key: string },
	body: ReadableStream | null,
	content: ContentHeaders,
): Promise<void> {
	try {
		await env.BUCKET.put(pending.r2Key, body, { sha256: content.sha256, httpMetadata: { contentType: content.contentType } });
	} catch (error) {
		await deleteRow(env.DB, pending.id);
		if (isChecksumError(error)) throw new ApiError(422, "checksum_mismatch");
		console.error("R2 put failed", error);
		throw new ApiError(502, "storage_error");
	}
}

/** Purges a file's cached copies (tag `f:<id>`) if it ever had a link; null when there is nothing to purge. */
async function purgeFile(c: Context<AppEnv>, id: string): Promise<PurgeResult | null> {
	return (await hasEverHadLinks(c.env.DB, id)) ? c.get("deps").purge(c.env, [`f:${id}`]) : null;
}

function contentOf(row: FileRow): ContentSummary {
	return { name: row.name, contentType: row.content_type, size: row.size, sha256: row.sha256 };
}

export function filesRoutes(app: Hono<AppEnv>): void {
	app.put("/api/files", async (c) => {
		const deps = c.get("deps");
		const content = parseContentHeaders(c.req);

		// An interrupted upload of the same content is taken over after 10 minutes (FR-008).
		const existing = await findLiveContent(c.env, () => deps.now(), content.sha256);
		if (existing) {
			const file = await getFileSummary(c.env.DB, existing.id);
			return c.json({ file, duplicate: true }, 200);
		}

		const pending = await createPendingRow(c.env, { ...content, now: deps.now() }, (id) => `files/${id}`);
		await storeObject(c.env, pending, c.req.raw.body, content);
		await markReady(c.env.DB, pending.id, deps.now());
		return c.json({ file: await getFileSummary(c.env.DB, pending.id), duplicate: false }, 201);
	});

	app.get("/api/files", async (c) => {
		const sha256 = c.req.query("sha256");
		if (sha256 !== undefined) {
			if (!SHA256_PATTERN.test(sha256)) throw new ApiError(400, "invalid_request");
			return c.json({ files: await listBySha256(c.env.DB, sha256), nextCursor: null });
		}

		const rawTags = c.req.queries("tag") ?? [];
		if (rawTags.length > MAX_FILTER_TAGS) {
			throw new ApiError(400, "invalid_tag", `絞り込みに使えるタグは ${MAX_FILTER_TAGS} 個までです。`);
		}
		const tags = [...new Set(normalizeTags(rawTags))];
		const limitText = c.req.query("limit") ?? "50";
		const limit = Number(limitText);
		if (!/^\d+$/.test(limitText) || limit < 1 || limit > 200) {
			throw new ApiError(400, "invalid_request", "limit は 1〜200 にしてください。");
		}
		const cursor = parseCursor(c.req.query("cursor"));
		const { files, next } = await listFiles(c.env.DB, { tags, limit, cursor });
		return c.json({ files, nextCursor: next ? `${next.createdAt}_${next.id}` : null });
	});

	app.get("/api/files/:id", async (c) => {
		const file = await getFileSummary(c.env.DB, c.req.param("id"));
		if (!file) throw new ApiError(404, "not_found");
		const rows = await listLinks(c.env.DB, { fileId: file.id, includeRevoked: true });
		const baseUrl = String(c.env.FILES_BASE_URL);
		return c.json({ file, links: rows.map((row) => toLink(row, baseUrl)) });
	});

	/**
	 * Deletion (data-model.md): revoke links and mark `deleting` → purge if the file was ever linked →
	 * delete the R2 object → delete the rows. A purge failure is reported but does not stop the deletion,
	 * because cached copies expire within an hour regardless (FR-028).
	 */
	app.delete("/api/files/:id", async (c) => {
		const deps = c.get("deps");
		const row = await getFileRow(c.env.DB, c.req.param("id"));
		if (!row || row.status === "pending") throw new ApiError(404, "not_found");
		const revokedLinks = row.status === "ready" ? await beginDeletion(c.env.DB, row.id, deps.now()) : 0;
		// The key of a deleting file no longer changes. Read it again: a replacement may have switched it just before
		// (specs/005-replace-content), and the old key now belongs to the replacement's leftover row.
		const r2Key = (await getFileRow(c.env.DB, row.id))?.r2_key ?? row.r2_key;
		const purge = (await hasEverHadLinks(c.env.DB, row.id)) ? await deps.purge(c.env, [`f:${row.id}`]) : null;
		await c.env.BUCKET.delete(r2Key);
		await deleteFileRows(c.env.DB, row.id);
		return c.json({ deleted: row.id, revokedLinks, purge });
	});

	app.get("/api/files/:id/content", async (c) => {
		const row = await getFileRow(c.env.DB, c.req.param("id"));
		if (!row || row.status !== "ready") throw new ApiError(404, "not_found");
		// The key comes from D1: a replaced file is no longer at files/<id> (specs/005-replace-content).
		const object = await c.env.BUCKET.get(row.r2_key);
		if (!object) throw new ApiError(404, "not_found");
		return new Response(object.body, {
			headers: {
				"Content-Type": row.content_type,
				"Content-Length": String(row.size),
				"Content-Disposition": contentDisposition("attachment", row.name),
			},
		});
	});

	/**
	 * Replacement (specs/005-replace-content): the file keeps its ID, links, and tags, and gets new content, name,
	 * and type. The new content goes to a new key under a pending row (the limit counts old and new), then one batch
	 * switches the file to it and leaves the old content as a deleting row. The switch happens only while the file is
	 * ready with the If-Match SHA-256 and the pending row is still pending (not claimed by another request with the same
	 * content, which may take it over after 10 minutes, FR-008) and younger than 10 minutes. Then: purge `f:<id>` if the
	 * file ever had a link (a failure is reported, the replacement stays), and remove the old object and row. If this
	 * stops midway, the cron removes what is left. Until the switch, the file keeps serving its old content.
	 */
	app.put("/api/files/:id/content", async (c) => {
		const deps = c.get("deps");
		const content = parseContentHeaders(c.req);
		const expectedSha256 = parseIfMatch(c.req.header("If-Match"));
		const target = await getFileRow(c.env.DB, c.req.param("id"));
		if (!target || target.status !== "ready") throw new ApiError(404, "not_found");

		// Already this content, for example a retry whose response was lost: change nothing and retry only the purge.
		// RFC 9110 §13.1.1 allows a success when the requested change is already in place, whatever If-Match says.
		const unchanged = async (current: FileRow) => {
			const purge = await purgeFile(c, current.id);
			const file = await getFileSummary(c.env.DB, current.id);
			if (!file) throw new ApiError(404, "not_found");
			return c.json({ file, replaced: false, previous: contentOf(current), purge });
		};
		if (content.sha256 === target.sha256) return unchanged(target);
		if (expectedSha256 !== target.sha256) throw new ApiError(412, "precondition_failed");

		// Same content is stored once (FR-007), so content that another file has cannot become this file's.
		const existing = await findLiveContent(c.env, () => deps.now(), content.sha256);
		// The file itself has it only if another replacement switched it to this content after it was read above.
		if (existing?.id === target.id) return unchanged(existing);
		if (existing) throw new ApiError(409, "duplicate_content", undefined, { fileId: existing.id });

		// A new key every time: going back to an earlier content must not meet its old object waiting for cleanup.
		const pending = await createPendingRow(c.env, { ...content, now: deps.now() }, (id) => `files/${target.id}/${id}`);
		await storeObject(c.env, pending, c.req.raw.body, content);

		const switched = await switchContent(c.env.DB, {
			targetId: target.id,
			expectedSha256,
			pendingId: pending.id,
			r2Key: pending.r2Key,
			name: content.name,
			contentType: content.contentType,
			size: content.size,
			sha256: content.sha256,
			now: deps.now(),
			maxPendingAgeMs: PENDING_GRACE_MS,
		});
		if (!switched) {
			// Something else came first. Drop the new content; the file is as it was (the cron retries a failed drop).
			try {
				await c.env.BUCKET.delete(pending.r2Key);
				await deleteRow(c.env.DB, pending.id);
			} catch (error) {
				console.error(`dropping the content for ${target.id} failed`, error);
			}
			const current = await getFileRow(c.env.DB, target.id);
			if (!current || current.status !== "ready") throw new ApiError(404, "not_found");
			if (current.sha256 !== expectedSha256) throw new ApiError(412, "precondition_failed");
			// Storing took 10 minutes or more, so the pending row may have been taken over (FR-008).
			throw new ApiError(
				502,
				"storage_error",
				"新しい内容の保存に 10 分以上かかったため、置き換えていません。もう一度置き換えてください。",
			);
		}

		const old = await getFileRow(c.env.DB, pending.id);
		const purge = await purgeFile(c, target.id);
		if (old) {
			try {
				await c.env.BUCKET.delete(old.r2_key);
				await deleteDeletingRow(c.env.DB, old.id);
			} catch (error) {
				console.error(`removing the old content of ${target.id} failed; the cron removes it`, error);
			}
		}
		const file = await getFileSummary(c.env.DB, target.id);
		if (!file) throw new ApiError(404, "not_found");
		return c.json({ file, replaced: true, previous: contentOf(old ?? target), purge });
	});
}
