import type { Usage } from "@kumodana/shared/api-types";
import type { Command } from "commander";
import { formatBytes, printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

/** `kumo usage` (FR-011) */
export async function usage(runtime: Runtime): Promise<number> {
	const api = await runtime.api();
	const result = await api.request<Usage>("GET", "/api/usage");
	const percent = result.limitBytes > 0 ? ((result.usedBytes / result.limitBytes) * 100).toFixed(1) : "0";
	printResult(
		runtime.out,
		[
			`使用量: ${formatBytes(result.usedBytes)} / ${formatBytes(result.limitBytes)}（${percent}%）`,
			`残り:   ${formatBytes(result.remainingBytes)}`,
			`ファイル数: ${result.fileCount}`,
		],
		result,
	);
	return 0;
}

export const registerUsage: Register = (program: Command, wrap) => {
	program
		.command("usage")
		.description("使用量と上限を表示する")
		.action(wrap(async (runtime) => usage(runtime)));
};
