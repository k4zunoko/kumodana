import type { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getUsage } from "../db/usage.ts";
import { storageLimit } from "./files.ts";

export function usageRoutes(app: Hono<AppEnv>): void {
	app.get("/api/usage", async (c) => c.json(await getUsage(c.env.DB, storageLimit(c.env))));
}
