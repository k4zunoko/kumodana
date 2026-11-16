import type { FileSummary } from "@kumodana/shared/api-types";
import { type FileRow, SUMMARY_COLUMNS, type SummaryRow, toFileSummary } from "./rows.ts";

export type NewFile = {
	id: string;
	name: string;
	contentType: string;
	size: number;
	sha256: string;
	now: number;
	/** The R2 key. `files/<id>` unless given (a replacement uses a new key each time, specs/005-replace-content). */
	r2Key?: string;
};

export type InsertResult = "inserted" | "quota" | "duplicate" | "id_conflict";

/**
 * Creates a `pending` row only if the total size (pending and deleting included) stays within the limit.
 * One statement, so concurrent uploads cannot exceed the limit (FR-009, research R7).
 */
export async function insertPendingWithinQuota(db: D1Database, file: NewFile, limitBytes: number): Promise<InsertResult> {
	try {
		const result = await db
			.prepare(
				`INSERT INTO files (id, r2_key, name, content_type, size, sha256, status, created_at, updated_at)
				 SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7
				 WHERE (SELECT COALESCE(SUM(size), 0) FROM files) + ?5 <= ?8`,
			)
			.bind(file.id, file.r2Key ?? `files/${file.id}`, file.name, file.contentType, file.size, file.sha256, file.now, limitBytes)
			.run();
		return result.meta.changes === 0 ? "quota" : "inserted";
	} catch (error) {
		const message = String(error);
		if (message.includes("UNIQUE") && message.includes("sha256")) return "duplicate";
		if (message.includes("UNIQUE") && (message.includes("files.id") || message.includes("r2_key"))) return "id_conflict";
		throw error;
	}
}

export async function markReady(db: D1Database, id: string, now: number): Promise<void> {
	await db.prepare("UPDATE files SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, id).run();
}

export async function deleteRow(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
}

/** The live (pending or ready) file with this content, if any. */
export async function findLiveBySha256(db: D1Database, sha256: string): Promise<FileRow | null> {
	return db.prepare("SELECT * FROM files WHERE sha256 = ? AND status != 'deleting'").bind(sha256).first<FileRow>();
}

export async function getFileRow(db: D1Database, id: string): Promise<FileRow | null> {
	return db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

/** Summary of a `ready` file, or null for any other status. */
export async function getFileSummary(db: D1Database, id: string): Promise<FileSummary | null> {
	const row = await db
		.prepare(`SELECT ${SUMMARY_COLUMNS} FROM files f WHERE f.id = ? AND f.status = 'ready'`)
		.bind(id)
		.first<SummaryRow>();
	return row ? toFileSummary(row) : null;
}

/** Ready files with the given content (used by the CLI's duplicate check). */
export async function listBySha256(db: D1Database, sha256: string): Promise<FileSummary[]> {
	const { results } = await db
		.prepare(`SELECT ${SUMMARY_COLUMNS} FROM files f WHERE f.sha256 = ? AND f.status = 'ready'`)
		.bind(sha256)
		.all<SummaryRow>();
	return results.map(toFileSummary);
}

export type ListOptions = {
	tags: string[];
	limit: number;
	cursor?: { createdAt: number; id: string };
};

/** Ready files, newest first. Several tags mean AND: files that have every tag (FR-024). */
export async function listFiles(
	db: D1Database,
	options: ListOptions,
): Promise<{ files: FileSummary[]; next: { createdAt: number; id: string } | null }> {
	const conditions = ["f.status = 'ready'"];
	const params: unknown[] = [];
	if (options.tags.length > 0) {
		conditions.push(
			`f.id IN (SELECT file_id FROM file_tags WHERE tag IN (${options.tags.map(() => "?").join(", ")})
			 GROUP BY file_id HAVING COUNT(DISTINCT tag) = ?)`,
		);
		params.push(...options.tags, options.tags.length);
	}
	if (options.cursor) {
		conditions.push("(f.created_at < ? OR (f.created_at = ? AND f.id < ?))");
		params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
	}
	const { results } = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS} FROM files f WHERE ${conditions.join(" AND ")}
			 ORDER BY f.created_at DESC, f.id DESC LIMIT ?`,
		)
		.bind(...params, options.limit + 1)
		.all<SummaryRow>();
	const page = results.slice(0, options.limit);
	const last = page.at(-1);
	const next = results.length > options.limit && last ? { createdAt: last.created_at, id: last.id } : null;
	return { files: page.map(toFileSummary), next };
}

/**
 * Starts a deletion: revoke active links and mark the file `deleting` in one batch, so it leaves lists
 * and delivery at once while its R2 object still exists (constitution III). Returns revoked link count.
 */
export async function beginDeletion(db: D1Database, id: string, now: number): Promise<number> {
	const [revoke] = await db.batch([
		db.prepare("UPDATE links SET revoked_at = ? WHERE file_id = ? AND revoked_at IS NULL").bind(now, id),
		db.prepare("UPDATE files SET status = 'deleting', updated_at = ? WHERE id = ? AND status = 'ready'").bind(now, id),
	]);
	return revoke?.meta.changes ?? 0;
}

export async function hasEverHadLinks(db: D1Database, id: string): Promise<boolean> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM links WHERE file_id = ?").bind(id).first<{ n: number }>();
	return (row?.n ?? 0) > 0;
}

/** Removes a file's rows (tags, links, file) in one batch. Call only after its R2 object is gone. */
export async function deleteFileRows(db: D1Database, id: string): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM file_tags WHERE file_id = ?").bind(id),
		db.prepare("DELETE FROM links WHERE file_id = ?").bind(id),
		db.prepare("DELETE FROM files WHERE id = ? AND status != 'ready'").bind(id),
	]);
}

export type ContentSwitch = {
	/** The ready file whose content is replaced. Its ID, links, and tags stay. */
	targetId: string;
	/** Its SHA-256 before the replacement (the If-Match). The switch happens only while it is still this. */
	expectedSha256: string;
	/** The `pending` row that holds the new content (already stored in R2 under `r2Key`). */
	pendingId: string;
	r2Key: string;
	name: string;
	contentType: string;
	size: number;
	sha256: string;
	now: number;
	/**
	 * The pending row must be younger than this (updated after `now - maxPendingAgeMs`). An older one may already be
	 * taken over by another upload of the same content or by the cleanup, which remove its object (FR-008).
	 */
	maxPendingAgeMs: number;
};

/** Marks a key that is moving between two rows inside one batch (`r2_key` is UNIQUE). Never visible outside it. */
const MOVING = "moving:";

/**
 * Switches a ready file to new content in one batch (specs/005-replace-content). The pending row of the new content
 * becomes a `deleting` row that holds the old content (key, name, type, size, SHA-256), and the file takes the new key
 * and metadata. Both keys always have a row, so R2 objects are never left without one, and the file's key always has
 * an object (constitution III). Nothing changes unless the file is still `ready` with `expectedSha256` and the
 * pending row is still there and young enough. Returns whether the file was switched.
 */
export async function switchContent(db: D1Database, change: ContentSwitch): Promise<boolean> {
	const results = await db.batch([
		// 1. The pending row takes the old content. Its key gets a prefix until the file lets go of it.
		db
			.prepare(
				`UPDATE files SET
				   status = 'deleting',
				   r2_key = ?3 || (SELECT r2_key FROM files WHERE id = ?1),
				   name = (SELECT name FROM files WHERE id = ?1),
				   content_type = (SELECT content_type FROM files WHERE id = ?1),
				   size = (SELECT size FROM files WHERE id = ?1),
				   sha256 = (SELECT sha256 FROM files WHERE id = ?1),
				   updated_at = ?5
				 WHERE id = ?2 AND status = 'pending' AND r2_key = ?4 AND updated_at > ?7
				   AND EXISTS (SELECT 1 FROM files WHERE id = ?1 AND status = 'ready' AND sha256 = ?6)`,
			)
			.bind(
				change.targetId,
				change.pendingId,
				MOVING,
				change.r2Key,
				change.now,
				change.expectedSha256,
				change.now - change.maxPendingAgeMs,
			),
		// 2. The file takes the new content. Its ID, created_at, links, and tags stay.
		db
			.prepare(
				`UPDATE files SET r2_key = ?3, name = ?4, content_type = ?5, size = ?6, sha256 = ?7, updated_at = ?8
				 WHERE id = ?1 AND status = 'ready' AND sha256 = ?9
				   AND EXISTS (SELECT 1 FROM files WHERE id = ?2 AND status = 'deleting' AND r2_key = ?10 || (SELECT r2_key FROM files WHERE id = ?1))`,
			)
			.bind(
				change.targetId,
				change.pendingId,
				change.r2Key,
				change.name,
				change.contentType,
				change.size,
				change.sha256,
				change.now,
				change.expectedSha256,
				MOVING,
			),
		// 3. The old key, now free, goes to the deleting row.
		db
			.prepare(
				`UPDATE files SET r2_key = substr(r2_key, length(?3) + 1)
				 WHERE id = ?2 AND status = 'deleting' AND substr(r2_key, 1, length(?3)) = ?3
				   AND EXISTS (SELECT 1 FROM files WHERE id = ?1 AND r2_key = ?4)`,
			)
			.bind(change.targetId, change.pendingId, MOVING, change.r2Key),
	]);
	return (results[1]?.meta.changes ?? 0) > 0;
}

/** Removes the row left by a replacement (the old content). Call only after its R2 object is gone. */
export async function deleteReplacedRow(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM files WHERE id = ? AND status = 'deleting'").bind(id).run();
}
