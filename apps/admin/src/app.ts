import type { PurgeResult } from "@kumodana/shared/api-types";
import { Hono } from "hono";
import { authConfigFromEnv, authenticate, type KeyResolverFactory, type Principal } from "./auth.ts";
import { assertNotCrossSite } from "./csrf.ts";
import { ApiError, errorResponse } from "./errors.ts";

/** Dependencies that differ between production and tests. */
export type Deps = {
	keys: KeyResolverFactory;
	purge: (env: Env, tags: string[]) => Promise<PurgeResult>;
	now: () => number;
};

export type AppEnv = {
	Bindings: Env;
	Variables: { principal: Principal; deps: Deps };
};

export type Route = (app: Hono<AppEnv>) => void;

/** Builds the admin API: CSRF check → Access JWT check → routes. */
export function createApp(deps: Deps, routes: Route[]): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use("*", async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "no-store");
		c.res.headers.set("X-Content-Type-Options", "nosniff");
		c.res.headers.set("Content-Security-Policy", "sandbox");
	});

	app.use("/api/*", async (c, next) => {
		assertNotCrossSite(c.req.raw);
		const principal = await authenticate(c.req.raw, authConfigFromEnv(c.env), deps.keys);
		c.set("principal", principal);
		c.set("deps", deps);
		await next();
	});

	for (const route of routes) route(app);

	app.notFound(() => errorResponse(new ApiError(404, "not_found")));
	app.onError((err) => {
		if (err instanceof ApiError) return errorResponse(err);
		console.error(err);
		return errorResponse(new ApiError(500, "internal_error"));
	});

	return app;
}
