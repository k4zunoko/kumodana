import { AdminApi } from "./api.ts";
import { type CliConfig, missingConfigError } from "./config.ts";
import { type CliContext, createContext } from "./context.ts";
import { LoginCredentials, type Resolved, resolveCredentials, ServiceTokenCredentials } from "./credentials.ts";
import { CliError, EXIT_USAGE } from "./errors.ts";
import { normalizeAdminUrl, sameAdminUrl } from "./login-store.ts";
import { createOutput, type Output, printError } from "./output.ts";

/** What a command needs: output, the outside world, and a lazily configured API client. */
export type Runtime = {
	out: Output;
	ctx: CliContext;
	api: () => Promise<AdminApi>;
};

export type RuntimeOptions = {
	json: boolean;
	/** Tests: use these service-token values instead of choosing credentials (the pre-003 path). */
	loadConfig?: () => Promise<CliConfig>;
	fetchImpl?: typeof fetch;
	out?: Output;
	/** Tests: replace the environment, clock, browser, URL policy, and so on. */
	context?: Partial<CliContext>;
};

/** Builds the admin API client for the chosen method (specs/003-cli-login contracts/cli.md「設定」). */
export function createAdminApi(resolved: Resolved, ctx: CliContext, out: Output): AdminApi {
	switch (resolved.method) {
		case "env_service_token":
		case "config_service_token": {
			const { values, missing } = resolved.serviceToken ?? { values: {}, missing: [] };
			if (missing.length > 0) throw missingConfigError(missing, resolved.configPath);
			const config = values as CliConfig;
			out.secrets.push(config.clientSecret);
			return new AdminApi(config, ctx.fetchImpl);
		}
		case "login": {
			const record = resolved.login;
			if (!record?.session) throw new CliError("ログインの記録がありません。", { code: "config_missing", exitCode: EXIT_USAGE });
			const envUrl = ctx.env.KUMODANA_ADMIN_URL;
			if (envUrl && envUrl.trim() !== "" && !sameAdminUrl(normalizeAdminUrl(envUrl, ctx.urls) ?? envUrl.trim(), record.adminUrl)) {
				throw new CliError(
					`KUMODANA_ADMIN_URL（${envUrl.trim()}）が、ログインした管理 API の URL（${record.adminUrl}）と違います。資格情報は送っていません。`,
					{
						code: "admin_url_mismatch",
						hint: "KUMODANA_ADMIN_URL を削除するか、その URL で kumo login を実行してください。",
						exitCode: EXIT_USAGE,
					},
				);
			}
			const credentials = new LoginCredentials({ ...record, session: record.session }, resolved.loginPath, ctx, out);
			return new AdminApi({ adminUrl: record.adminUrl, credentials }, ctx.fetchImpl);
		}
		case "none":
			throw new CliError("管理 API に接続するための資格情報がありません。", {
				code: "config_missing",
				hint:
					"kumo login <管理 API の URL> でログインしてください。サービストークンを使う場合は、" +
					`環境変数 KUMODANA_ADMIN_URL・KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET を設定するか、${resolved.configPath} に書いてください。`,
				exitCode: EXIT_USAGE,
			});
	}
}

export function createRuntime(options: RuntimeOptions): Runtime {
	const out = options.out ?? createOutput(options.json);
	const ctx = createContext({
		...options.context,
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
	});
	let api: AdminApi | undefined;
	return {
		out,
		ctx,
		api: async () => {
			if (!api) {
				if (options.loadConfig) {
					const config = await options.loadConfig();
					out.secrets.push(config.clientSecret);
					api = new AdminApi({ adminUrl: config.adminUrl, credentials: new ServiceTokenCredentials(config) }, ctx.fetchImpl);
				} else {
					api = createAdminApi(await resolveCredentials(ctx), ctx, out);
				}
			}
			return api;
		},
	};
}

/** Runs a command body and converts its result or error into an exit code. */
export async function runCommand(runtime: Runtime, body: () => Promise<number | void>): Promise<number> {
	try {
		return (await body()) ?? 0;
	} catch (error) {
		return printError(runtime.out, error);
	}
}
