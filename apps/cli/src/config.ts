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

/** `%APPDATA%\kumodana\config.json` on Windows, `$XDG_CONFIG_HOME/kumodana/config.json` elsewhere. */
export function configFilePath(env: Env = process.env, platform: string = process.platform): string {
	if (platform === "win32") {
		const appData = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
		return join(appData, "kumodana", "config.json");
	}
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(base, "kumodana", "config.json");
}

/** Environment variables override the config file. Missing keys are named; the secret value is never shown. */
export async function loadConfig(env: Env = process.env, platform: string = process.platform): Promise<CliConfig> {
	const path = configFilePath(env, platform);
	let file: Record<string, unknown> = {};
	try {
		file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new CliError(`設定ファイルを読み込めません: ${path}`, {
				hint: "JSON の形式が正しいか確認してください。",
				code: "config_invalid",
				exitCode: EXIT_USAGE,
			});
		}
	}

	const values: Partial<CliConfig> = {};
	const missing: string[] = [];
	for (const { key, env: name } of KEYS) {
		const value = env[name] ?? (typeof file[key] === "string" ? (file[key] as string) : undefined);
		if (value && value.trim() !== "") values[key] = value.trim();
		else missing.push(`${name}（設定ファイルでは ${key}）`);
	}
	if (missing.length > 0) {
		throw new CliError(`設定が足りません: ${missing.join("、")}`, {
			hint: `環境変数を設定するか、${path} に書いてください。`,
			code: "config_missing",
			exitCode: EXIT_USAGE,
		});
	}
	const config = values as CliConfig;
	config.adminUrl = config.adminUrl.replace(/\/+$/, "");
	return config;
}
