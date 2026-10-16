/** RFC 5987 Content-Disposition with a UTF-8 `filename*` (non-ASCII names stay intact). */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename*=UTF-8''${encoded}`;
}

/** Reads the file name back from a Content-Disposition header written by `contentDisposition`. */
export function filenameFromDisposition(header: string | null): string | undefined {
	if (!header) return undefined;
	const match = /filename\*=UTF-8''([^;]+)/i.exec(header);
	if (!match?.[1]) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}
