import { createApp } from "./app.ts";
import { remoteKeys } from "./auth.ts";
import { routes } from "./routes/index.ts";

const app = createApp(
	{
		keys: remoteKeys,
		purge: async () => ({ ok: false, error: "not_implemented" }),
		now: () => Date.now(),
	},
	routes,
);

export default {
	fetch: app.fetch,
	async scheduled() {},
} satisfies ExportedHandler<Env>;
