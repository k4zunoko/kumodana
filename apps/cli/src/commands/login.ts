import type { Usage } from "@kumodana/shared/api-types";
import type { Command } from "commander";
import { AdminApi } from "../api.ts";
import { loginFilePath, readConfigFile } from "../config.ts";
import { hasConfigServiceToken, hasEnvServiceToken, LoginCredentials, type Method, resolveCredentials } from "../credentials.ts";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { type LoginClient, type LoginRecord, normalizeAdminUrl, readLogin, sameAdminUrl, writeLogin } from "../login-store.ts";
import { startCallbackServer } from "../loopback.ts";
import {
	authorizationUrl,
	createPkce,
	createState,
	type Discovery,
	discover,
	exchangeCode,
	OAuthError,
	registerClient,
	revokeToken,
	type TokenSet,
} from "../oauth.ts";
import { formatBytes, printResult, printWarning } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

export type LoginOptions = {
	/** `--no-open` sets this to false. */
	open?: boolean;
	status?: boolean;
};

const METHOD_LABELS: Record<Method, string> = {
	login: "ログイン（login.json）",
	env_service_token: "サービストークン（環境変数）",
	config_service_token: "サービストークン（config.json）",
	none: "なし",
};

/** Dates as `kumo ls` and `kumo link ls` show them. */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function usageLine(usage: Usage): string {
	const percent = usage.limitBytes > 0 ? ((usage.usedBytes / usage.limitBytes) * 100).toFixed(1) : "0";
	return `使用量: ${formatBytes(usage.usedBytes)} / ${formatBytes(usage.limitBytes)}（${percent}%）`;
}

async function readConfigQuietly(runtime: Runtime): Promise<Record<string, unknown>> {
	return readConfigFile(runtime.ctx.env, runtime.ctx.platform).catch(() => ({}));
}

/** Picks the admin API URL: argument → KUMODANA_ADMIN_URL → login.json → config.json (research L10). */
function chooseAdminUrl(runtime: Runtime, argument: string | undefined, previous: LoginRecord | undefined, file: Record<string, unknown>): string {
	const candidates = [
		argument,
		runtime.ctx.env.KUMODANA_ADMIN_URL,
		previous?.adminUrl,
		typeof file.adminUrl === "string" ? file.adminUrl : undefined,
	];
	const raw = candidates.find((value) => typeof value === "string" && value.trim() !== "");
	if (!raw) {
		throw new CliError("管理 API の URL がわかりません。", {
			code: "invalid_argument",
			hint: "kumo login https://kumodana-admin.<subdomain>.workers.dev のように、管理用 Worker の URL を指定してください。",
			exitCode: EXIT_USAGE,
		});
	}
	const url = normalizeAdminUrl(raw, runtime.ctx.urls);
	if (!url) {
		throw new CliError(`管理 API の URL として使えません: ${raw.trim()}`, {
			code: "invalid_argument",
			hint: "https: で始まり、パスやクエリのない URL（管理用 Worker の URL）を指定してください。",
			exitCode: EXIT_USAGE,
		});
	}
	return url;
}

type Obtained = { tokens: TokenSet & { refreshToken: string }; client: LoginClient };

/**
 * One browser round trip: listen, register if needed, open the browser, wait, exchange. Listening comes before
 * registration because the registration needs the redirect URI (review item 2).
 */
async function obtainTokens(
	runtime: Runtime,
	adminUrl: string,
	discovery: Discovery,
	previous: LoginRecord | undefined,
	options: LoginOptions,
): Promise<Obtained> {
	const { ctx, out } = runtime;
	const path = loginFilePath(ctx.env, ctx.platform);
	let forceRegister = false;
	for (let attempt = 0; ; attempt++) {
		const state = createState();
		const server = await startCallbackServer(state, ctx.listen);
		try {
			let client = !forceRegister && previous && previous.adminUrl === adminUrl ? previous.client : undefined;
			const registeredNow = !client;
			if (!client) {
				const clientId = await registerClient(discovery.endpoints.registration, server.redirectUri, ctx.fetchImpl);
				client = { clientId, registeredAt: ctx.now().toISOString() };
				// Without a session there is nothing to keep consistent: save at once, so a timeout does not cost another
				// registration that can never be deleted (research L5).
				if (!previous?.session) {
					await writeLogin(path, { version: 1, adminUrl, ...discovery, client, session: null });
				}
			}

			const pkce = createPkce();
			const url = authorizationUrl(discovery.endpoints.authorization, {
				clientId: client.clientId,
				redirectUri: server.redirectUri,
				state,
				challenge: pkce.challenge,
				resource: discovery.resource,
			});
			const minutes = Math.max(1, Math.round(ctx.callbackTimeoutMs / 60_000));
			out.stderr(
				`ブラウザでログインしてください。開かない場合は、次の URL をこの PC のブラウザで開いてください（${minutes} 分で時間切れになります）。`,
			);
			out.stderr(url);
			if (options.open !== false) {
				await ctx.openUrl(url).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					printWarning(out, `ブラウザを開けませんでした（${reason}）。上の URL を開いてください。`);
				});
			}

			const code = await server.waitForCode(ctx.callbackTimeoutMs);
			let tokens: TokenSet;
			try {
				tokens = await exchangeCode(
					discovery.endpoints.token,
					{ code, redirectUri: server.redirectUri, clientId: client.clientId, verifier: pkce.verifier, resource: discovery.resource },
					ctx.fetchImpl,
				);
			} catch (error) {
				if (error instanceof OAuthError && error.error === "invalid_client" && !registeredNow && attempt === 0) {
					printWarning(out, "この PC の登録が使えなくなっていたため、登録し直して、もう一度ログインします。");
					forceRegister = true;
					continue;
				}
				if (error instanceof OAuthError) {
					throw new CliError(error.message, {
						code: "login_failed",
						hint: "もう一度 kumo login を実行してください。",
					});
				}
				throw error;
			}
			if (!tokens.refreshToken) {
				throw new CliError("ログインの応答にリフレッシュトークンがありませんでした。", {
					code: "login_failed",
					hint: "管理用 Worker の Access の Managed OAuth の設定を確かめてください。",
				});
			}
			return { tokens: { ...tokens, refreshToken: tokens.refreshToken }, client };
		} finally {
			await server.close();
		}
	}
}

/** `kumo login [<adminUrl>] [--no-open]` (specs/003-cli-login contracts/cli.md). */
export async function login(runtime: Runtime, argument: string | undefined, options: LoginOptions): Promise<number> {
	if (options.status) {
		if (argument !== undefined || options.open === false) {
			throw new CliError("--status は、管理 API の URL や --no-open と一緒には使えません。", {
				code: "invalid_argument",
				exitCode: EXIT_USAGE,
			});
		}
		return status(runtime);
	}

	const { ctx, out } = runtime;
	const path = loginFilePath(ctx.env, ctx.platform);
	let previous: LoginRecord | undefined;
	try {
		previous = await readLogin(path, ctx.urls);
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== "login_invalid") throw error;
		printWarning(out, "ログインの記録が壊れているため、作り直します（この PC は登録し直します）。");
	}
	if (previous?.session) out.secrets.push(previous.session.accessToken, previous.session.refreshToken);

	const file = await readConfigQuietly(runtime);
	const adminUrl = chooseAdminUrl(runtime, argument, previous, file);
	const discovery = await discover(adminUrl, ctx.fetchImpl, ctx.urls);
	const { tokens, client } = await obtainTokens(runtime, adminUrl, discovery, previous, options);

	const now = ctx.now();
	const record: LoginRecord & { session: NonNullable<LoginRecord["session"]> } = {
		version: 1,
		adminUrl,
		resource: discovery.resource,
		endpoints: discovery.endpoints,
		client,
		session: {
			accessToken: tokens.accessToken,
			accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000).toISOString(),
			refreshToken: tokens.refreshToken,
			loggedInAt: now.toISOString(),
			refreshedAt: now.toISOString(),
		},
	};
	out.secrets.push(tokens.accessToken, tokens.refreshToken);
	await writeLogin(path, record);

	// Revoke the grant this login replaces, after the new one is saved (research L13).
	let revokedPrevious = false;
	if (previous?.session) {
		try {
			await revokeToken(
				previous.endpoints.revocation,
				{ token: previous.session.refreshToken, clientId: previous.client.clientId },
				ctx.fetchImpl,
			);
			revokedPrevious = true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			printWarning(out, `前のログインの許可を取り消せませんでした（${reason}）。許可の期間が切れるまで有効です。`);
		}
	}

	const credentials = new LoginCredentials(record, path, ctx, out);
	const api = new AdminApi({ adminUrl, credentials }, ctx.fetchImpl);
	let usage: Usage;
	try {
		usage = await api.request<Usage>("GET", "/api/usage");
	} catch (error) {
		if (revokedPrevious && error instanceof CliError && error.code === "login_required") {
			throw new CliError(
				"ログインは保存しましたが、管理 API で確かめられませんでした。前のログインの許可を取り消したことが、新しい許可にも効いた可能性があります。",
				{ code: "login_required", hint: "kumo logout の後に kumo login を実行してください。" },
			);
		}
		throw error;
	}

	warnAboutOtherCredentials(runtime, adminUrl, file);
	const saved = credentials.record.session;
	printResult(out, [`ログインしました: ${adminUrl}`, usageLine(usage)], {
		method: "login",
		adminUrl,
		loggedInAt: saved.loggedInAt,
		accessTokenExpiresAt: saved.accessTokenExpiresAt,
		usage,
	});
	return 0;
}

function warnAboutOtherCredentials(runtime: Runtime, adminUrl: string, file: Record<string, unknown>): void {
	const { ctx, out } = runtime;
	if (hasEnvServiceToken(ctx.env)) {
		printWarning(
			out,
			"環境変数 KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET があるため、管理操作ではそちらが使われます。ログインを使うには、これらの環境変数を削除してください。",
		);
	}
	const envUrl = ctx.env.KUMODANA_ADMIN_URL?.trim();
	if (envUrl && !sameAdminUrl(normalizeAdminUrl(envUrl, ctx.urls) ?? envUrl, adminUrl)) {
		printWarning(
			out,
			`KUMODANA_ADMIN_URL（${envUrl}）がログインした URL と違うため、管理操作は失敗します。KUMODANA_ADMIN_URL を削除するか、その URL でログインしてください。`,
		);
	}
	if (!hasEnvServiceToken(ctx.env) && hasConfigServiceToken(file)) {
		printWarning(out, "config.json の clientId・clientSecret は、ログインしている間は使われません（削除してかまいません）。");
	}
}

/** `kumo login --status`: which credentials the CLI uses, without any network access (FR-020). */
export async function status(runtime: Runtime): Promise<number> {
	const { ctx, out } = runtime;
	const resolved = await resolveCredentials(ctx, { readLogin: true });
	const file = await readConfigQuietly(runtime);
	const record = resolved.login;
	const notes: string[] = [];

	let adminUrl: string | null = null;
	if (resolved.method === "login" && record) {
		adminUrl = record.adminUrl;
		const envUrl = ctx.env.KUMODANA_ADMIN_URL?.trim();
		if (envUrl && !sameAdminUrl(normalizeAdminUrl(envUrl, ctx.urls) ?? envUrl, record.adminUrl)) {
			notes.push(`KUMODANA_ADMIN_URL（${envUrl}）がログインした URL と違うため、管理操作は失敗します（admin_url_mismatch）。`);
		}
		if (typeof file.adminUrl === "string" && file.adminUrl.trim() !== "" && !sameAdminUrl(file.adminUrl.trim(), record.adminUrl)) {
			notes.push(`config.json の adminUrl（${file.adminUrl.trim()}）は、ログインした URL と違います。ログインの経路では使いません。`);
		}
		if (hasConfigServiceToken(file)) notes.push("config.json の clientId・clientSecret は、ログインしている間は使われません。");
	} else if (resolved.serviceToken) {
		adminUrl = resolved.serviceToken.values.adminUrl ?? null;
		if (resolved.serviceToken.missing.length > 0) {
			notes.push(`足りない設定があります: ${resolved.serviceToken.missing.join("、")}。このままでは管理操作が失敗します（config_missing）。`);
		}
	}
	if (resolved.method !== "login" && record?.session) {
		notes.push(
			`ログインの記録（${record.adminUrl}、${formatDate(record.session.loggedInAt)} にログイン）がありますが、使われていません。`,
		);
	}

	const lines = [`方法: ${METHOD_LABELS[resolved.method]}`];
	if (adminUrl) lines.push(`管理 API: ${adminUrl}`);
	if (resolved.method === "login" && record?.session) {
		lines.push(`ログインした日時: ${formatDate(record.session.loggedInAt)}（許可は、ログインから Access で設定した期間で切れます）`);
		lines.push(
			`アクセストークンの期限: ${formatDate(record.session.accessTokenExpiresAt)}（期限が切れても、管理操作のときに自動で更新します）`,
		);
		lines.push("実際に使えるか（許可が切れていないか）は、kumo usage で確かめられます。");
	}
	if (resolved.method === "none") lines.push("kumo login <管理 API の URL> でログインしてください。");
	for (const note of notes) lines.push(`注意: ${note}`);

	const session = record?.session;
	printResult(out, lines, {
		method: resolved.method,
		adminUrl,
		login:
			record && session
				? {
						adminUrl: record.adminUrl,
						loggedInAt: session.loggedInAt,
						accessTokenExpiresAt: session.accessTokenExpiresAt,
						refreshedAt: session.refreshedAt ?? null,
					}
				: null,
		notes,
	});
	return 0;
}

export const registerLogin: Register = (program: Command, wrap) => {
	program
		.command("login")
		.description("ブラウザで所有者としてログインする（--status で今の状態を表示する）")
		.argument("[adminUrl]", "管理用 Worker の URL（省略すると KUMODANA_ADMIN_URL、前回の URL、config.json の順に使う）")
		.option("--no-open", "ブラウザを開かず、URL を表示して待つ")
		.option("--status", "ログインせずに、管理操作に使われる資格情報と、ログインの状態を表示する（通信しない）")
		.action(wrap(async (runtime, adminUrl, options) => login(runtime, adminUrl as string | undefined, options as LoginOptions)));
};
