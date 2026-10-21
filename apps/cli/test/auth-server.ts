import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { CliContext } from "../src/context.ts";
import type { LoginClient, LoginRecord, LoginSession } from "../src/login-store.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { type Captured, captureOutput, sendJson } from "./helpers.ts";

/**
 * specs/003-cli-login: a fake authorization server that also plays the admin API behind Access (research L16).
 * It behaves like Access Managed OAuth as recorded in research L2: refresh tokens change on every refresh and old
 * ones keep working, and revoking a refresh token ends the whole grant, access tokens included.
 */

export type AuthServerOptions = {
	/** Seconds until an access token expires. */
	accessTokenTtl?: number;
	/** The authorize endpoint redirects back with `error=<value>`. */
	authorizeError?: string;
	/** The next code exchange fails with this OAuth error (once). */
	exchangeError?: string;
	/** Every refresh fails with this status and OAuth error. */
	refreshError?: { status: number; error?: string };
	/** Refresh responses leave out `refresh_token`. */
	omitRefreshTokenOnRefresh?: boolean;
	/** The revocation endpoint answers 500. */
	revokeFails?: boolean;
	/** Replaces fields of the authorization-server metadata. */
	metadata?: Record<string, unknown>;
	/** Replaces the protected-resource metadata. */
	resourceMetadata?: Record<string, unknown>;
	/** Answers authorized admin API requests; return true when handled. */
	api?: (req: IncomingMessage, body: Buffer, res: ServerResponse) => boolean;
};

type Grant = { clientId: string; revoked: boolean };

export type AuthServer = {
	url: string;
	options: AuthServerOptions;
	/** Every access and refresh token this server issued, to check that none is printed. */
	issued: string[];
	/** The JSON bodies of the registrations. */
	registrations: Record<string, unknown>[];
	/** The tokens sent to the revocation endpoint. */
	revocations: string[];
	refreshes: number;
	exchanges: number;
	/** Every request: method, path, and the Authorization header. */
	requests: { method: string; path: string; authorization?: string }[];
	/** The query of the last authorization request. */
	lastAuthorize?: URLSearchParams;
	/** The form of the last token request. */
	lastTokenForm?: URLSearchParams;
	/** Plays the browser and Access: follows the authorization URL to the redirect URI. */
	browser: (url: string) => Promise<void>;
	/** Like `cf zero-trust access applications revoke-tokens`: ends every grant. */
	revokeAll: () => void;
	/** Makes every issued access token invalid (as if expired) without touching the grants. */
	expireAccessTokens: () => void;
	close: () => Promise<void>;
};

export const TEST_USAGE = {
	usedBytes: 1_200_000_000,
	limitBytes: 8_000_000_000,
	remainingBytes: 6_800_000_000,
	fileCount: 3,
};

function base64urlSha256(text: string): string {
	return createHash("sha256").update(text).digest("base64url");
}

function tokenError(res: ServerResponse, status: number, error: string): void {
	sendJson(res, status, { error, error_description: `${error} (test)` });
}

export async function mockAuthServer(options: AuthServerOptions = {}): Promise<AuthServer> {
	const clients = new Set<string>();
	const grants = new Map<string, Grant>();
	const codes = new Map<
		string,
		{ clientId: string; redirectUri: string; challenge: string; resource: string; grantId: string }
	>();
	const refreshTokens = new Map<string, string>();
	const accessTokens = new Map<string, { grantId: string; expiresAt: number }>();
	let counter = 0;
	const next = (prefix: string) => `${prefix}${++counter}${randomBytes(8).toString("hex")}`;
	let base = "";

	const state: AuthServer = {
		url: "",
		options,
		issued: [],
		registrations: [],
		revocations: [],
		refreshes: 0,
		exchanges: 0,
		requests: [],
		browser: async (url) => {
			const authorize = await fetch(url, { redirect: "manual" });
			const location = authorize.headers.get("location");
			await authorize.body?.cancel();
			if (!location) return;
			const callback = await fetch(location);
			await callback.text();
		},
		revokeAll: () => {
			for (const grant of grants.values()) grant.revoked = true;
		},
		expireAccessTokens: () => {
			for (const token of accessTokens.values()) token.expiresAt = 0;
		},
		close: async () => {},
	};

	const issue = (grantId: string) => {
		const accessToken = next("oauth:at-");
		const refreshToken = next("oauth:rt-");
		accessTokens.set(accessToken, { grantId, expiresAt: Date.now() + (options.accessTokenTtl ?? 900) * 1000 });
		refreshTokens.set(refreshToken, grantId);
		state.issued.push(accessToken, refreshToken);
		return { accessToken, refreshToken };
	};

	const handle = (req: IncomingMessage, body: Buffer, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", base);
		const authorization = req.headers.authorization;
		state.requests.push({ method: req.method ?? "", path: url.pathname, authorization });

		if (url.pathname === "/.well-known/oauth-protected-resource") {
			sendJson(res, 200, options.resourceMetadata ?? { resource: `${base}/`, authorization_servers: [base] });
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			sendJson(res, 200, {
				issuer: "team.example.invalid",
				authorization_endpoint: `${base}/oauth/authorize`,
				token_endpoint: `${base}/oauth/token`,
				revocation_endpoint: `${base}/cdn-cgi/access/oauth/revoke`,
				registration_endpoint: `${base}/oauth/register`,
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				...options.metadata,
			});
			return;
		}
		if (url.pathname === "/oauth/register" && req.method === "POST") {
			const request = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
			const clientId = next("client-");
			clients.add(clientId);
			state.registrations.push(request);
			sendJson(res, 201, { ...request, client_id: clientId });
			return;
		}
		if (url.pathname === "/oauth/authorize") {
			state.lastAuthorize = url.searchParams;
			const clientId = url.searchParams.get("client_id") ?? "";
			if (!clients.has(clientId)) {
				// RFC 6749 §4.1.2.1: an unknown client is shown in the browser, not sent to the redirect URI.
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end("invalid_client");
				return;
			}
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const target = new URL(redirectUri);
			target.searchParams.set("state", url.searchParams.get("state") ?? "");
			if (options.authorizeError) {
				target.searchParams.set("error", options.authorizeError);
				target.searchParams.set("error_description", "denied (test)");
			} else {
				const code = next("code-");
				const grantId = next("grant-");
				grants.set(grantId, { clientId, revoked: false });
				codes.set(code, {
					clientId,
					redirectUri,
					challenge: url.searchParams.get("code_challenge") ?? "",
					resource: url.searchParams.get("resource") ?? "",
					grantId,
				});
				state.issued.push(code);
				target.searchParams.set("code", code);
			}
			res.writeHead(302, { Location: target.toString() });
			res.end();
			return;
		}
		if (url.pathname === "/oauth/token" && req.method === "POST") {
			const form = new URLSearchParams(body.toString("utf8"));
			state.lastTokenForm = form;
			if (form.get("grant_type") === "authorization_code") {
				state.exchanges++;
				if (options.exchangeError) {
					const error = options.exchangeError;
					options.exchangeError = undefined;
					tokenError(res, 400, error);
					return;
				}
				const code = codes.get(form.get("code") ?? "");
				codes.delete(form.get("code") ?? "");
				if (
					!code ||
					code.clientId !== form.get("client_id") ||
					code.redirectUri !== form.get("redirect_uri") ||
					code.resource !== form.get("resource") ||
					base64urlSha256(form.get("code_verifier") ?? "") !== code.challenge
				) {
					tokenError(res, 400, "invalid_grant");
					return;
				}
				const tokens = issue(code.grantId);
				sendJson(res, 200, {
					access_token: tokens.accessToken,
					refresh_token: tokens.refreshToken,
					token_type: "bearer",
					expires_in: options.accessTokenTtl ?? 900,
					scope: "",
					resource: code.resource,
				});
				return;
			}
			if (form.get("grant_type") === "refresh_token") {
				state.refreshes++;
				if (options.refreshError) {
					tokenError(res, options.refreshError.status, options.refreshError.error ?? "server_error");
					return;
				}
				const grantId = refreshTokens.get(form.get("refresh_token") ?? "");
				const grant = grantId ? grants.get(grantId) : undefined;
				if (!grantId || !grant || grant.revoked || grant.clientId !== form.get("client_id")) {
					tokenError(res, 400, "invalid_grant");
					return;
				}
				const tokens = issue(grantId);
				sendJson(res, 200, {
					access_token: tokens.accessToken,
					...(options.omitRefreshTokenOnRefresh ? {} : { refresh_token: tokens.refreshToken }),
					token_type: "bearer",
					expires_in: options.accessTokenTtl ?? 900,
				});
				return;
			}
			tokenError(res, 400, "unsupported_grant_type");
			return;
		}
		if (url.pathname === "/cdn-cgi/access/oauth/revoke" && req.method === "POST") {
			const form = new URLSearchParams(body.toString("utf8"));
			state.revocations.push(form.get("token") ?? "");
			if (options.revokeFails) {
				tokenError(res, 500, "server_error");
				return;
			}
			const grantId = refreshTokens.get(form.get("token") ?? "");
			const grant = grantId ? grants.get(grantId) : undefined;
			if (grant) grant.revoked = true;
			res.writeHead(200);
			res.end();
			return;
		}

		// The admin API behind Access.
		const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
		const access = accessTokens.get(token);
		const grant = access ? grants.get(access.grantId) : undefined;
		if (!access || !grant || grant.revoked || access.expiresAt < Date.now()) {
			res.writeHead(401, {
				"WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${base}/.well-known/cloudflare-access-protected-resource/x"`,
				"Content-Type": "text/plain",
			});
			res.end("Unauthorized");
			return;
		}
		if (options.api?.(req, body, res)) return;
		if (url.pathname === "/api/usage") {
			sendJson(res, 200, TEST_USAGE);
			return;
		}
		if (url.pathname === "/api/files" && req.method === "GET") {
			sendJson(res, 200, { files: [], nextCursor: null });
			return;
		}
		sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });
	};

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		handle(req, Buffer.concat(chunks), res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	base = `http://127.0.0.1:${port}`;
	state.url = base;
	state.close = () =>
		new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
	return state;
}

const tempHomes: string[] = [];

// Every test file that imports this module removes the folders its tests created (PR #12 review, minor 6).
afterEach(async () => {
	const dirs = tempHomes.splice(0);
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

/** A config folder of its own, so that tests never touch the owner's real config.json or login.json. */
export async function tempConfigHome(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kumo-login-"));
	tempHomes.push(dir);
	return dir;
}

/** The environment a login test runs in: only the config folder, nothing from the real environment. */
export function loginEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
	return { APPDATA: dir, XDG_CONFIG_HOME: dir, ...extra };
}

/** A runtime for the login tests: a private config folder, the fake browser, and http on 127.0.0.1 allowed. */
export function loginRuntime(
	server: AuthServer | undefined,
	dir: string,
	options: { json?: boolean; env?: Record<string, string>; context?: Partial<CliContext> } = {},
): { runtime: Runtime; captured: Captured } {
	const { out, captured } = captureOutput(options.json ?? false);
	const runtime = createRuntime({
		json: options.json ?? false,
		out,
		context: {
			env: loginEnv(dir, options.env),
			urls: { allowHttpLoopback: true },
			openUrl: server ? server.browser : async () => {},
			// Generous, so that a busy PC does not turn a slow fake browser into a timeout.
			callbackTimeoutMs: 15_000,
			...options.context,
		},
	});
	return { runtime, captured };
}

/** A valid login.json record for `base` (the fake server's URL), for tests that start from a saved login. */
export function sampleRecord(
	base: string,
	session: Partial<LoginSession> | null = {},
	client: Partial<LoginClient> = {},
): LoginRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		adminUrl: base,
		resource: `${base}/`,
		endpoints: {
			authorization: `${base}/oauth/authorize`,
			token: `${base}/oauth/token`,
			revocation: `${base}/cdn-cgi/access/oauth/revoke`,
			registration: `${base}/oauth/register`,
		},
		client: { clientId: "client-sample", registeredAt: now, ...client },
		session:
			session === null
				? null
				: {
						accessToken: "oauth:at-sample-access-token",
						accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
						refreshToken: "oauth:rt-sample-refresh-token",
						loggedInAt: now,
						refreshedAt: now,
						...session,
					},
	};
}
