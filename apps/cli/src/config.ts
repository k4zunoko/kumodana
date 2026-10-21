import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT_USAGE } from "./errors.ts";

export type CliConfig = {
	adminUrl: string;
	clientId: string;
	clientSecret: string;
};

const KEYS = [
	{ key: "adminUrl", env: "KUMODANA_ADMIN_URL" },
	{ key: "clientId", env: "KUMODANA_CLIENT_ID" },
	{ key: "clientSecret", env: "KUMODANA_CLIENT_SECRET" },
] as const;

type Env = Record<string, string | undefined>;

/** `%APPDATA%\kumodana` on Windows, `$XDG_CONFIG_HOME/kumodana` elsewhere. */
export function configDir(env: Env = process.env, platform: string = process.platform): string {
	if (platform === "win32") {
		const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		return join(appData, "kumodana");
	}
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "kumodana");
}

/** `%APPDATA%\kumodana\config.json` on Windows, `$XDG_CONFIG_HOME/kumodana/config.json` elsewhere. */
export function configFilePath(env: Env = process.env, platform: string = process.platform): string {
	return join(configDir(env, platform), "config.json");
}

/** The login record sits next to config.json (specs/003-cli-login research L9). The CLI never writes config.json. */
export function loginFilePath(env: Env = process.env, platform: string = process.platform): string {
	return join(configDir(env, platform), "login.json");
}

/** Reads config.json. A missing file is an empty object; an unreadable or malformed one is `config_invalid`. */
export async function readConfigFile(
	env: Env = process.env,
	platform: string = process.platform,
): Promise<Record<string, unknown>> {
	const path = configFilePath(env, platform);
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new CliError(`設定ファイルを読み込めません: ${path}`, {
			hint: "JSON の形式が正しいか確認してください。",
			code: "config_invalid",
			exitCode: EXIT_USAGE,
		});
	}
}

export type CollectedConfig = { values: Partial<CliConfig>; missing: string[] };

/** Combines environment variables and the config file key by key, as the service-token path always has. */
export function collectConfig(env: Env, file: Record<string, unknown>): CollectedConfig {
	const values: Partial<CliConfig> = {};
	const missing: string[] = [];
	for (const { key, env: name } of KEYS) {
		const value = env[name] ?? (typeof file[key] === "string" ? (file[key] as string) : undefined);
		if (value && value.trim() !== "") values[key] = value.trim();
		else missing.push(`${name}（設定ファイルでは ${key}）`);
	}
	if (values.adminUrl) values.adminUrl = values.adminUrl.replace(/\/+$/, "");
	return { values, missing };
}

/** The `config_missing` error for the service-token path. Names the missing keys; never shows a value. */
export function missingConfigError(missing: string[], path: string): CliError {
	return new CliError(`設定が足りません: ${missing.join("、")}`, {
		hint: `環境変数を設定するか、${path} に書いてください。`,
		code: "config_missing",
		exitCode: EXIT_USAGE,
	});
}

/** Environment variables override the config file. Missing keys are named; the secret value is never shown. */
export async function loadConfig(env: Env = process.env, platform: string = process.platform): Promise<CliConfig> {
	const file = await readConfigFile(env, platform);
	const { values, missing } = collectConfig(env, file);
	if (missing.length > 0) throw missingConfigError(missing, configFilePath(env, platform));
	return values as CliConfig;
}
