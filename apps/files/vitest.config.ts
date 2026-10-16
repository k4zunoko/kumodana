import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The schema is owned by the admin Worker. The path is relative to this package (vitest runs here).
const migrations = await readD1Migrations("../admin/migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			experimental: { newConfig: true },
			miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
		}),
	],
	test: { setupFiles: ["./test/setup.ts"] },
});
