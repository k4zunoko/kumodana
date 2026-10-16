import { AdminApi } from "./api.ts";
import { type CliConfig, loadConfig } from "./config.ts";
import { createOutput, type Output, printError } from "./output.ts";

/** What a command needs: output and a lazily configured API client. */
export type Runtime = {
	out: Output;
	api: () => Promise<AdminApi>;
};

export type RuntimeOptions = {
	json: boolean;
	loadConfig?: () => Promise<CliConfig>;
	fetchImpl?: typeof fetch;
	out?: Output;
};

export function createRuntime(options: RuntimeOptions): Runtime {
	const out = options.out ?? createOutput(options.json);
	let api: AdminApi | undefined;
	return {
		out,
		api: async () => {
			if (!api) {
				const config = await (options.loadConfig ?? loadConfig)();
				out.secrets.push(config.clientSecret);
				api = new AdminApi(config, options.fetchImpl);
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
