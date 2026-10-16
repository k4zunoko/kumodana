import { createApp } from "./app.ts";
import { remoteKeys } from "./auth.ts";
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
	async scheduled() {},
} satisfies ExportedHandler<Env>;
