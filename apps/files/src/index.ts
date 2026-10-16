import { WorkerEntrypoint } from "cloudflare:workers";
import { LINK_TOKEN_PATTERN } from "@kumodana/shared/ids";
import type { PurgeResult } from "@kumodana/shared/api-types";
import { applyCacheHeaders, commonHeaders, contentDisposition, uncachedHeaders } from "./headers.ts";
import { purgeTags } from "./purge.ts";

type DeliveryRow = {
	id: string;
	r2_key: string;
	name: string;
	content_type: string;
	size: number;
	sha256: string;
};

function notFound(): Response {
	const headers = uncachedHeaders();
	headers.set("Content-Type", "text/plain; charset=utf-8");
	return new Response("Not Found", { status: 404, headers });
}

function redirectTo(location: string): Response {
	const headers = uncachedHeaders();
	headers.set("Location", location);
	return new Response(null, { status: 301, headers });
}

function methodNotAllowed(): Response {
	const headers = uncachedHeaders();
	headers.set("Allow", "GET, HEAD");
	return new Response(null, { status: 405, headers });
}

/**
 * Delivery Worker (kumo). Workers Cache sits in front of `fetch`; only cache misses reach this code.
 * It never writes to D1 or R2 (constitution III).
 */
export default class Files extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();

		const url = new URL(request.url);
		const token = url.pathname.slice(1);
		if (!LINK_TOKEN_PATTERN.test(token)) return notFound();
		// Query strings would bypass the cache (it keys on them), so never serve content for them (FR-022).
		if (url.search !== "") return redirectTo(`/${token}`);

		// One lookup: an active link to a ready file (FR-012, FR-021).
		const row = await this.env.DB.prepare(
			`SELECT f.id, f.r2_key, f.name, f.content_type, f.size, f.sha256
			 FROM links l JOIN files f ON f.id = l.file_id
			 WHERE l.token = ? AND l.revoked_at IS NULL AND f.status = 'ready'`,
		)
			.bind(token)
			.first<DeliveryRow>();
		if (!row) return notFound();

		if (request.method === "HEAD") {
			const object = await this.env.BUCKET.head(row.r2_key);
			if (!object) return notFound();
			return new Response(null, { status: 200, headers: deliveryHeaders(row, token) });
		}
		const object = await this.env.BUCKET.get(row.r2_key);
		if (!object) return notFound();
		return new Response(object.body, { status: 200, headers: deliveryHeaders(row, token) });
	}

	/** RPC for the admin Worker: purge this Worker's cache by tag (contracts/files-rpc.md). */
	async purge(tags: string[]): Promise<PurgeResult> {
		return purgeTags(this.ctx.cache, tags);
	}
}

function deliveryHeaders(row: DeliveryRow, token: string): Headers {
	const headers = commonHeaders();
	headers.set("Content-Type", row.content_type);
	headers.set("Content-Length", String(row.size));
	headers.set("ETag", `"${row.sha256}"`);
	headers.set("Content-Disposition", contentDisposition("inline", row.name));
	applyCacheHeaders(headers, token, row.id);
	return headers;
}
