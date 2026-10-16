/** Content types accepted by kumodana (FR-002). */
export const ALLOWED_CONTENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/svg+xml",
	"text/html",
	"text/html; charset=utf-8",
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export function isAllowedContentType(value: string): value is AllowedContentType {
	return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Maximum file size in bytes. "Under 100MB", read in decimal so it is below every interpretation (FR-003). */
export const MAX_FILE_BYTES = 99_999_999;

/** Maximum number of tags in one list filter (FR-024). */
export const MAX_FILTER_TAGS = 10;

/** Maximum number of tag additions and removals in one request. */
export const MAX_TAG_CHANGES = 50;

/** Maximum length of a link label. */
export const MAX_LABEL_LENGTH = 200;

/** Maximum length of an original file name. */
export const MAX_NAME_LENGTH = 255;
