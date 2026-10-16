import type { FileSummary, Link } from "@kumodana/shared/api-types";

export type FileStatus = "pending" | "ready" | "deleting";

export type FileRow = {
	id: string;
	r2_key: string;
	name: string;
	content_type: string;
	size: number;
	sha256: string;
	status: FileStatus;
	created_at: number;
	updated_at: number;
};

/** Columns for a FileSummary. Tags never contain control characters, so char(31) separates them safely. */
export const SUMMARY_COLUMNS = `
	f.id, f.name, f.content_type, f.size, f.sha256, f.created_at,
	(SELECT group_concat(tag, char(31)) FROM (SELECT tag FROM file_tags WHERE file_id = f.id ORDER BY tag)) AS tags,
	(SELECT COUNT(*) FROM links l WHERE l.file_id = f.id AND l.revoked_at IS NULL) AS active_links`;

export type SummaryRow = {
	id: string;
	name: string;
	content_type: string;
	size: number;
	sha256: string;
	created_at: number;
	tags: string | null;
	active_links: number;
};

export function toFileSummary(row: SummaryRow): FileSummary {
	return {
		id: row.id,
		name: row.name,
		contentType: row.content_type,
		size: row.size,
		sha256: row.sha256,
		createdAt: new Date(row.created_at).toISOString(),
		tags: row.tags ? row.tags.split("\u001f") : [],
		activeLinkCount: row.active_links,
	};
}

export type LinkRow = {
	token: string;
	file_id: string;
	label: string | null;
	created_at: number;
	revoked_at: number | null;
};

export function toLink(row: LinkRow, baseUrl: string): Link {
	return {
		token: row.token,
		fileId: row.file_id,
		url: `${baseUrl.replace(/\/+$/, "")}/${row.token}`,
		label: row.label,
		createdAt: new Date(row.created_at).toISOString(),
		revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
	};
}
