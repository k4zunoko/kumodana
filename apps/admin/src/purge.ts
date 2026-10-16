import type { PurgeResult } from "@kumodana/shared/api-types";

type PurgeService = { purge(tags: string[]): Promise<PurgeResult> };

/**
 * Asks the delivery Worker to purge its cache (contracts/files-rpc.md). Only the delivery Worker can
 * purge its own cache. Never throws; failures come back as `ok: false` so callers can report them.
 */
export async function purgeViaBinding(env: Env, tags: string[]): Promise<PurgeResult> {
	const files = (env as unknown as { FILES?: PurgeService }).FILES;
	if (!files) return { ok: false, error: "binding_unavailable" };
	try {
		return await files.purge(tags);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
