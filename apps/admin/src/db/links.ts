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
