import type { LinkResponse } from "@kumodana/shared/api-types";
import type { Command } from "commander";
import { printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

/** `kumo link create <id>` */
export async function linkCreate(runtime: Runtime, id: string, options: { label?: string }): Promise<number> {
	const api = await runtime.api();
	const json = options.label ? { label: options.label } : {};
	const { link } = await api.request<LinkResponse>("POST", `/api/files/${encodeURIComponent(id)}/links`, { json });
	printResult(runtime.out, link.url, { link });
	return 0;
}

export const registerLink: Register = (program: Command, wrap) => {
	const link = program.command("link").description("リンクを発行・一覧・取り消す");
	link
		.command("create")
		.description("リンクを発行する")
		.argument("<id>", "ファイル ID")
		.option("--label <text>", "渡した相手などのメモ")
		.action(wrap(async (runtime, id, options) => linkCreate(runtime, id as string, options as { label?: string })));
};
