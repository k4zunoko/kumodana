import type { TagCount } from "@kumodana/shared/api-types";

export async function changeTags(db: D1Database, fileId: string, add: string[], remove: string[]): Promise<string[]> {
	const statements = [
		...add.map((tag) => db.prepare("INSERT OR IGNORE INTO file_tags (file_id, tag) VALUES (?, ?)").bind(fileId, tag)),
		...remove.map((tag) => db.prepare("DELETE FROM file_tags WHERE file_id = ? AND tag = ?").bind(fileId, tag)),
	];
	if (statements.length > 0) await db.batch(statements);
	const { results } = await db
		.prepare("SELECT tag FROM file_tags WHERE file_id = ? ORDER BY tag")
		.bind(fileId)
		.all<{ tag: string }>();
	return results.map((r) => r.tag);
}

/** Tags on ready files with their counts, most used first, then by name (FR-026). */
export async function listTagCounts(db: D1Database): Promise<TagCount[]> {
	const { results } = await db
		.prepare(
			`SELECT t.tag AS tag, COUNT(*) AS file_count
			 FROM file_tags t JOIN files f ON f.id = t.file_id
			 WHERE f.status = 'ready'
			 GROUP BY t.tag
			 ORDER BY file_count DESC, t.tag`,
		)
		.all<{ tag: string; file_count: number }>();
	return results.map((r) => ({ tag: r.tag, fileCount: r.file_count }));
}
