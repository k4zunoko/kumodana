import { WorkerEntrypoint } from "cloudflare:workers";
import { uncachedHeaders } from "./headers.ts";

function notFound(): Response {
	const headers = uncachedHeaders();
	headers.set("Content-Type", "text/plain; charset=utf-8");
	return new Response("Not Found", { status: 404, headers });
}

function methodNotAllowed(): Response {
	const headers = uncachedHeaders();
	headers.set("Allow", "GET, HEAD");
	return new Response(null, { status: 405, headers });
}

/** Delivery Worker (kumo). */
export default class Files extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
		return notFound();
	}
}
