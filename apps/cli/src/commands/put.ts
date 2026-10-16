import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FileListResponse, FileSummary, Link, LinkResponse, UploadResponse } from "@kumodana/shared/api-types";
import { HEADER_FILENAME, HEADER_SHA256 } from "@kumodana/shared/api-types";
import { MAX_FILE_BYTES } from "@kumodana/shared/limits";
import type { Command } from "commander";
import type { AdminApi } from "../api.ts";
import { CliError } from "../errors.ts";
import { endExiftool, stripMetadata } from "../exif.ts";
import { formatBytes, printError, printResult } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import { sniff } from "../sniff.ts";
import type { Register } from "./index.ts";

export type PutOptions = {
	link?: boolean;
	label?: string;
	keepExif?: boolean;
};

type PutResult = {
	path: string;
	file?: FileSummary;
	duplicate?: boolean;
	link?: Link;
	error?: { code: string; message: string };
};

async function findExisting(api: AdminApi, sha256: string): Promise<FileSummary | undefined> {
	const list = await api.request<FileListResponse>("GET", "/api/files", { query: { sha256 } });
	return list.files[0];
}

async function upload(
	api: AdminApi,
	data: Buffer,
	contentType: string,
	sha256: string,
	name: string,
): Promise<{ file: FileSummary; duplicate: boolean }> {
	try {
		return await api.request<UploadResponse>("PUT", "/api/files", {
			body: data as unknown as BodyInit,
			headers: {
				"Content-Type": contentType,
				[HEADER_SHA256]: sha256,
				[HEADER_FILENAME]: encodeURIComponent(name),
			},
		});
	} catch (error) {
		// The server may answer before reading the whole body (for example, a duplicate found meanwhile),
		// which can make sending fail. Check by content before reporting a failure.
		if (error instanceof CliError && error.code === "network_error") {
			const existing = await findExisting(api, sha256).catch(() => undefined);
			if (existing) return { file: existing, duplicate: true };
		}
		throw error;
	}
}

async function putOne(api: AdminApi, path: string, options: PutOptions): Promise<PutResult> {
	const info = await stat(path).catch(() => undefined);
	if (!info?.isFile()) throw new CliError(`ファイルが見つかりません: ${path}`, { code: "not_found" });
	if (info.size > MAX_FILE_BYTES) {
		throw new CliError(`ファイルが大きすぎます（${formatBytes(info.size)}）。100MB 未満にしてください。`, {
			code: "file_too_large",
		});
	}

	const original = await readFile(path);
	const sniffed = sniff(original);
	if (!sniffed.ok) throw new CliError(sniffed.reason, { code: "unsupported_type" });

	let data = original;
	if (sniffed.kind === "image" && !options.keepExif) {
		const stripped = await stripMetadata(path);
		try {
			data = await readFile(stripped.path);
		} finally {
			await stripped.cleanup();
		}
	}

	const sha256 = createHash("sha256").update(data).digest("hex");
	const name = basename(path);
	const existing = await findExisting(api, sha256);
	const { file, duplicate } = existing
		? { file: existing, duplicate: true }
		: await upload(api, data, sniffed.contentType, sha256, name);

	const result: PutResult = { path, file, duplicate };
	if (options.link) {
		const json = options.label ? { label: options.label } : {};
		result.link = (await api.request<LinkResponse>("POST", `/api/files/${file.id}/links`, { json })).link;
	}
	return result;
}

function describe(result: PutResult): string[] {
	if (!result.file) return [];
	const { file } = result;
	const lines = [`${file.id}  ${file.name}  ${formatBytes(file.size)}${result.duplicate ? "  （重複: 既存のファイルを使用）" : ""}`];
	if (result.link) lines.push(`  リンク: ${result.link.url}`);
	return lines;
}

/** `kumo put`: see contracts/cli.md. */
export async function put(runtime: Runtime, paths: string[], options: PutOptions): Promise<number> {
	const api = await runtime.api();
	const results: PutResult[] = [];
	try {
		for (const path of paths) {
			try {
				results.push(await putOne(api, path, options));
			} catch (error) {
				const cliError =
					error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
				results.push({ path, error: { code: cliError.code, message: cliError.message } });
				if (!runtime.out.json) printError(runtime.out, new CliError(`${path}: ${cliError.message}`, cliError));
			}
		}
	} finally {
		await endExiftool();
	}

	const failed = results.filter((r) => r.error);
	const human = results.flatMap(describe);
	if (failed.length > 0) human.push(`失敗: ${failed.length} 件（${failed.map((r) => r.path).join("、")}）`);
	printResult(runtime.out, human, { results });
	return failed.length > 0 ? 1 : 0;
}

export const registerPut: Register = (program: Command, wrap) => {
	program
		.command("put")
		.description("ファイルを置く（画像の EXIF は既定で削除する）")
		.argument("<path...>", "置くファイル")
		.option("--link", "リンクも発行する")
		.option("--label <text>", "リンクに付けるメモ")
		.option("--keep-exif", "画像のメタデータを残す")
		.action(wrap(async (runtime, paths, options) => put(runtime, paths as string[], options as PutOptions)));
};
