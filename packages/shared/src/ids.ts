/** Crockford Base32 alphabet in lower case (no i, l, o, u). */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export const FILE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{10}$/;
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** A 10-character Crockford Base32 ID (50 random bits). */
export function newFileId(): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let id = "";
	for (const byte of bytes) id += CROCKFORD[byte & 31];
	return id;
}

/** A 22-character Base64URL token made of 16 random bytes (128 bits, FR-014). */
export function newLinkToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isFileId(value: string): boolean {
	return FILE_ID_PATTERN.test(value);
}

export function isLinkToken(value: string): boolean {
	return LINK_TOKEN_PATTERN.test(value);
}
