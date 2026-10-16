import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ApiError } from "./errors.ts";

export type Principal = { kind: "owner"; email: string } | { kind: "cli"; clientId: string };

/** Returns the key resolver for an Access team domain. Injectable for tests. */
export type KeyResolverFactory = (teamDomain: string) => JWTVerifyGetKey;

const remoteResolvers = new Map<string, JWTVerifyGetKey>();

/** Production key resolver: the team's public keys, reused for the life of the isolate. */
export const remoteKeys: KeyResolverFactory = (teamDomain) => {
	let resolver = remoteResolvers.get(teamDomain);
	if (!resolver) {
		resolver = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
		remoteResolvers.set(teamDomain, resolver);
	}
	return resolver;
};

export type AuthConfig = {
	teamDomain: string;
	audience: string;
	ownerEmail: string;
	cliClientId: string;
};

export function authConfigFromEnv(env: Env): AuthConfig {
	return {
		teamDomain: String(env.ACCESS_TEAM_DOMAIN).replace(/\/+$/, ""),
		audience: String(env.ACCESS_AUD),
		ownerEmail: String(env.OWNER_EMAIL).toLowerCase(),
		cliClientId: String(env.CLI_CLIENT_ID),
	};
}

/**
 * Verifies the Cloudflare Access JWT (research R3). Access already checked the request at the edge;
 * this second check keeps the API closed even if Access is misconfigured.
 */
export async function authenticate(
	request: Request,
	config: AuthConfig,
	keys: KeyResolverFactory,
): Promise<Principal> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) throw new ApiError(401, "unauthenticated");

	let payload: Record<string, unknown>;
	try {
		const result = await jwtVerify(token, keys(config.teamDomain), {
			algorithms: ["RS256"],
			issuer: config.teamDomain,
			audience: config.audience,
		});
		payload = result.payload as Record<string, unknown>;
	} catch {
		throw new ApiError(401, "unauthenticated");
	}

	const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
	if (email && email === config.ownerEmail) return { kind: "owner", email };

	const commonName = typeof payload.common_name === "string" ? payload.common_name : undefined;
	if (!email && commonName && commonName === config.cliClientId) return { kind: "cli", clientId: commonName };

	throw new ApiError(403, "forbidden");
}
