import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HEADER_CLIENT, HEADER_CLIENT_VALUE } from "@kumodana/shared/api-types";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { createApp, type Deps } from "../src/app.ts";
import { routes } from "../src/routes/index.ts";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
const localKeys = createLocalJWKSet({ keys: [jwk] });

export const TEAM = String(env.ACCESS_TEAM_DOMAIN);
export const AUD = String(env.ACCESS_AUD);
export const OWNER = String(env.OWNER_EMAIL);
export const CLI_ID = String(env.CLI_CLIENT_ID);

type Claims = { email?: string; common_name?: string; aud?: string; iss?: string; expiresIn?: string | number };

/** Signs a JWT shaped like the one Cloudflare Access adds as Cf-Access-Jwt-Assertion. */
export async function signAccessJwt(claims: Claims = { common_name: CLI_ID }, key = privateKey): Promise<string> {
	const { aud = AUD, iss = TEAM, expiresIn = "5m", ...rest } = claims;
	return new SignJWT(rest)
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuedAt()
		.setIssuer(iss)
		.setAudience(aud)
		.setExpirationTime(expiresIn)
		.sign(key);
}

export function testApp(overrides: Partial<Deps> = {}) {
	return createApp(
		{
			keys: () => localKeys,
			purge: async () => ({ ok: true }),
			now: () => Date.now(),
			...overrides,
		},
		routes,
	);
}

type CallOptions = {
	headers?: Record<string, string>;
	body?: BodyInit | null;
	json?: unknown;
	jwt?: string | null;
	client?: boolean;
};

/** Calls the admin app like the CLI would (client header + CLI service-token JWT) unless overridden. */
export async function call(
	app: ReturnType<typeof testApp>,
	method: string,
	path: string,
	options: CallOptions = {},
): Promise<Response> {
	const headers = new Headers(options.headers);
	if (options.client !== false) headers.set(HEADER_CLIENT, HEADER_CLIENT_VALUE);
	const jwt = options.jwt === undefined ? await signAccessJwt() : options.jwt;
	if (jwt !== null) headers.set("Cf-Access-Jwt-Assertion", jwt);
	let body = options.body ?? null;
	if (options.json !== undefined) {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(options.json);
	}
	const ctx = createExecutionContext();
	const response = await app.fetch(new Request(`https://admin.test${path}`, { method, headers, body }), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** Empties D1 and R2 between tests. */
export async function resetStorage(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM links"),
		env.DB.prepare("DELETE FROM file_tags"),
		env.DB.prepare("DELETE FROM files"),
	]);
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ cursor });
		if (listed.objects.length > 0) await env.BUCKET.delete(listed.objects.map((o) => o.key));
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

type SeedFile = {
	id: string;
	name?: string;
	contentType?: string;
	body?: string;
	sha256?: string;
	status?: "pending" | "ready" | "deleting";
	createdAt?: number;
	updatedAt?: number;
	tags?: string[];
	withObject?: boolean;
};

/** Inserts a file row directly (any status and timestamps) and, by default, its R2 object. */
export async function seedFile(file: SeedFile): Promise<void> {
	const body = file.body ?? `content-${file.id}`;
	const sha256 = file.sha256 ?? (await sha256Hex(body));
	const createdAt = file.createdAt ?? Date.now();
	await env.DB.prepare(
		`INSERT INTO files (id, r2_key, name, content_type, size, sha256, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			file.id,
			`files/${file.id}`,
			file.name ?? `${file.id}.png`,
			file.contentType ?? "image/png",
			new TextEncoder().encode(body).length,
			sha256,
			file.status ?? "ready",
			createdAt,
			file.updatedAt ?? createdAt,
		)
		.run();
	for (const tag of file.tags ?? []) {
		await env.DB.prepare("INSERT INTO file_tags (file_id, tag) VALUES (?, ?)").bind(file.id, tag).run();
	}
	if (file.withObject !== false) await env.BUCKET.put(`files/${file.id}`, body);
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { env };
