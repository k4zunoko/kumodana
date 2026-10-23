import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
	FileListResponse,
	FileSummary,
	Link,
	LinkResponse,
	TagsResponse,
	UploadResponse,
} from "@kumodana/shared/api-types";
import { HEADER_FILENAME, HEADER_SHA256 } from "@kumodana/shared/api-types";
import { MAX_FILE_BYTES } from "@kumodana/shared/limits";
import { type Command, Option } from "commander";
import type { AdminApi } from "../api.ts";
import { CliError } from "../errors.ts";
import { endExiftool, stripMetadata } from "../exif.ts";
import { formatBytes, printError, printResult, printWarning } from "../output.ts";
import { KIND_LABELS, parseAs, prepare } from "../prepare.ts";
import type { Runtime } from "../runtime.ts";
import { AS_VALUES, type As, type Kind } from "../sniff.ts";
import { removeSvgMetadata } from "../svg.ts";
import { parseTagChanges } from "./tag.ts";
import type { Register } from "./index.ts";

const METADATA_KEPT_WARNING = "--keep-exif を付けたため、メタデータ（位置情報、作者名など）を残したまま置きました。";

export type PutOptions = {
	tag?: string[];
	link?: boolean;
	label?: string;
	keepExif?: boolean;
	/** `--as markdown|text` (specs/002-markdown-share contracts/cli.md). */
	as?: string;
};

type PutResult = {
	path: string;
	kind?: Kind;
	warnings?: string[];
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
	data: Uint8Array,
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
		if (error instanceof CliError && error.code === "upload_in_progress") {
			const seconds = Number(error.details?.retryAfterSeconds ?? 0);
			const minutes = Math.max(1, Math.ceil(seconds / 60));
			throw new CliError(`${error.message}あと約 ${minutes} 分待ってから、もう一度置いてください。`, {
				code: error.code,
				details: error.details,
				hint: "前回のアップロードが途中で止まった場合も、10 分を過ぎれば置き直せます。",
			});
		}
		throw error;
	}
}

/** Reads a file and checks its size before anything else (FR-003 of 001). */
export async function readSource(path: string): Promise<Buffer> {
	const info = await stat(path).catch(() => undefined);
	if (!info?.isFile()) throw new CliError(`ファイルが見つかりません: ${path}`, { code: "not_found" });
	if (info.size > MAX_FILE_BYTES) {
		throw new CliError(`ファイルが大きすぎます（${formatBytes(info.size)}）。100MB 未満にしてください。`, {
			code: "file_too_large",
		});
	}
	return readFile(path);
}

async function putOne(api: AdminApi, path: string, options: PutOptions, as: As | undefined): Promise<PutResult> {
	const original = await readSource(path);
	// Detect by content and convert Markdown documents and text to HTML (specs/002-markdown-share).
	const prepared = prepare(original, basename(path), as);

	let data = prepared.data;
	const warnings = [...prepared.warnings];
	if (options.keepExif && (prepared.kind === "image" || prepared.kind === "svg")) {
		warnings.push(METADATA_KEPT_WARNING);
	} else if (prepared.kind === "image") {
		const stripped = await stripMetadata(path);
		try {
			data = await readFile(stripped.path);
		} finally {
			await stripped.cleanup();
		}
	} else if (prepared.kind === "svg") {
		const cleaned = removeSvgMetadata(data);
		data = cleaned.data;
		warnings.push(...cleaned.warnings);
	}

	const sha256 = createHash("sha256").update(data).digest("hex");
	const existing = await findExisting(api, sha256);
	const { file, duplicate } = existing
		? { file: existing, duplicate: true }
		: await upload(api, data, prepared.contentType, sha256, prepared.name);

	const result: PutResult = { path, kind: prepared.kind, warnings, file, duplicate };
	if (options.tag && options.tag.length > 0) {
		const { add } = parseTagChanges(options.tag.map((t) => `+${t}`));
		const tagged = await api.request<TagsResponse>("PATCH", `/api/files/${file.id}/tags`, { json: { add } });
		result.file = { ...file, tags: tagged.tags };
	}
	if (options.link) {
		const json = options.label ? { label: options.label } : {};
		result.link = (await api.request<LinkResponse>("POST", `/api/files/${file.id}/links`, { json })).link;
	}
	return result;
}

function describe(result: PutResult): string[] {
	if (!result.file) return [];
	const { file } = result;
	const kind = result.kind ? `  ${KIND_LABELS[result.kind]}` : "";
	const lines = [
		`${file.id}  ${file.name}  ${formatBytes(file.size)}${kind}${result.duplicate ? "  （重複: 既存のファイルを使用）" : ""}`,
	];
	if (result.link) lines.push(`  リンク: ${result.link.url}`);
	return lines;
}

type Summary = { kinds: Partial<Record<Kind, number>>; warnings: number };

function summarize(results: PutResult[]): Summary {
	const kinds: Partial<Record<Kind, number>> = {};
	let warnings = 0;
	for (const result of results) {
		if (result.kind && result.file) kinds[result.kind] = (kinds[result.kind] ?? 0) + 1;
		warnings += result.warnings?.length ?? 0;
	}
	return { kinds, warnings };
}

function describeSummary(summary: Summary): string {
	const kinds = (Object.entries(summary.kinds) as [Kind, number][]).map(([kind, count]) => `${KIND_LABELS[kind]} ${count} 件`);
	return `形式: ${kinds.length > 0 ? kinds.join("、") : "なし"} / 警告: ${summary.warnings} 件`;
}

/** `kumo put`: see contracts/cli.md of 001 and 002. */
export async function put(runtime: Runtime, paths: string[], options: PutOptions): Promise<number> {
	if (options.tag) parseTagChanges(options.tag.map((t) => `+${t}`)); // reject bad tags before uploading
	const as = parseAs(options.as);
	const api = await runtime.api();
	const results: PutResult[] = [];
	try {
		for (const path of paths) {
			try {
				const result = await putOne(api, path, options, as);
				results.push(result);
				// Warnings never stop the upload (FR-019). With --json they are part of the result instead.
				if (!runtime.out.json) for (const warning of result.warnings ?? []) printWarning(runtime.out, `${path}: ${warning}`);
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
	const summary = summarize(results);
	const human = results.flatMap(describe);
	if (paths.length > 1) human.push(describeSummary(summary));
	if (failed.length > 0) human.push(`失敗: ${failed.length} 件（${failed.map((r) => r.path).join("、")}）`);
	printResult(runtime.out, human, { results, summary });
	return failed.length > 0 ? 1 : 0;
}

/** `--as <markdown|text>`, shared by put and preview. */
export function asOption(): Option {
	return new Option("--as <kind>", "テキストを Markdown（markdown）か、そのままの形（text）として扱う").choices([...AS_VALUES]);
}

export const registerPut: Register = (program: Command, wrap) => {
	program
		.command("put")
		.description("ファイルを置く（画像と SVG のメタデータは既定で削除し、Markdown 文書とテキストは HTML に変換する）")
		.argument("<path...>", "置くファイル")
		.option("--tag <tag>", "タグを付ける（繰り返し指定できる）", (value: string, previous: string[] = []) => [...previous, value])
		.option("--link", "リンクも発行する")
		.option("--label <text>", "リンクに付けるメモ")
		.option("--keep-exif", "画像と SVG のメタデータを残す")
		.addOption(asOption())
		.action(wrap(async (runtime, paths, options) => put(runtime, paths as string[], options as PutOptions)));
};
