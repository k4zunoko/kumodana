import type { FileSummary } from "@kumodana/shared/api-types";
import { type FileRow, SUMMARY_COLUMNS, type SummaryRow, toFileSummary } from "./rows.ts";

export type NewFile = {
	id: string;
	name: string;
	contentType: string;
	size: number;
	sha256: string;
	now: number;
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
			.bind(file.id, `files/${file.id}`, file.name, file.contentType, file.size, file.sha256, file.now, limitBytes)
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
