import { MAX_LABEL_LENGTH } from "@kumodana/shared/limits";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { getFileSummary } from "../db/files.ts";
import { createLink } from "../db/links.ts";
import { toLink } from "../db/rows.ts";
import { ApiError } from "../errors.ts";

const createLinkBody = z.object({ label: z.string().max(MAX_LABEL_LENGTH).optional() }).strict();

/** Parses a JSON body with Zod; an empty body counts as `{}`. */
export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	const text = await request.text();
	let value: unknown = {};
	if (text.trim() !== "") {
		try {
			value = JSON.parse(text);
		} catch {
			throw new ApiError(400, "invalid_request", "本文が JSON ではありません。");
		}
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new ApiError(400, "invalid_request", parsed.error.issues.map((i) => i.message).join(" "));
	return parsed.data;
}

export function linksRoutes(app: Hono<AppEnv>): void {
	app.post("/api/files/:id/links", async (c) => {
		const body = await parseJson(c.req.raw, createLinkBody);
		const file = await getFileSummary(c.env.DB, c.req.param("id"));
		if (!file) throw new ApiError(404, "not_found");
		const label = body.label === undefined || body.label === "" ? null : body.label;
		const row = await createLink(c.env.DB, file.id, label, c.get("deps").now());
		return c.json({ link: toLink(row, String(c.env.FILES_BASE_URL)) }, 201);
	});
}
