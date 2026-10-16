import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { filenameFromDisposition } from "@kumodana/shared/http";
import type { Command } from "commander";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { formatBytes, printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

export type GetOptions = { output?: string; cwd?: string };

/** `kumo get <id>`: saves a file under its original name, never overwriting (FR-029). */
export async function get(runtime: Runtime, id: string, options: GetOptions): Promise<number> {
	const api = await runtime.api();
	const response = await api.raw("GET", `/api/files/${encodeURIComponent(id)}/content`);
	const name = basename(filenameFromDisposition(response.headers.get("Content-Disposition")) ?? id);
	const target = options.output ? resolve(options.cwd ?? ".", options.output) : join(options.cwd ?? ".", name);
	const data = Buffer.from(await response.arrayBuffer());
	try {
		await writeFile(target, data, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new CliError(`ファイルが既にあります: ${target}`, {
				hint: "--output で別の名前を指定するか、既存のファイルを移動してください。",
				code: "file_exists",
				exitCode: EXIT_USAGE,
			});
		}
		throw error;
	}
	printResult(runtime.out, `${target}（${formatBytes(data.length)}）`, { path: target, size: data.length });
	return 0;
}

export const registerGet: Register = (program: Command, wrap) => {
	program
		.command("get")
		.description("置いたファイルを手元に保存する（上書きはしない）")
		.argument("<id>", "ファイル ID")
		.option("-o, --output <path>", "保存先のパス")
		.action(wrap(async (runtime, id, options) => get(runtime, id as string, options as GetOptions)));
};
