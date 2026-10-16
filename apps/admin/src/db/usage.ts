import type { Usage } from "@kumodana/shared/api-types";

/** Usage counts every row (pending and deleting included), because R2 may still hold their objects. */
export async function getUsage(db: D1Database, limitBytes: number): Promise<Usage> {
	const row = await db
		.prepare("SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS count FROM files")
		.first<{ used: number; count: number }>();
	const usedBytes = row?.used ?? 0;
	return {
		usedBytes,
		limitBytes,
		remainingBytes: Math.max(0, limitBytes - usedBytes),
		fileCount: row?.count ?? 0,
	};
}
