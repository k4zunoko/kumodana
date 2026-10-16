import { type ErrorBody, HEADER_CLIENT, HEADER_CLIENT_VALUE } from "@kumodana/shared/api-types";
import type { CliConfig } from "./config.ts";
import { CliError } from "./errors.ts";

/** An error returned by the admin API (or by Cloudflare in front of it). */
export class ApiError extends CliError {
	readonly status: number;

	constructor(
		status: number,
		code: string,
		message: string,
		options: { hint?: string; details?: Record<string, unknown> } = {},
	) {
		super(message, { code, hint: options.hint, details: options.details });
		this.status = status;
	}
}

type RequestOptions = {
	query?: Record<string, string | string[] | undefined>;
	json?: unknown;
	body?: BodyInit;
	headers?: Record<string, string>;
};

const AUTH_HINT =
	"KUMODANA_CLIENT_ID と KUMODANA_CLIENT_SECRET（設定ファイルでは clientId と clientSecret）が正しいか、" +
	"サービストークンの期限が切れていないか確認してください。";

/** Client for the admin API. Adds the Access service-token headers and the client header. */
export class AdminApi {
	readonly config: CliConfig;
	readonly fetchImpl: typeof fetch;

	constructor(config: CliConfig, fetchImpl: typeof fetch = fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	url(path: string, query?: RequestOptions["query"]): string {
		const url = new URL(`${this.config.adminUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
		}
		return url.toString();
	}

	/** Sends a request and returns the raw response for 2xx; throws ApiError otherwise. */
	async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
		const headers = new Headers(options.headers);
		headers.set("CF-Access-Client-Id", this.config.clientId);
		headers.set("CF-Access-Client-Secret", this.config.clientSecret);
		headers.set(HEADER_CLIENT, HEADER_CLIENT_VALUE);
		let body: BodyInit | undefined;
		if (options.json !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(options.json);
		} else if (options.body) {
			body = options.body;
		}

		let response: Response;
		try {
			response = await this.fetchImpl(this.url(path, options.query), { method, headers, body, redirect: "manual" });
		} catch (error) {
			throw networkError(error);
		}
		if (response.ok) return response;
		throw await toApiError(response);
	}

	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const response = await this.raw(method, path, options);
		return (await response.json()) as T;
	}
}

function networkError(error: unknown): CliError {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
	return new CliError(`管理 API に接続できませんでした: ${cause}`, {
		hint:
			"ネットワークと KUMODANA_ADMIN_URL を確認してください。社内プロキシ経由の場合は " +
			"NODE_USE_ENV_PROXY=1 と HTTPS_PROXY を設定してください。",
		code: "network_error",
	});
}

/** Maps API and Cloudflare errors to messages that say what to check. */
export async function toApiError(response: Response): Promise<ApiError> {
	const status = response.status;
	if (status >= 300 && status < 400) {
		const location = response.headers.get("Location") ?? "";
		if (location.includes("cloudflareaccess.com")) {
			return new ApiError(status, "access_login_required", "Cloudflare Access のログイン画面に転送されました。", {
				hint: `サービストークンが受け付けられていません。${AUTH_HINT} Access のポリシーに Service Auth があるかも確認してください。`,
			});
		}
		return new ApiError(status, "unexpected_redirect", `予期しない転送です（HTTP ${status}）。`, {
			hint: "KUMODANA_ADMIN_URL が管理用 Worker の URL か確認してください。",
		});
	}

	const text = await response.text();
	let body: ErrorBody | undefined;
	try {
		body = JSON.parse(text) as ErrorBody;
	} catch {
		body = undefined;
	}

	if (body?.error?.code) {
		const { code, message, details } = body.error;
		let hint: string | undefined;
		if (code === "unauthenticated") hint = AUTH_HINT;
		if (code === "forbidden") {
			hint = "このサービストークンは許可されていません。管理用 Worker の CLI_CLIENT_ID と Access のポリシーを確認してください。";
		}
		return new ApiError(status, code, message, { hint, details });
	}

	if (status === 401 || status === 403) {
		return new ApiError(status, "access_denied", `Cloudflare Access に拒否されました（HTTP ${status}）。`, {
			hint: AUTH_HINT,
		});
	}
	return new ApiError(status, "http_error", `管理 API がエラーを返しました（HTTP ${status}）。`, {
		hint:
			status === 429 || status >= 500
				? "Workers の 1 日の無料枠の上限に達した可能性があります（日本時間 9 時にリセット）。時間をおいて再実行してください。"
				: undefined,
	});
}
