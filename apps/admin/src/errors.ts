import type { ErrorCode } from "@kumodana/shared/api-types";

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
	unauthenticated: "認証情報がないか、無効です。",
	forbidden: "この操作を行う権限がありません。",
	cross_site_request: "ブラウザ経由の他サイトからの要求は受け付けません。",
	invalid_request: "要求の形式が正しくありません。",
	not_found: "見つかりません。",
	length_required: "Content-Length ヘッダーが必要です。",
	file_too_large: "ファイルが大きすぎます。100MB 未満にしてください。",
	unsupported_type: "対象外の形式です。",
	quota_exceeded: "保存量の上限を超えるため保存できません。",
	upload_in_progress: "同じ内容のファイルをアップロード中です。",
	checksum_mismatch: "受け取った内容が SHA-256 と一致しません。もう一度アップロードしてください。",
	storage_error: "ファイルの保存に失敗しました。もう一度アップロードしてください。",
	invalid_tag: "タグの形式が正しくありません。",
	internal_error: "内部エラーが発生しました。",
};

/** An error that becomes a JSON error response. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(status: number, code: ErrorCode, message?: string, details?: Record<string, unknown>) {
		super(message ?? DEFAULT_MESSAGES[code]);
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export function errorResponse(error: ApiError): Response {
	const body = {
		error: {
			code: error.code,
			message: error.message,
			...(error.details ? { details: error.details } : {}),
		},
	};
	return Response.json(body, { status: error.status });
}
