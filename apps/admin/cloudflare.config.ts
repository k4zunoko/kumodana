import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * Admin Worker (kumodana-admin). Protected by a Worker-level Cloudflare Access application.
 * Personal identifiers are uploaded as secrets with `cf deploy --secrets-file` (research R4).
 */
export default defineConfig(({ mode }) => {
	const isTest = mode === "test";
	return {
		worker: {
			name: "kumodana-admin",
			compatibilityDate: "2026-10-06",
			entrypoint,
			workersDev: true,
			previewUrls: false,
			// Cleanup of abandoned uploads and interrupted deletions (FR-008).
			triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
			env: {
				DB: bindings.d1({ name: "kumodana", id: "862268f4-6ad2-4b54-9690-2b5b6c5d8ec7" }),
				BUCKET: bindings.r2({ name: "kumodana" }),
				// The delivery Worker is not available in unit tests; purge.ts reports that case.
				...(isTest ? {} : { FILES: bindings.worker({ worker: "kumo" }) }),
				FILES_BASE_URL: bindings.text("https://kumo.meshnode.workers.dev"),
				STORAGE_LIMIT_BYTES: bindings.text(isTest ? "1000" : "8000000000"),
				OWNER_EMAIL: isTest ? bindings.text("owner@example.com") : bindings.secret(),
				CLI_CLIENT_ID: isTest ? bindings.text("cli-client-id.access") : bindings.secret(),
				ACCESS_TEAM_DOMAIN: isTest ? bindings.text("https://test-team.cloudflareaccess.com") : bindings.secret(),
				ACCESS_AUD: isTest ? bindings.text("test-aud") : bindings.secret(),
			},
		},
	};
});
