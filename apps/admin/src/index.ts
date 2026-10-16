import { createApp } from "./app.ts";
import { remoteKeys } from "./auth.ts";
import { runCleanup } from "./cleanup.ts";
import { purgeViaBinding } from "./purge.ts";
import { routes } from "./routes/index.ts";

const app = createApp(
	{
		keys: remoteKeys,
		purge: purgeViaBinding,
		now: () => Date.now(),
	},
	routes,
);

export default {
	fetch: app.fetch,
	/** Every 15 minutes: remove abandoned uploads and interrupted deletions. */
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(runCleanup(env, Date.now()));
	},
} satisfies ExportedHandler<Env>;
