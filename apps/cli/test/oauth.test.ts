import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../src/errors.ts";
import {
	authorizationUrl,
	createPkce,
	createState,
	discover,
	exchangeCode,
	OAuthError,
	registerClient,
	revokeToken,
} from "../src/oauth.ts";
import { type AuthServer, mockAuthServer } from "./auth-server.ts";

const TEST_URLS = { allowHttpLoopback: true };
const fetchImpl: typeof fetch = (input, init) => fetch(input, init);

let server: AuthServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

async function errorOf(promise: Promise<unknown>): Promise<CliError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(CliError);
	return error as CliError;
}

describe("discovery (research L4)", () => {
	it("reads the resource and the four endpoints from the admin API's domain", async () => {
		server = await mockAuthServer();
		const found = await discover(server.url, fetchImpl, TEST_URLS);
		expect(found.resource).toBe(`${server.url}/`);
		expect(found.endpoints).toEqual({
			authorization: `${server.url}/oauth/authorize`,
			token: `${server.url}/oauth/token`,
			revocation: `${server.url}/cdn-cgi/access/oauth/revoke`,
			registration: `${server.url}/oauth/register`,
		});
	});

	it("does not check the issuer (Cloudflare gives it without https://, review item 12)", async () => {
		server = await mockAuthServer({ metadata: { issuer: "team.cloudflareaccess.example" } });
		await expect(discover(server.url, fetchImpl, TEST_URLS)).resolves.toBeDefined();
	});

	it.each([
		["no S256", { code_challenge_methods_supported: ["plain"] }],
		["an http endpoint", { token_endpoint: "http://token.example.invalid/t" }],
		["no registration endpoint", { registration_endpoint: undefined }],
	])("refuses metadata with %s as login_unavailable", async (_name, metadata) => {
		server = await mockAuthServer({ metadata });
		const error = await errorOf(discover(server.url, fetchImpl, TEST_URLS));
		expect(error.code).toBe("login_unavailable");
		expect(error.hint).toContain("Managed OAuth");
		expect(error.hint).toContain("サービストークン");
	});

	it("refuses a resource on another origin", async () => {
		server = await mockAuthServer({ resourceMetadata: { resource: "https://elsewhere.example.invalid/" } });
		expect((await errorOf(discover(server.url, fetchImpl, TEST_URLS))).code).toBe("login_unavailable");
	});

	it("refuses http endpoints in production even on loopback", async () => {
		server = await mockAuthServer();
		expect((await errorOf(discover(server.url, fetchImpl, { allowHttpLoopback: false }))).code).toBe("login_unavailable");
	});

	it("reports a redirect or a non-JSON answer (Managed OAuth off) as login_unavailable", async () => {
		const redirecting: typeof fetch = async () =>
			new Response(null, { status: 302, headers: { Location: "https://team.example.invalid/login" } });
		expect((await errorOf(discover("https://admin.example.invalid", redirecting, TEST_URLS))).code).toBe("login_unavailable");
		const html: typeof fetch = async () => new Response("<html></html>", { status: 200 });
		expect((await errorOf(discover("https://admin.example.invalid", html, TEST_URLS))).code).toBe("login_unavailable");
	});
});

describe("registration, PKCE, and the authorization URL (research L5・L6)", () => {
	it("registers a public client for the loopback redirect URI", async () => {
		server = await mockAuthServer();
		const clientId = await registerClient(`${server.url}/oauth/register`, "http://127.0.0.1:5555/callback", fetchImpl);
		expect(clientId).toMatch(/^client-/);
		expect(server.registrations[0]).toEqual({
			client_name: "kumo CLI",
			redirect_uris: ["http://127.0.0.1:5555/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
	});

	it("makes a 43-character verifier and an S256 challenge that starts with a letter or digit", () => {
		for (let i = 0; i < 200; i++) {
			const { verifier, challenge } = createPkce();
			expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
			expect(challenge).toMatch(/^[A-Za-z0-9]/);
		}
	});

	it("regenerates when the challenge would start with - or _", () => {
		// Find a seed whose challenge starts with a symbol, then make sure createPkce skips it.
		let calls = 0;
		const seeds: Uint8Array[] = [];
		for (let i = 0; seeds.length === 0; i++) {
			const bytes = new Uint8Array(32).fill(0);
			new DataView(bytes.buffer).setUint32(0, i);
			const verifier = Buffer.from(bytes).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (/^[-_]/.test(challenge)) seeds.push(bytes);
		}
		const good = new Uint8Array(32).fill(7);
		const { verifier } = createPkce(() => (calls++ === 0 ? (seeds[0] as Uint8Array) : good));
		expect(calls).toBe(2);
		expect(verifier).toBe(Buffer.from(good).toString("base64url"));
	});

	it("makes a random 43-character state", () => {
		const a = createState();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createState()).not.toBe(a);
	});

	it("builds the authorization URL with PKCE, state, and resource, and without scope", () => {
		const url = new URL(
			authorizationUrl("https://team.example.invalid/authorize", {
				clientId: "client-1",
				redirectUri: "http://127.0.0.1:5555/callback",
				state: "state-1",
				challenge: "challenge-1",
				resource: "https://admin.example.invalid/",
			}),
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			response_type: "code",
			client_id: "client-1",
			redirect_uri: "http://127.0.0.1:5555/callback",
			state: "state-1",
			code_challenge: "challenge-1",
			code_challenge_method: "S256",
			resource: "https://admin.example.invalid/",
		});
	});
});

describe("token requests (research L8・L12)", () => {
	it("does not follow redirects, so a refresh token cannot be sent elsewhere", async () => {
		let followed = false;
		const redirecting: typeof fetch = async (_input, init) => {
			expect(init?.redirect).toBe("error");
			followed = true;
			throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
		};
		const error = await errorOf(revokeToken("https://team.example.invalid/revoke", { token: "t", clientId: "c" }, redirecting));
		expect(followed).toBe(true);
		expect(error.code).toBe("network_error");
	});

	it("reports only error and error_description from a failed exchange", async () => {
		const failing: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad\u001b[31m code", extra: "x" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		const error = await errorOf(
			exchangeCode("https://t.example.invalid/token", { code: "code-secret", redirectUri: "r", clientId: "c", verifier: "verifier-secret", resource: "x" }, failing),
		);
		expect(error).toBeInstanceOf(OAuthError);
		expect((error as OAuthError).error).toBe("invalid_grant");
		expect(error.message).toContain("bad");
		expect(error.message).not.toContain("\u001b");
		expect(error.message).not.toContain("code-secret");
		expect(error.message).not.toContain("verifier-secret");
	});

	it("refuses a token response that is not a bearer token", async () => {
		const odd: typeof fetch = async () =>
			new Response(JSON.stringify({ access_token: "x", token_type: "mac" }), { status: 200 });
		const error = await errorOf(
			exchangeCode("https://t.example.invalid/token", { code: "c", redirectUri: "r", clientId: "c", verifier: "v", resource: "x" }, odd),
		);
		expect(error.code).toBe("login_failed");
	});
});
