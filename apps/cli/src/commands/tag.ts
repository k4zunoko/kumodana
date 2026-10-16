import type { TagListResponse, TagsResponse } from "@kumodana/shared/api-types";
import { normalizeTag } from "@kumodana/shared/names";
import type { Command } from "commander";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { displayWidth, printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

function invalid(message: string): CliError {
	return new CliError(message, {
		hint: "例: kumo tag <id> +旅行 +2026 -draft",
		code: "invalid_argument",
		exitCode: EXIT_USAGE,
	});
}

/** Splits `+tag` / `-tag` arguments into additions and removals, validating each tag locally. */
export function parseTagChanges(changes: string[]): { add: string[]; remove: string[] } {
	const add: string[] = [];
	const remove: string[] = [];
	for (const change of changes) {
		const sign = change[0];
		if (sign !== "+" && sign !== "-") throw invalid(`タグの前に + か - を付けてください: ${change}`);
		const result = normalizeTag(change.slice(1));
		if (!result.ok) throw invalid(`${result.reason}（${change}）`);
		(sign === "+" ? add : remove).push(result.tag);
	}
	if (add.length + remove.length === 0) throw invalid("変更するタグを指定してください。");
	return { add, remove };
}

/** `kumo tag <id> <+tag|-tag>...` (FR-025) */
export async function tag(runtime: Runtime, id: string, changes: string[]): Promise<number> {
	const json = parseTagChanges(changes);
	const api = await runtime.api();
	const result = await api.request<TagsResponse>("PATCH", `/api/files/${encodeURIComponent(id)}/tags`, { json });
	printResult(runtime.out, `${id}: ${result.tags.length > 0 ? result.tags.join(", ") : "（タグなし）"}`, result);
	return 0;
}

/** `kumo tags` (FR-026) */
export async function tagList(runtime: Runtime): Promise<number> {
	const api = await runtime.api();
	const result = await api.request<TagListResponse>("GET", "/api/tags");
	const width = Math.max(0, ...result.tags.map((t) => displayWidth(t.tag)));
	const lines = result.tags.map((t) => `${t.tag}${" ".repeat(width - displayWidth(t.tag))}  ${t.fileCount}`);
	printResult(runtime.out, lines.length > 0 ? lines : ["タグはありません。"], result);
	return 0;
}

export const registerTag: Register = (program: Command, wrap) => {
	program
		.command("tag")
		.description("タグを付ける・外す（例: kumo tag <id> +旅行 -draft）")
		.argument("<id>", "ファイル ID")
		.argument("<changes...>", "+タグ で付ける、-タグ で外す")
		.allowUnknownOption()
		.action(wrap(async (runtime, id, changes) => tag(runtime, id as string, changes as string[])));
	program
		.command("tags")
		.description("使われているタグを件数とともに一覧する")
		.action(wrap(async (runtime) => tagList(runtime)));
};
