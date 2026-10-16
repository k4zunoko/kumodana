import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { AUD, call, CLI_ID, OWNER, signAccessJwt, TEAM, testApp } from "./helpers.ts";

const app = testApp();

async function status(jwt: string | null): Promise<number> {
	const res = await call(app, "GET", "/api/whoami-does-not-exist", { jwt });
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
