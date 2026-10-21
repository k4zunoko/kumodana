import { randomBytes } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UrlPolicy } from "./context.ts";
import { CliError, EXIT_FAILED, EXIT_USAGE } from "./errors.ts";

/** specs/003-cli-login data-model `login.json`. */
export type LoginEndpoints = { authorization: string; token: string; revocation: string; registration: string };
export type LoginClient = { clientId: string; registeredAt: string };
export type LoginSession = {
	accessToken: string;
	accessTokenExpiresAt: string;
	refreshToken: string;
	loggedInAt: string;
	refreshedAt?: string;
};
export type LoginRecord = {
	version: 1;
	adminUrl: string;
	resource: string;
	endpoints: LoginEndpoints;
	client: LoginClient;
	session: LoginSession | null;
};

export const LOGIN_VERSION = 1;

/** The file operations the store uses. Replaceable so that tests can make them fail. */
export type LoginFs = {
	readFile: (path: string, encoding: "utf8") => Promise<string>;
	writeFile: (path: string, data: string, options: { mode: number; flag: string }) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
	mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
};

const nodeFs: LoginFs = {
	readFile: (path, encoding) => fsPromises.readFile(path, encoding),
	writeFile: (path, data, options) => fsPromises.writeFile(path, data, options),
	rename: (from, to) => fsPromises.rename(from, to),
	unlink: (path) => fsPromises.unlink(path),
	mkdir: (path, options) => fsPromises.mkdir(path, options),
};

/** Errors that mean "another process has the file open" on Windows (research L9). */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_DELAYS_MS = [50, 100, 200];

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			const delay = RETRY_DELAYS_MS[attempt];
			if (!BUSY.has(code) || delay === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Parses a URL the login code may contact: `https:` only, or loopback `http:` when the policy allows it (tests). */
export function allowedUrl(value: unknown, policy: UrlPolicy): URL | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username || url.password) return undefined;
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && policy.allowHttpLoopback && isLoopback(url.hostname)) return url;
	return undefined;
}

/** Normalizes an admin API URL: an allowed origin with no path, query, or fragment. */
export function normalizeAdminUrl(value: string, policy: UrlPolicy): string | undefined {
	const url = allowedUrl(value.trim(), policy);
	if (!url || url.search || url.hash || url.pathname !== "/") return undefined;
	return url.origin;
}

/** Compares admin API URLs the way the service-token path always has: without trailing slashes. */
export function sameAdminUrl(a: string, b: string): boolean {
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function invalid(path: string, field: string): CliError {
	return new CliError(`ログインの記録の形式が正しくありません（${field}）: ${path}`, {
		code: "login_invalid",
		hint: "`kumo login` でログインし直してください（壊れた記録は作り直されます）。",
		exitCode: EXIT_USAGE,
	});
}

function isText(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isTime(value: unknown): value is string {
	return isText(value) && !Number.isNaN(Date.parse(value));
}

/** Validates the record (data-model「読み込みの検証」). Error messages name the field, never a value. */
export function parseLogin(text: string, path: string, policy: UrlPolicy): LoginRecord {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw invalid(path, "JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid(path, "JSON");
	const record = data as Record<string, unknown>;
	if (record.version !== LOGIN_VERSION) throw invalid(path, "version");
	if (typeof record.adminUrl !== "string" || normalizeAdminUrl(record.adminUrl, policy) !== record.adminUrl) {
		throw invalid(path, "adminUrl");
	}
	if (!allowedUrl(record.resource, policy)) throw invalid(path, "resource");

	const endpoints = record.endpoints as Record<string, unknown> | null | undefined;
	if (!endpoints || typeof endpoints !== "object") throw invalid(path, "endpoints");
	for (const key of ["authorization", "token", "revocation", "registration"]) {
		if (!allowedUrl(endpoints[key], policy)) throw invalid(path, `endpoints.${key}`);
	}

	const client = record.client as Record<string, unknown> | null | undefined;
	if (!client || typeof client !== "object") throw invalid(path, "client");
	if (!isText(client.clientId)) throw invalid(path, "client.clientId");
	if (!isTime(client.registeredAt)) throw invalid(path, "client.registeredAt");

	const session = record.session;
	if (session !== null) {
		if (!session || typeof session !== "object" || Array.isArray(session)) throw invalid(path, "session");
		const s = session as Record<string, unknown>;
		if (!isText(s.accessToken)) throw invalid(path, "session.accessToken");
		if (!isText(s.refreshToken)) throw invalid(path, "session.refreshToken");
		if (!isTime(s.accessTokenExpiresAt)) throw invalid(path, "session.accessTokenExpiresAt");
		if (!isTime(s.loggedInAt)) throw invalid(path, "session.loggedInAt");
		if (s.refreshedAt !== undefined && typeof s.refreshedAt !== "string") throw invalid(path, "session.refreshedAt");
	}

	return {
		version: LOGIN_VERSION,
		adminUrl: record.adminUrl,
		resource: record.resource as string,
		endpoints: {
			authorization: endpoints.authorization as string,
			token: endpoints.token as string,
			revocation: endpoints.revocation as string,
			registration: endpoints.registration as string,
		},
		client: { clientId: client.clientId, registeredAt: client.registeredAt },
		session: session === null ? null : (session as LoginSession),
	};
}

/**
 * Reads login.json. Returns `undefined` when there is none. Busy errors are retried; if they persist the result is
 * `login_read_failed`. Only a malformed record is `login_invalid` (research L9).
 */
export async function readLogin(path: string, policy: UrlPolicy, fs: LoginFs = nodeFs): Promise<LoginRecord | undefined> {
	let text: string;
	try {
		text = await withRetry(() => fs.readFile(path, "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return undefined;
		throw new CliError(`ログインの記録を読めませんでした（${code ?? "不明なエラー"}）: ${path}`, {
			code: "login_read_failed",
			hint: "ほかの kumo が書き換えている最中かもしれません。時間をおいて再実行してください。",
			exitCode: EXIT_FAILED,
		});
	}
	return parseLogin(text, path, policy);
}

/**
 * Writes login.json through a temporary file in the same folder and a rename, so the file is always either the old
 * or the new content. Outside Windows the file is 600 and a new folder 700. Throws `login_write_failed`.
 */
export async function writeLogin(path: string, record: LoginRecord, fs: LoginFs = nodeFs): Promise<void> {
	const dir = dirname(path);
	const temp = join(dir, `login.json.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await withRetry(() => fs.rename(temp, path));
	} catch (error) {
		await fs.unlink(temp).catch(() => undefined);
		const code = (error as NodeJS.ErrnoException).code;
		throw new CliError(`ログインの記録を保存できませんでした（${code ?? "不明なエラー"}）: ${path}`, {
			code: "login_write_failed",
			exitCode: EXIT_FAILED,
		});
	}
}
