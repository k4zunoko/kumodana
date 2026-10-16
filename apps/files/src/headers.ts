/** Response headers for the delivery Worker. See specs/001-share-shelf-mvp/contracts/delivery.md. */

export const SANDBOX_CSP =
	"sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

/** Headers attached to every response. */
export function commonHeaders(): Headers {
	return new Headers({
		"Content-Security-Policy": SANDBOX_CSP,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"X-Robots-Tag": "noindex, nofollow, noarchive",
	});
}

/** Headers for non-200 responses. */
export function uncachedHeaders(): Headers {
	const headers = commonHeaders();
	headers.set("Cache-Control", "no-store");
	return headers;
}

/** Adds the 200-only cache headers. */
export function applyCacheHeaders(headers: Headers, token: string, fileId: string): void {
	headers.set("Cache-Control", "public, max-age=60");
	headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=3600, stale-if-error=0");
	headers.set("Cache-Tag", `l:${token},f:${fileId}`);
}

/** RFC 5987 `filename*` value for Content-Disposition. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename*=UTF-8''${encoded}`;
}
