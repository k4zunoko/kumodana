import { HEADER_CLIENT, HEADER_CLIENT_VALUE } from "@kumodana/shared/api-types";
import { ApiError } from "./errors.ts";

/**
 * Rejects requests that a browser could send from another site (research R6).
 * admin and delivery live on the same site (<subdomain>.workers.dev), so SameSite cookies do not help.
 */
export function assertNotCrossSite(request: Request): void {
	if (request.headers.get(HEADER_CLIENT) !== HEADER_CLIENT_VALUE) {
		throw new ApiError(403, "cross_site_request");
	}
	if (request.headers.has("Origin")) {
		throw new ApiError(403, "cross_site_request");
	}
	const site = request.headers.get("Sec-Fetch-Site");
	if (site !== null && site !== "same-origin" && site !== "none") {
		throw new ApiError(403, "cross_site_request");
	}
}
