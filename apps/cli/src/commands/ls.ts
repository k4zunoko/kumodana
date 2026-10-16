import type { FileListResponse, FileSummary } from "@kumodana/shared/api-types";
import type { Command } from "commander";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { formatBytes, printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

export type ListOptions = { tag?: string[]; limit?: string };

function describeFile(file: FileSummary): string {
	const date = new Date(file.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
	const tags = file.tags.length > 0 ? `[${file.tags.join(", ")}]` : "-";
	return `${file.id}  ${file.name}  ${file.contentType}  ${formatBytes(file.size)}  ${date}  ${tags}  リンク ${file.activeLinkCount}`;
}

/** `kumo ls [--tag <tag>]... [--limit <n>]` (FR-024). Follows cursors until done or the limit. */
export async function list(runtime: Runtime, options: ListOptions): Promise<number> {
	const max = options.limit === undefined ? Number.POSITIVE_INFINITY : Number(options.limit);
	if (!Number.isInteger(max) && max !== Number.POSITIVE_INFINITY) {
		throw new CliError("--limit には正の整数を指定してください。", { code: "invalid_argument", exitCode: EXIT_USAGE });
	}
	if (max < 1) throw new CliError("--limit には正の整数を指定してください。", { code: "invalid_argument", exitCode: EXIT_USAGE });

	const api = await runtime.api();
	const files: FileSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await api.request<FileListResponse>("GET", "/api/files", {
			query: { tag: options.tag ?? [], limit: String(Math.min(200, max - files.length)), cursor },
		});
		files.push(...page.files);
		cursor = page.nextCursor ?? undefined;
	} while (cursor && files.length < max);

	printResult(runtime.out, files.length > 0 ? files.map(describeFile) : ["該当するファイルはありません。"], { files });
	return 0;
}

export const registerLs: Register = (program: Command, wrap) => {
	program
		.command("ls")
		.description("ファイルを新しい順に一覧する")
		.option("--tag <tag>", "タグで絞り込む（繰り返すと、すべてのタグを持つファイルだけ）", (value, previous: string[] = []) => [
			...previous,
			value,
		])
		.option("--limit <n>", "表示する件数の上限")
		.action(wrap(async (runtime, options) => list(runtime, options as ListOptions)));
};
