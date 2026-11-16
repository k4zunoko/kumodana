/** Types shared by the admin Worker and the kumo CLI. See specs/001-share-shelf-mvp/contracts/admin-api.md. */

export type FileSummary = {
	id: string;
	name: string;
	contentType: string;
	size: number;
	sha256: string;
	createdAt: string;
	/**
	 * When the current content was put in place: when the upload finished, or when the content was last replaced
	 * (specs/005-replace-content). Added in 005; older admin Workers do not send it.
	 */
	updatedAt: string;
	tags: string[];
	activeLinkCount: number;
};

/** What a file's content was before a replacement (specs/005-replace-content). */
export type ContentSummary = Pick<FileSummary, "name" | "contentType" | "size" | "sha256">;

export type Link = {
	token: string;
	fileId: string;
	url: string;
	label: string | null;
	createdAt: string;
	revokedAt: string | null;
};

export type PurgeResult = { ok: true } | { ok: false; error: string };

export type Usage = {
	usedBytes: number;
	limitBytes: number;
	remainingBytes: number;
	fileCount: number;
};

export type TagCount = { tag: string; fileCount: number };

export const ERROR_CODES = [
	"unauthenticated",
	"forbidden",
	"cross_site_request",
	"invalid_request",
	"not_found",
	"length_required",
	"file_too_large",
	"unsupported_type",
	"quota_exceeded",
	"upload_in_progress",
	"checksum_mismatch",
	"storage_error",
	"invalid_tag",
	/** The new content of a replacement is already stored as another file (specs/005-replace-content). */
	"duplicate_content",
	/** The If-Match of a replacement is not the file's current SHA-256 (specs/005-replace-content). */
	"precondition_failed",
	"internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorBody = {
	error: {
		code: ErrorCode;
		message: string;
		details?: Record<string, unknown>;
	};
};

export type UploadResponse = { file: FileSummary; duplicate: boolean };
export type FileListResponse = { files: FileSummary[]; nextCursor: string | null };
export type FileDetailResponse = { file: FileSummary; links: Link[] };
export type DeleteFileResponse = { deleted: string; revokedLinks: number; purge: PurgeResult | null };
export type TagsResponse = { tags: string[] };
export type TagListResponse = { tags: TagCount[] };
export type LinkResponse = { link: Link };
export type LinkListResponse = { links: Link[] };
export type RevokeResponse = { link: Link; purge: PurgeResult };
/**
 * `PUT /api/files/{id}/content` (specs/005-replace-content). `replaced: false` means the file already had this
 * content: nothing changed and only the purge was retried. `previous` is the content before the request.
 */
export type ReplaceContentResponse = {
	file: FileSummary;
	replaced: boolean;
	previous: ContentSummary;
	purge: PurgeResult | null;
};

/** Header names used between the CLI and the admin API. */
export const HEADER_CLIENT = "X-Kumodana-Client";
export const HEADER_CLIENT_VALUE = "cli";
export const HEADER_SHA256 = "X-Kumodana-Sha256";
export const HEADER_FILENAME = "X-Kumodana-Filename";
