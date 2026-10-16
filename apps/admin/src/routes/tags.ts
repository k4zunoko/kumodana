import { MAX_TAG_CHANGES } from "@kumodana/shared/limits";
import { normalizeTag } from "@kumodana/shared/names";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { getFileSummary } from "../db/files.ts";
import { changeTags, listTagCounts } from "../db/tags.ts";
import { ApiError } from "../errors.ts";
import { parseJson } from "./links.ts";

const patchTagsBody = z
	.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() })
	.strict()
	.refine((b) => {
		const count = (b.add?.length ?? 0) + (b.remove?.length ?? 0);
		return count >= 1 && count <= MAX_TAG_CHANGES;
	}, `add と remove は合わせて 1〜${MAX_TAG_CHANGES} 件にしてください。`);

/** Normalizes tags; any invalid tag rejects the whole request with invalid_tag. */
export function normalizeTags(values: string[]): string[] {
	return values.map((value) => {
		const result = normalizeTag(value);
		if (!result.ok) throw new ApiError(400, "invalid_tag", `${result.reason}（${value}）`);
		return result.tag;
	});
}

export function tagsRoutes(app: Hono<AppEnv>): void {
	app.patch("/api/files/:id/tags", async (c) => {
		const body = await parseJson(c.req.raw, patchTagsBody);
		const add = normalizeTags(body.add ?? []);
		const remove = normalizeTags(body.remove ?? []);
		const file = await getFileSummary(c.env.DB, c.req.param("id"));
		if (!file) throw new ApiError(404, "not_found");
		return c.json({ tags: await changeTags(c.env.DB, file.id, add, remove) });
	});

	app.get("/api/tags", async (c) => c.json({ tags: await listTagCounts(c.env.DB) }));
}
