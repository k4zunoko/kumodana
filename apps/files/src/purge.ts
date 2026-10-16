import type { PurgeResult } from "@kumodana/shared/api-types";

const TAG_PATTERN = /^(l:[A-Za-z0-9_-]{22}|f:[0-9a-hjkmnp-tv-z]{10})$/;
const MAX_TAGS = 100;

/**
 * Purges this Worker's cache by tag (contracts/files-rpc.md). Purges are scoped to the entrypoint
 * that owns the cache, so this must run inside the delivery Worker. Never throws.
 */
export async function purgeTags(cache: CacheContext | undefined, tags: unknown): Promise<PurgeResult> {
	if (
		!Array.isArray(tags) ||
		tags.length < 1 ||
		tags.length > MAX_TAGS ||
		!tags.every((tag) => typeof tag === "string" && TAG_PATTERN.test(tag))
	) {
		return { ok: false, error: "invalid_tag" };
	}
	if (!cache) return { ok: false, error: "cache_unavailable" };
	try {
		const result = await cache.purge({ tags });
		if (result.success) return { ok: true };
		const error = result.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
		return { ok: false, error: error || "purge_failed" };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
