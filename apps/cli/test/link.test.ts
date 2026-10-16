import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkList, linkRevoke, tokenFromArgument } from "../src/commands/link.ts";
import { runCommand } from "../src/runtime.ts";
import { allOutput, mockApi, sendJson, testRuntime } from "./helpers.ts";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

function link(token: string, revokedAt: string | null = null) {
	return {
		token,
		fileId: "abcdefghjk",
		url: `https://kumo.example/${token}`,
		label: "Aさん",
		createdAt: "2026-10-15T00:00:00.000Z",
		revokedAt,
	};
}

let server: Awaited<ReturnType<typeof mockApi>>;
let requests: string[] = [];
let purgeOk = true;

beforeEach(async () => {
	requests = [];
	purgeOk = true;
	server = await mockApi((req, _body, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		requests.push(`${req.method} ${url.pathname}${url.search}`);
		if (req.method === "GET" && url.pathname === "/api/links") {
			return sendJson(res, 200, { links: [link(TOKEN), link("x".repeat(22), "2026-10-15T01:00:00.000Z")] });
		}
		if (req.method === "DELETE" && url.pathname === `/api/links/${TOKEN}`) {
			return sendJson(res, 200, {
				link: link(TOKEN, "2026-10-15T02:00:00.000Z"),
				purge: purgeOk ? { ok: true } : { ok: false, error: "429: rate limited" },
			});
		}
		sendJson(res, 404, { error: { code: "not_found", message: "見つかりません。" } });
	});
});

afterEach(() => server.close());

describe("tokenFromArgument", () => {
	it("accepts a token or a link URL", () => {
		expect(tokenFromArgument(TOKEN)).toBe(TOKEN);
		expect(tokenFromArgument(`https://kumo.meshnode.workers.dev/${TOKEN}`)).toBe(TOKEN);
		expect(tokenFromArgument(`https://kumo.meshnode.workers.dev/${TOKEN}?fbclid=1`)).toBe(TOKEN);
		expect(tokenFromArgument("nope")).toBeUndefined();
	});
});

describe("kumo link ls", () => {
	it("asks for active links unless --all, and filters by file", async () => {
		const { runtime, captured } = testRuntime(server.url);
		await linkList(runtime, undefined, {});
		await linkList(runtime, "abcdefghjk", { all: true });
		expect(requests).toEqual(["GET /api/links?includeRevoked=false", "GET /api/links?fileId=abcdefghjk&includeRevoked=true"]);
		const out = allOutput(captured);
		expect(out).toContain(`https://kumo.example/${TOKEN}`);
		expect(out).toContain("Aさん");
		expect(out).toContain("取り消し済み");
	});
});

describe("kumo link revoke", () => {
	it("revokes by URL", async () => {
		const { runtime } = testRuntime(server.url);
		expect(await linkRevoke(runtime, `https://kumo.example/${TOKEN}`)).toBe(0);
		expect(requests).toEqual([`DELETE /api/links/${TOKEN}`]);
	});

	it("exits with 1 and explains how to retry when the purge fails", async () => {
		purgeOk = false;
		const { runtime, captured } = testRuntime(server.url);
		expect(await linkRevoke(runtime, TOKEN)).toBe(1);
		const out = allOutput(captured);
		expect(out).toContain("同じコマンド");
		expect(out).toContain("1 時間");
	});

	it("rejects arguments that are not a token or link URL with exit code 2", async () => {
		const { runtime } = testRuntime(server.url);
		expect(await runCommand(runtime, () => linkRevoke(runtime, "nope"))).toBe(2);
		expect(requests).toEqual([]);
	});
});
