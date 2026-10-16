export const MAX_TAG_LENGTH = 64;

export type TagResult = { ok: true; tag: string } | { ok: false; reason: string };

/** Normalize a tag: NFC, trim, lower case. 1-64 characters, no control characters or commas. */
export function normalizeTag(input: string): TagResult {
	const tag = input.normalize("NFC").trim().toLowerCase();
	if (tag.length === 0) return { ok: false, reason: "タグが空です。" };
	if ([...tag].length > MAX_TAG_LENGTH) {
		return { ok: false, reason: `タグは ${MAX_TAG_LENGTH} 文字以内にしてください。` };
	}
	// biome-ignore lint: control characters are intentionally matched
	if (/[\u0000-\u001f\u007f]/.test(tag)) return { ok: false, reason: "タグに制御文字は使えません。" };
	if (tag.includes(",")) return { ok: false, reason: "タグにカンマは使えません。" };
	return { ok: true, tag };
}
