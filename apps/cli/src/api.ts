import { type ErrorBody, HEADER_CLIENT, HEADER_CLIENT_VALUE } from "@kumodana/shared/api-types";
import type { CliConfig } from "./config.ts";
import { type Credentials, loginRequired, ServiceTokenCredentials } from "./credentials.ts";
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

const LOGIN_ACCOUNT_HINT =
	"ログインしたアカウントが所有者のもの（管理用 Worker の OWNER_EMAIL）か確かめてください。";

const LOGIN_ACCESS_HINT =
	"ログインしたアカウントが所有者のものか、Access の owner ポリシーを確かめてください。";

export type AuthKind = Credentials["kind"];

/**
 * Client for the admin API. Adds the credentials of the chosen method and the client header. With the login
 * method, a 401 triggers one refresh and one retry of the same request (specs/003-cli-login research L8).
 */
export class AdminApi {
	readonly adminUrl: string;
	readonly credentials: Credentials;
	readonly fetchImpl: typeof fetch;

	constructor(
		target: CliConfig | { adminUrl: string; credentials: Credentials },
		fetchImpl: typeof fetch = (input, init) => fetch(input, init),
	) {
		this.adminUrl = target.adminUrl;
		this.credentials = "credentials" in target ? target.credentials : new ServiceTokenCredentials(target);
		this.fetchImpl = fetchImpl;
	}

	url(path: string, query?: RequestOptions["query"]): string {
		const url = new URL(`${this.adminUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
		}
		return url.toString();
	}

	/** Sends a request and returns the raw response for 2xx; throws ApiError otherwise. */
	async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
		let body: BodyInit | undefined;
		let contentType: string | undefined;
		if (options.json !== undefined) {
			contentType = "application/json";
			body = JSON.stringify(options.json);
		} else if (options.body) {
			body = options.body;
		}
		const url = this.url(path, options.query);

		const send = async (): Promise<Response> => {
			const headers = new Headers(options.headers);
			for (const [name, value] of Object.entries(await this.credentials.headers())) headers.set(name, value);
			headers.set(HEADER_CLIENT, HEADER_CLIENT_VALUE);
			if (contentType) headers.set("Content-Type", contentType);
			try {
				return await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
			} catch (error) {
				throw networkError(error);
			}
		};

		let response = await send();
		if (response.ok) return response;

		const resendable = !(body instanceof ReadableStream);
		if (this.credentials.kind === "login" && response.status === 401 && this.credentials.refresh && resendable) {
			await response.body?.cancel();
			await this.credentials.refresh();
			response = await send();
			if (response.ok) return response;
			if (response.status === 401) {
				await response.body?.cancel();
				throw loginRequired();
			}
		}
		throw await toApiError(response, this.credentials.kind);
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
export async function toApiError(response: Response, kind: AuthKind = "service_token"): Promise<ApiError> {
	const status = response.status;
	const login = kind === "login";
	if (status >= 300 && status < 400) {
		const location = response.headers.get("Location") ?? "";
		if (location.includes("cloudflareaccess.com") && login) {
			await response.body?.cancel();
			const required = loginRequired();
			return new ApiError(status, required.code, required.message, { hint: required.hint });
		}
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
		if (login && status === 401) {
			const required = loginRequired();
			return new ApiError(status, required.code, required.message, { hint: required.hint, details });
		}
		let hint: string | undefined;
		if (code === "unauthenticated") hint = AUTH_HINT;
		if (code === "forbidden") {
			hint = login
				? LOGIN_ACCOUNT_HINT
				: "このサービストークンは許可されていません。管理用 Worker の CLI_CLIENT_ID と Access のポリシーを確認してください。";
		}
		return new ApiError(status, code, message, { hint, details });
	}

	if (login && status === 401) {
		const required = loginRequired();
		return new ApiError(status, required.code, required.message, { hint: required.hint });
	}
	if (status === 401 || status === 403) {
		return new ApiError(status, "access_denied", `Cloudflare Access に拒否されました（HTTP ${status}）。`, {
			hint: login ? LOGIN_ACCESS_HINT : AUTH_HINT,
		});
	}
	return new ApiError(status, "http_error", `管理 API がエラーを返しました（HTTP ${status}）。`, {
		hint:
			status === 429 || status >= 500
				? "Workers の 1 日の無料枠の上限に達した可能性があります（日本時間 9 時にリセット）。時間をおいて再実行してください。"
				: undefined,
	});
}
