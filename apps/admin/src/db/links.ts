import { newLinkToken } from "@kumodana/shared/ids";
import type { LinkRow } from "./rows.ts";

export async function createLink(db: D1Database, fileId: string, label: string | null, now: number): Promise<LinkRow> {
	const row: LinkRow = { token: newLinkToken(), file_id: fileId, label, created_at: now, revoked_at: null };
	await db
		.prepare("INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
		.bind(row.token, row.file_id, row.label, row.created_at)
		.run();
	return row;
}

export async function getLink(db: D1Database, token: string): Promise<LinkRow | null> {
	return db.prepare("SELECT * FROM links WHERE token = ?").bind(token).first<LinkRow>();
}

/** Sets revoked_at unless it is already set; returns the updated row. */
export async function revokeLink(db: D1Database, token: string, now: number): Promise<LinkRow | null> {
	await db.prepare("UPDATE links SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").bind(now, token).run();
	return getLink(db, token);
}

export async function listLinks(
	db: D1Database,
	options: { fileId?: string; includeRevoked: boolean },
): Promise<LinkRow[]> {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if (options.fileId) {
		conditions.push("file_id = ?");
		params.push(options.fileId);
	}
	if (!options.includeRevoked) conditions.push("revoked_at IS NULL");
	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const { results } = await db
		.prepare(`SELECT * FROM links ${where} ORDER BY created_at DESC, token`)
		.bind(...params)
		.all<LinkRow>();
	return results;
}
