import { createHash, randomBytes } from "node:crypto";
import type { UrlPolicy } from "./context.ts";
import { CliError } from "./errors.ts";
import { allowedUrl, type LoginEndpoints } from "./login-store.ts";

/**
 * OAuth 2.0 with Cloudflare Access Managed OAuth, using only `fetch` and `node:crypto` (specs/003-cli-login
 * research L4〜L8, L12). Token requests never follow redirects, so a refresh token cannot be sent elsewhere.
 */

export type Discovery = { resource: string; endpoints: LoginEndpoints };
export type TokenSet = { accessToken: string; refreshToken?: string; expiresIn: number };

/** An error response from the authorization server (`error` and `error_description` only). */
export class OAuthError extends CliError {
	readonly error: string;
	readonly status: number;
	/** `error` and `error_description` alone, for messages that already say what failed. */
	readonly reason: string;

	constructor(status: number, error: string, description: string | undefined, message: string, code: string) {
		const reason = `${error}${description ? `: ${description}` : ""}`;
		super(`${message}（${reason}）`, { code });
		this.error = error;
		this.status = status;
		this.reason = reason;
	}
}

/** A short reason for a message that already says what failed: OAuth's error, or the message of other errors. */
export function failureReason(error: unknown): string {
	if (error instanceof OAuthError) return error.reason;
	return error instanceof Error ? error.message : String(error);
}

/** Keeps a server-provided string printable and short before it reaches the terminal. */
export function clean(value: unknown, max = 200): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
	return text === "" ? undefined : text.length > max ? `${text.slice(0, max)}…` : text;
}

const UNAVAILABLE_HINT =
	"管理用 Worker の Access で Managed OAuth が有効になっているか確かめてください。" +
	"ログインが使えないあいだは、サービストークン（環境変数か config.json）で使い続けられます（docs/runbook.md §7）。";

function unavailable(message: string): CliError {
	return new CliError(message, { code: "login_unavailable", hint: UNAVAILABLE_HINT });
}

function networkError(error: unknown): CliError {
	const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
	return new CliError(`ログインの仕組み（Access）に接続できませんでした: ${cause}`, {
		code: "network_error",
		hint:
			"ネットワークと管理 API の URL を確認してください。社内プロキシ経由の場合は " +
			"NODE_USE_ENV_PROXY=1 と HTTPS_PROXY を設定してください。",
	});
}

async function getMetadata(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetchImpl(url, { headers: { Accept: "application/json" }, redirect: "manual" });
	} catch (error) {
		throw networkError(error);
	}
	if (response.status !== 200) {
		await response.body?.cancel();
		throw unavailable(`ログインの接続先の情報を取得できませんでした（HTTP ${response.status}）: ${url}`);
	}
	try {
		const data = (await response.json()) as unknown;
		if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
	} catch {
		// fall through
	}
	throw unavailable(`ログインの接続先の情報が JSON ではありません: ${url}`);
}

/**
 * Reads the protected-resource and authorization-server metadata from the admin API's own domain (research L4).
 * The `issuer` is not checked: Cloudflare's examples give it without `https://`.
 */
export async function discover(adminUrl: string, fetchImpl: typeof fetch, policy: UrlPolicy): Promise<Discovery> {
	const resourceMeta = await getMetadata(`${adminUrl}/.well-known/oauth-protected-resource`, fetchImpl);
	const resource = allowedUrl(resourceMeta.resource, policy);
	if (!resource || resource.origin !== new URL(adminUrl).origin) {
		throw unavailable("ログインの接続先の情報に、管理 API の resource がありません。");
	}

	const serverMeta = await getMetadata(`${adminUrl}/.well-known/oauth-authorization-server`, fetchImpl);
	const methods = serverMeta.code_challenge_methods_supported;
	if (!Array.isArray(methods) || !methods.includes("S256")) {
		throw unavailable("ログインの仕組みが PKCE（S256）に対応していません。");
	}
	const fields = {
		authorization: "authorization_endpoint",
		token: "token_endpoint",
		revocation: "revocation_endpoint",
		registration: "registration_endpoint",
	} as const;
	const endpoints = {} as LoginEndpoints;
	for (const [key, field] of Object.entries(fields) as [keyof LoginEndpoints, string][]) {
		if (!allowedUrl(serverMeta[field], policy)) {
			throw unavailable(`ログインの接続先の情報に、使える ${field} がありません（https: が必要です）。`);
		}
		endpoints[key] = serverMeta[field] as string;
	}
	return { resource: resourceMeta.resource as string, endpoints };
}

/** Dynamic client registration as a public client (research L5). Returns the `client_id`. */
export async function registerClient(endpoint: string, redirectUri: string, fetchImpl: typeof fetch): Promise<string> {
	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				client_name: "kumo CLI",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
			redirect: "error",
		});
	} catch (error) {
		throw networkError(error);
	}
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	if ((response.status === 200 || response.status === 201) && typeof body?.client_id === "string" && body.client_id) {
		return body.client_id;
	}
	const error = clean(body?.error) ?? `HTTP ${response.status}`;
	throw unavailable(`この PC を登録できませんでした（${error}）。`);
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** PKCE S256. The challenge is regenerated until it starts with a letter or digit (#6). */
export function createPkce(random: (size: number) => Uint8Array = randomBytes): { verifier: string; challenge: string } {
	for (;;) {
		const verifier = base64url(random(32));
		const challenge = base64url(createHash("sha256").update(verifier).digest());
		if (/^[A-Za-z0-9]/.test(challenge)) return { verifier, challenge };
	}
}

export function createState(): string {
	return base64url(randomBytes(32));
}

export type AuthorizationParams = {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
	resource: string;
};

/** The URL the browser opens. No `scope` is sent (research L6). */
export function authorizationUrl(endpoint: string, params: AuthorizationParams): string {
	const url = new URL(endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("resource", params.resource);
	return url.toString();
}

async function postForm(endpoint: string, form: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
	try {
		return await fetchImpl(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams(form).toString(),
			redirect: "error",
		});
	} catch (error) {
		throw networkError(error);
	}
}

async function errorFrom(response: Response, message: string, code: string): Promise<OAuthError> {
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const error = clean(body?.error, 64) ?? `http_${response.status}`;
	return new OAuthError(response.status, error, clean(body?.error_description), message, code);
}

async function tokensFrom(response: Response, message: string, code: string): Promise<TokenSet> {
	if (response.status !== 200) throw await errorFrom(response, message, code);
	const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
	const tokenType = body?.token_type;
	if (
		!body ||
		typeof body.access_token !== "string" ||
		body.access_token === "" ||
		(tokenType !== undefined && String(tokenType).toLowerCase() !== "bearer")
	) {
		throw new OAuthError(response.status, "invalid_response", undefined, message, code);
	}
	const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
	const refreshToken = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined;
	return { accessToken: body.access_token, refreshToken, expiresIn };
}

export async function exchangeCode(
	endpoint: string,
	params: { code: string; redirectUri: string; clientId: string; verifier: string; resource: string },
	fetchImpl: typeof fetch,
): Promise<TokenSet> {
	const response = await postForm(
		endpoint,
		{
			grant_type: "authorization_code",
			code: params.code,
			redirect_uri: params.redirectUri,
			client_id: params.clientId,
			code_verifier: params.verifier,
			resource: params.resource,
		},
		fetchImpl,
	);
	return tokensFrom(response, "ログインの結果を資格情報に換えられませんでした", "login_failed");
}

export async function refreshTokens(
	endpoint: string,
	params: { refreshToken: string; clientId: string; resource: string },
	fetchImpl: typeof fetch,
): Promise<TokenSet> {
	const response = await postForm(
		endpoint,
		{
			grant_type: "refresh_token",
			refresh_token: params.refreshToken,
			client_id: params.clientId,
			resource: params.resource,
		},
		fetchImpl,
	);
	return tokensFrom(response, "アクセストークンを更新できませんでした", "refresh_failed");
}

/** `revoked`: this request ended the grant. `already_invalid`: the grant was already revoked or expired. */
export type RevokeResult = "revoked" | "already_invalid";

/**
 * RFC 7009. Revoking the refresh token ends the whole grant, access tokens included (research L2). Access answers a
 * token whose grant is already revoked or expired with `400 invalid_grant`, not RFC 7009's 200 (T035); that means
 * the grant is gone, not that revoking failed. Anything else (network errors, 5xx, other errors) is `revoke_failed`.
 */
export async function revokeToken(
	endpoint: string,
	params: { token: string; clientId: string },
	fetchImpl: typeof fetch,
): Promise<RevokeResult> {
	const response = await postForm(
		endpoint,
		{ token: params.token, token_type_hint: "refresh_token", client_id: params.clientId },
		fetchImpl,
	);
	if (response.status === 200) {
		await response.body?.cancel();
		return "revoked";
	}
	const error = await errorFrom(response, "許可を取り消せませんでした", "revoke_failed");
	if (error.status === 400 && error.error === "invalid_grant") return "already_invalid";
	throw error;
}
