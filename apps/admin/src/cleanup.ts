/** `pending` rows older than this are abandoned uploads (released within 45 minutes with a 15-minute cron). */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** `deleting` rows older than this are deletions that stopped midway (Worker interrupted). */
export const DELETING_TTL_MS = 15 * 60 * 1000;

type StaleRow = { id: string; r2_key: string };

/**
 * Removes leftovers: R2 object first, then the row (constitution III: `ready` rows are never touched).
 * Failures are logged and retried on the next run.
 */
export async function runCleanup(env: Env, now: number): Promise<number> {
	const { results } = await env.DB.prepare(
		`SELECT id, r2_key FROM files
		 WHERE (status = 'pending' AND updated_at < ?) OR (status = 'deleting' AND updated_at < ?)`,
	)
		.bind(now - PENDING_TTL_MS, now - DELETING_TTL_MS)
		.all<StaleRow>();

	let removed = 0;
	for (const row of results) {
		try {
			await env.BUCKET.delete(row.r2_key);
			await env.DB.prepare("DELETE FROM files WHERE id = ? AND status != 'ready'").bind(row.id).run();
			removed++;
		} catch (error) {
			console.error(`cleanup failed for ${row.id}`, error);
		}
	}
	return removed;
}
