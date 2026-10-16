import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * Delivery Worker (kumo). Serves shared files to viewers through Workers Cache.
 * Emergency stop: `cf workers triggers deploy --mode stopped` turns off the workers.dev route.
 */
export default defineConfig(({ mode }) => ({
	worker: {
		name: "kumo",
		compatibilityDate: "2026-10-06",
		entrypoint,
		workersDev: mode !== "stopped",
		previewUrls: false,
		cache: { enabled: true },
		env: {
			DB: bindings.d1({ name: "kumodana", id: "862268f4-6ad2-4b54-9690-2b5b6c5d8ec7" }),
			BUCKET: bindings.r2({ name: "kumodana" }),
		},
	},
}));
