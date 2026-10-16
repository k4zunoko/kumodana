import type { Link, LinkListResponse, LinkResponse, RevokeResponse } from "@kumodana/shared/api-types";
import { LINK_TOKEN_PATTERN } from "@kumodana/shared/ids";
import type { Command } from "commander";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { printResult, printWarning } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

/** Accepts a bare token or a link URL (query strings are ignored). */
export function tokenFromArgument(value: string): string | undefined {
	let candidate = value.trim();
	if (candidate.includes("/")) {
		try {
			candidate = new URL(candidate).pathname.split("/").filter(Boolean).pop() ?? "";
		} catch {
			candidate = candidate.split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
		}
	}
	return LINK_TOKEN_PATTERN.test(candidate) ? candidate : undefined;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function describeLink(link: Link): string {
	const state = link.revokedAt ? `取り消し済み（${formatDate(link.revokedAt)}）` : "有効";
	return `${link.url}  ${link.fileId}  ${link.label ?? "-"}  ${formatDate(link.createdAt)}  ${state}`;
}

/** `kumo link create <id>` */
export async function linkCreate(runtime: Runtime, id: string, options: { label?: string }): Promise<number> {
	const api = await runtime.api();
	const json = options.label ? { label: options.label } : {};
	const { link } = await api.request<LinkResponse>("POST", `/api/files/${encodeURIComponent(id)}/links`, { json });
	printResult(runtime.out, link.url, { link });
	return 0;
}

/** `kumo link ls [id] [--all]` */
export async function linkList(runtime: Runtime, fileId: string | undefined, options: { all?: boolean }): Promise<number> {
	const api = await runtime.api();
	const { links } = await api.request<LinkListResponse>("GET", "/api/links", {
		query: { fileId, includeRevoked: options.all ? "true" : "false" },
	});
	printResult(runtime.out, links.length > 0 ? links.map(describeLink) : ["リンクはありません。"], { links });
	return 0;
}

/** `kumo link revoke <token|url>` */
export async function linkRevoke(runtime: Runtime, argument: string): Promise<number> {
	const token = tokenFromArgument(argument);
	if (!token) {
		throw new CliError(`リンクのトークンまたは URL ではありません: ${argument}`, {
			hint: "kumo link ls で URL を確認してください。",
			code: "invalid_argument",
			exitCode: EXIT_USAGE,
		});
	}
	const api = await runtime.api();
	const result = await api.request<RevokeResponse>("DELETE", `/api/links/${token}`);
	printResult(runtime.out, `取り消しました: ${result.link.url}`, result);
	if (!result.purge.ok) {
		printWarning(
			runtime.out,
			`取り消しは記録しましたが、配信側のキャッシュ削除に失敗しました（${result.purge.error}）。` +
				"同じコマンドで削除をやり直せます。やり直さなくても、取り消しから 1 時間以内に見られなくなります。",
		);
		return 1;
	}
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
	link
		.command("ls")
		.description("リンクを一覧する（新しい順）")
		.argument("[id]", "ファイル ID（省略時はすべて）")
		.option("--all", "取り消し済みも含める")
		.action(wrap(async (runtime, id, options) => linkList(runtime, id as string | undefined, options as { all?: boolean })));
	link
		.command("revoke")
		.description("リンクを取り消す")
		.argument("<token|url>", "トークンまたはリンクの URL")
		.action(wrap(async (runtime, token) => linkRevoke(runtime, token as string)));
};
