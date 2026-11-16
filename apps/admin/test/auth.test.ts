import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { authConfigFromEnv, authenticate } from "../src/auth.ts";
import { AGENT_ID, AUD, call, CLI_ID, env, OWNER, signAccessJwt, TEAM, testApp, testKeys } from "./helpers.ts";

const app = testApp();

async function status(jwt: string | null): Promise<number> {
	const res = await call(app, "GET", "/api/whoami-does-not-exist", { jwt });
	return res.status;
}

/** Status for a service-token JWT with this common_name, optionally with some bindings replaced. */
async function statusAs(commonName: string, bindings?: { AGENT_CLIENT_ID: string | undefined }): Promise<number> {
	const jwt = await signAccessJwt({ common_name: commonName });
	const res = await call(app, "GET", "/api/whoami-does-not-exist", { jwt, env: bindings });
	return res.status;
}

describe("Access JWT verification", () => {
	it("rejects a missing JWT with 401", async () => {
		const res = await call(app, "GET", "/api/anything", { jwt: null });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
	});

	it("rejects a JWT signed with another key", async () => {
		const other = await generateKeyPair("RS256");
		expect(await status(await signAccessJwt({ common_name: CLI_ID }, other.privateKey))).toBe(401);
	});

	it("rejects a wrong audience", async () => {
		expect(await status(await signAccessJwt({ common_name: CLI_ID, aud: "other-app" }))).toBe(401);
	});

	it("rejects a wrong issuer", async () => {
		expect(await status(await signAccessJwt({ common_name: CLI_ID, iss: "https://evil.cloudflareaccess.com" }))).toBe(401);
	});

	it("rejects an expired JWT", async () => {
		expect(await status(await signAccessJwt({ common_name: CLI_ID, expiresIn: Math.floor(Date.now() / 1000) - 60 }))).toBe(401);
	});

	it("rejects other principals with 403", async () => {
		const res = await call(app, "GET", "/api/x", { jwt: await signAccessJwt({ email: "someone@example.com" }) });
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
		expect(await status(await signAccessJwt({ common_name: "other-client.access" }))).toBe(403);
	});

	it("accepts the owner email and the CLI client ID", async () => {
		// Authenticated requests reach routing; an unknown route then answers 404.
		expect(await status(await signAccessJwt({ email: OWNER.toUpperCase() }))).toBe(404);
		expect(await status(await signAccessJwt({ common_name: CLI_ID }))).toBe(404);
	});

	it("uses the configured team and audience", () => {
		expect(TEAM).toMatch(/^https:\/\//);
		expect(AUD).not.toBe("");
	});
});

describe("agent service token (specs/004-agent-service-token)", () => {
	it("accepts the agent client ID as the cli principal, like the CLI client ID", async () => {
		expect(AGENT_ID).not.toBe(CLI_ID);
		expect(await statusAs(AGENT_ID)).toBe(404);
		expect(await statusAs(CLI_ID)).toBe(404);

		const request = new Request("https://admin.test/api/usage", {
			headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt({ common_name: AGENT_ID }) },
		});
		expect(await authenticate(request, authConfigFromEnv(env), testKeys)).toEqual({ kind: "cli", clientId: AGENT_ID });
	});

	it("still rejects other client IDs and an agent JWT that carries an email", async () => {
		expect(await statusAs("other-client.access")).toBe(403);
		expect(await status(await signAccessJwt({ common_name: AGENT_ID, email: "someone@example.com" }))).toBe(403);
	});

	it("accepts only the CLI client ID when AGENT_CLIENT_ID is empty or unset", async () => {
		for (const agentClientId of ["", undefined]) {
			const bindings = { AGENT_CLIENT_ID: agentClientId };
			expect(authConfigFromEnv({ ...env, ...bindings } as Env).cliClientIds).toEqual([CLI_ID]);
			expect(await statusAs(AGENT_ID, bindings)).toBe(403);
			expect(await statusAs("other-client.access", bindings)).toBe(403);
			expect(await statusAs("undefined", bindings)).toBe(403);
			expect(await statusAs(CLI_ID, bindings)).toBe(404);
		}
	});
});
