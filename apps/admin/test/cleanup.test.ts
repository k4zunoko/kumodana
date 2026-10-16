import { beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cleanup.ts";
import { env, resetStorage, seedFile } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MINUTE = 60 * 1000;

async function ids(): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT id FROM files ORDER BY id").all<{ id: string }>();
	return results.map((r) => r.id);
}

beforeEach(resetStorage);

describe("cleanup", () => {
	it("removes stale pending (30 min) and deleting (15 min) files from R2 and D1", async () => {
		await seedFile({ id: "pendold001", status: "pending", updatedAt: NOW - 31 * MINUTE });
		await seedFile({ id: "pendnew001", status: "pending", updatedAt: NOW - 29 * MINUTE });
		await seedFile({ id: "deleold001", status: "deleting", updatedAt: NOW - 16 * MINUTE });
		await seedFile({ id: "delenew001", status: "deleting", updatedAt: NOW - 14 * MINUTE });
		await seedFile({ id: "ready00001", status: "ready", updatedAt: NOW - 1000 * MINUTE });

		await runCleanup(env, NOW);

		expect(await ids()).toEqual(["delenew001", "pendnew001", "ready00001"]);
		expect(await env.BUCKET.head("files/pendold001")).toBeNull();
		expect(await env.BUCKET.head("files/deleold001")).toBeNull();
		expect(await env.BUCKET.head("files/pendnew001")).not.toBeNull();
		expect(await env.BUCKET.head("files/ready00001")).not.toBeNull();
	});

	it("deletes the row even when the R2 object is already gone", async () => {
		await seedFile({ id: "pendold001", status: "pending", updatedAt: NOW - 60 * MINUTE, withObject: false });
		await runCleanup(env, NOW);
		expect(await ids()).toEqual([]);
	});
});
