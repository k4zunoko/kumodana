import { type CliConfig, collectConfig, configFilePath, loginFilePath, readConfigFile } from "./config.ts";
import type { CliContext, Env } from "./context.ts";
import { CliError } from "./errors.ts";
import { type LoginRecord, type LoginSession, readLogin, writeLogin } from "./login-store.ts";
import { OAuthError, refreshTokens } from "./oauth.ts";
import { type Output, printWarning } from "./output.ts";

/** How the CLI reaches the admin API (specs/003-cli-login research L10, contracts/cli.md「設定」). */
export type Method = "env_service_token" | "login" | "config_service_token" | "none";

export type Resolved = {
	method: Method;
	configPath: string;
	loginPath: string;
	/** For the two service-token methods: the combined values and the names of missing keys. */
	serviceToken?: { values: Partial<CliConfig>; missing: string[] };
	/** The login record when it was read (always, for `login`). */
	login?: LoginRecord;
};

function present(value: unknown): boolean {
	return typeof value === "string" && value.trim() !== "";
}

/** `KUMODANA_CLIENT_ID` or `KUMODANA_CLIENT_SECRET` set: the pre-003 path wins (FR-009). */
export function hasEnvServiceToken(env: Env): boolean {
	return present(env.KUMODANA_CLIENT_ID) || present(env.KUMODANA_CLIENT_SECRET);
}

export function hasConfigServiceToken(file: Record<string, unknown>): boolean {
	return present(file.clientId) || present(file.clientSecret);
}

/**
 * Decides the method from the conditions only; missing values do not fail here (review item 1). Management
 * operations turn missing service-token values into `config_missing`; `kumo login --status` lists them as notes.
 */
export async function resolveCredentials(ctx: CliContext, options: { readLogin?: boolean } = {}): Promise<Resolved> {
	const configPath = configFilePath(ctx.env, ctx.platform);
	const loginPath = loginFilePath(ctx.env, ctx.platform);
	const base = { configPath, loginPath };

	if (hasEnvServiceToken(ctx.env)) {
		const file = await readConfigFile(ctx.env, ctx.platform);
		const login = options.readLogin ? await readLogin(loginPath, ctx.urls) : undefined;
		return { ...base, method: "env_service_token", serviceToken: collectConfig(ctx.env, file), login };
	}
	const login = await readLogin(loginPath, ctx.urls);
	if (login?.session) return { ...base, method: "login", login };

	const file = await readConfigFile(ctx.env, ctx.platform);
	if (hasConfigServiceToken(file)) {
		return { ...base, method: "config_service_token", serviceToken: collectConfig(ctx.env, file), login };
	}
	return { ...base, method: "none", login };
}

/** Sends a request on behalf of the owner. `refresh` exists only for the login method. */
export interface Credentials {
	readonly kind: "service_token" | "login";
	headers(): Promise<Record<string, string>>;
	refresh?(): Promise<void>;
}

export class ServiceTokenCredentials implements Credentials {
	readonly kind = "service_token";
	readonly #clientId: string;
	readonly #clientSecret: string;

	constructor(config: Pick<CliConfig, "clientId" | "clientSecret">) {
		this.#clientId = config.clientId;
		this.#clientSecret = config.clientSecret;
	}

	async headers(): Promise<Record<string, string>> {
		return { "CF-Access-Client-Id": this.#clientId, "CF-Access-Client-Secret": this.#clientSecret };
	}
}

export function loginRequired(message = "ログインの期限が切れたか、取り消されました。"): CliError {
	return new CliError(message, { code: "login_required", hint: "`kumo login` を実行してください。" });
}

/** Refresh errors that mean the grant itself is gone (research L8). */
const GRANT_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;

type LoginSessionRecord = LoginRecord & { session: LoginSession };

/**
 * The login method: `Authorization: Bearer`, refreshed before expiry and once after a 401 (research L8).
 * Refreshed tokens are saved only if login.json still holds the same login (review item 4).
 */
export class LoginCredentials implements Credentials {
	readonly kind = "login";
	#record: LoginSessionRecord;
	#reloaded = false;
	readonly #path: string;
	readonly #ctx: CliContext;
	readonly #out: Output;

	constructor(record: LoginSessionRecord, path: string, ctx: CliContext, out: Output) {
		this.#record = record;
		this.#path = path;
		this.#ctx = ctx;
		this.#out = out;
		this.#hide(record.session);
	}

	get record(): LoginSessionRecord {
		return this.#record;
	}

	#hide(session: LoginSession): void {
		this.#out.secrets.push(session.accessToken, session.refreshToken);
	}

	#expiresSoon(session: LoginSession): boolean {
		return Date.parse(session.accessTokenExpiresAt) - this.#ctx.now().getTime() < REFRESH_MARGIN_MS;
	}

	async headers(): Promise<Record<string, string>> {
		if (this.#expiresSoon(this.#record.session)) await this.refresh();
		return { Authorization: `Bearer ${this.#record.session.accessToken}` };
	}

	async refresh(): Promise<void> {
		const { endpoints, client, resource, session } = this.#record;
		const used = session.refreshToken;
		let tokens: Awaited<ReturnType<typeof refreshTokens>>;
		try {
			tokens = await refreshTokens(
				endpoints.token,
				{ refreshToken: used, clientId: client.clientId, resource },
				this.#ctx.fetchImpl,
			);
		} catch (error) {
			if (error instanceof OAuthError && GRANT_ERRORS.has(error.error)) return this.#afterRejected(used);
			if (error instanceof OAuthError) {
				throw new CliError(error.message, {
					code: "refresh_failed",
					hint: "ログインの仕組み（Access）が一時的に使えない可能性があります。時間をおいて再実行してください。",
				});
			}
			throw error;
		}

		const now = this.#ctx.now();
		const next: LoginSession = {
			...session,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? used,
			accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000).toISOString(),
			refreshedAt: now.toISOString(),
		};
		this.#hide(next);
		this.#record = { ...this.#record, session: next };
		await this.#save();
	}

	/** Another kumo may have written a newer refresh token; use it once, otherwise ask for `kumo login`. */
	async #afterRejected(used: string): Promise<void> {
		if (this.#reloaded) throw loginRequired();
		this.#reloaded = true;
		const latest = await readLogin(this.#path, this.#ctx.urls).catch(() => undefined);
		const session = latest?.session;
		if (!latest || !session || latest.adminUrl !== this.#record.adminUrl || session.refreshToken === used) {
			throw loginRequired();
		}
		this.#hide(session);
		this.#record = { ...latest, session };
		if (this.#expiresSoon(session)) await this.refresh();
	}

	/** Writes only when login.json still holds this login; a newer login or a logout is never overwritten. */
	async #save(): Promise<void> {
		try {
			const latest = await readLogin(this.#path, this.#ctx.urls);
			const same =
				latest?.session &&
				latest.adminUrl === this.#record.adminUrl &&
				latest.session.loggedInAt === this.#record.session.loggedInAt;
			if (!latest || !same) return;
			await writeLogin(this.#path, { ...latest, session: this.#record.session });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			printWarning(this.#out, `ログインの記録を保存できませんでした（${reason}）。次の操作では前の記録で更新します。`);
		}
	}
}
