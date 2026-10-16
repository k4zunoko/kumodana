import type { DeleteFileResponse } from "@kumodana/shared/api-types";
import type { Command } from "commander";
import { CliError } from "../errors.ts";
import { printError, printResult, printWarning } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

type RemoveResult = { id: string; result?: DeleteFileResponse; error?: { code: string; message: string } };

/** `kumo rm <id...>` (FR-028). Deletion always completes; a purge failure is reported. */
export async function remove(runtime: Runtime, ids: string[]): Promise<number> {
	const api = await runtime.api();
	const results: RemoveResult[] = [];
	for (const id of ids) {
		try {
			const result = await api.request<DeleteFileResponse>("DELETE", `/api/files/${encodeURIComponent(id)}`);
			results.push({ id, result });
			if (result.purge && !result.purge.ok) {
				printWarning(
					runtime.out,
					`${id} は削除しましたが、配信側のキャッシュ削除に失敗しました（${result.purge.error}）。` +
						"配信側に残った分も、削除から 1 時間以内に見られなくなります。",
				);
			}
		} catch (error) {
			const cliError = error instanceof CliError ? error : new CliError(String(error));
			results.push({ id, error: { code: cliError.code, message: cliError.message } });
			if (!runtime.out.json) printError(runtime.out, new CliError(`${id}: ${cliError.message}`, cliError));
		}
	}
	const deleted = results.filter((r) => r.result);
	printResult(
		runtime.out,
		deleted.map((r) => `削除しました: ${r.id}（取り消したリンク ${r.result?.revokedLinks ?? 0} 本）`),
		{ results },
	);
	const problem = results.some((r) => r.error || (r.result?.purge && !r.result.purge.ok));
	return problem ? 1 : 0;
}

export const registerRm: Register = (program: Command, wrap) => {
	program
		.command("rm")
		.description("ファイルを削除する（リンクもすべて使えなくなる）")
		.argument("<id...>", "ファイル ID")
		.action(wrap(async (runtime, ids) => remove(runtime, ids as string[])));
};
