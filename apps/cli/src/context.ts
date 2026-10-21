import type { Server } from "node:http";
import { type UrlOpener, openUrl } from "./browser.ts";
import type { LoginFs } from "./login-store.ts";

export type Env = Record<string, string | undefined>;

/**
 * Which URLs the login code accepts (specs/003-cli-login data-model「URL の検証」). Production accepts `https:` only.
 * Tests run a fake authorization server on `http://127.0.0.1` and pass `allowHttpLoopback: true` through
 * `createRuntime`; no environment variable or argument can turn it on.
 */
export type UrlPolicy = { allowHttpLoopback: boolean };

export const HTTPS_ONLY: UrlPolicy = { allowHttpLoopback: false };

/** Starts listening on 127.0.0.1 and returns the port. Replaceable so that tests can make it fail. */
export type Listen = (server: Server) => Promise<number>;

/** What the login code needs from the outside world. Every field can be replaced in tests. */
export type CliContext = {
	env: Env;
	platform: string;
	fetchImpl: typeof fetch;
	now: () => Date;
	urls: UrlPolicy;
	openUrl: UrlOpener;
	/** How long `kumo login` waits for the browser (5 minutes, research L6). */
	callbackTimeoutMs: number;
	listen?: Listen;
	/** The file operations for login.json (tests make them fail). */
	loginFs?: LoginFs;
};

export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function createContext(overrides: Partial<CliContext> = {}): CliContext {
	return {
		env: process.env,
		platform: process.platform,
		fetchImpl: (input, init) => fetch(input, init),
		now: () => new Date(),
		urls: HTTPS_ONLY,
		openUrl,
		callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
		...overrides,
	};
}
