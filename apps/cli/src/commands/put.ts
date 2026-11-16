import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
	ContentSummary,
	FileDetailResponse,
	FileListResponse,
	FileSummary,
	Link,
	LinkListResponse,
	LinkResponse,
	PurgeResult,
	ReplaceContentResponse,
	TagsResponse,
	UploadResponse,
} from "@kumodana/shared/api-types";
import { HEADER_FILENAME, HEADER_SHA256 } from "@kumodana/shared/api-types";
import { isFileId } from "@kumodana/shared/ids";
import type { AllowedContentType } from "@kumodana/shared/limits";
import { MAX_FILE_BYTES } from "@kumodana/shared/limits";
import { type Command, Option } from "commander";
import type { AdminApi } from "../api.ts";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { endExiftool, stripMetadata } from "../exif.ts";
import { formatBytes, printError, printResult, printWarning } from "../output.ts";
import { KIND_LABELS, parseAs, prepare } from "../prepare.ts";
import type { Runtime } from "../runtime.ts";
import { AS_VALUES, type As, type Kind } from "../sniff.ts";
import { removeSvgMetadata } from "../svg.ts";
import { tokenFromArgument } from "./link.ts";
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
	/** `--replace <id|url>`: replace the content of this file instead of putting a new one (specs/005-replace-content). */
	replace?: string;
};

type PutResult = {
	path: string;
	kind?: Kind;
	warnings?: string[];
	file?: FileSummary;
	duplicate?: boolean;
	/** With --replace: whether the content changed (false: it was already this content). */
	replaced?: boolean;
	/** With --replace: the content before. */
	previous?: ContentSummary;
	/** With --replace: the purge of the file's cached copies (null: it never had a link). */
	purge?: PurgeResult | null;
	/** With --replace: the active links, which now show the new content. */
	links?: Link[];
	link?: Link;
	error?: { code: string; message: string };
};

/** What `kumo put` sends for one file: detected, converted, and with metadata removed. */
type Ready = {
	kind: Kind;
	contentType: AllowedContentType;
	data: Uint8Array;
	name: string;
	sha256: string;
	warnings: string[];
};

async function findExisting(api: AdminApi, sha256: string): Promise<FileSummary | undefined> {
	const list = await api.request<FileListResponse>("GET", "/api/files", { query: { sha256 } });
	return list.files[0];
}

/** 409 upload_in_progress: the same content is being uploaded. Say how long to wait (FR-008 of 001). */
function uploadInProgress(error: CliError, again: string): CliError {
	const seconds = Number(error.details?.retryAfterSeconds ?? 0);
	const minutes = Math.max(1, Math.ceil(seconds / 60));
	return new CliError(`${error.message}あと約 ${minutes} 分待ってから、${again}`, {
		code: error.code,
		details: error.details,
		hint: "前回のアップロードが途中で止まった場合も、10 分を過ぎれば置き直せます。",
	});
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
			throw uploadInProgress(error, "もう一度置いてください。");
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

/**
 * Turns a file into what `kumo put` sends, with and without --replace: detect by content and convert Markdown
 * documents and text to HTML (specs/002-markdown-share), then remove the metadata of images and SVG unless --keep-exif.
 * The original is only read (constitution I).
 */
async function readyToSend(path: string, options: PutOptions, as: As | undefined): Promise<Ready> {
	const original = await readSource(path);
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
	return { kind: prepared.kind, contentType: prepared.contentType, data, name: prepared.name, sha256, warnings };
}

/** `--tag` and `--link`, once the file is in place. */
async function tagAndLink(api: AdminApi, result: PutResult & { file: FileSummary }, options: PutOptions): Promise<void> {
	const { file } = result;
	if (options.tag && options.tag.length > 0) {
		const { add } = parseTagChanges(options.tag.map((t) => `+${t}`));
		const tagged = await api.request<TagsResponse>("PATCH", `/api/files/${file.id}/tags`, { json: { add } });
		result.file = { ...file, tags: tagged.tags };
	}
	if (options.link) {
		const json = options.label ? { label: options.label } : {};
		result.link = (await api.request<LinkResponse>("POST", `/api/files/${file.id}/links`, { json })).link;
		// The summary was read before this link existed, and a new link is always active.
		result.file = { ...result.file, activeLinkCount: file.activeLinkCount + 1 };
	}
}

async function putOne(api: AdminApi, path: string, options: PutOptions, as: As | undefined): Promise<PutResult> {
	const ready = await readyToSend(path, options, as);
	const existing = await findExisting(api, ready.sha256);
	const { file, duplicate } = existing
		? { file: existing, duplicate: true }
		: await upload(api, ready.data, ready.contentType, ready.sha256, ready.name);

	const result: PutResult & { file: FileSummary } = { path, kind: ready.kind, warnings: ready.warnings, file, duplicate };
	await tagAndLink(api, result, options);
	return result;
}

type ReplaceTarget = { fileId: string } | { token: string; argument: string };

/** `--replace <id|url>`: a file ID (10 characters), or a link URL or token (22 characters). */
function parseReplaceTarget(value: string): ReplaceTarget {
	const argument = value.trim();
	if (isFileId(argument)) return { fileId: argument };
	const token = tokenFromArgument(argument);
	if (token) return { token, argument };
	throw new CliError(`--replace には、ファイル ID（10 文字）か、リンクの URL（またはトークン）を指定してください: ${value}`, {
		hint: "ファイル ID は kumo ls で、リンクの URL は kumo link ls で確かめられます。",
		code: "invalid_argument",
		exitCode: EXIT_USAGE,
	});
}

/** The file to replace and its links. A link URL is resolved with GET /api/links; a revoked link is refused. */
async function resolveTarget(api: AdminApi, target: ReplaceTarget): Promise<FileDetailResponse> {
	let fileId: string;
	if ("token" in target) {
		const { links } = await api.request<LinkListResponse>("GET", "/api/links", { query: { includeRevoked: "true" } });
		const link = links.find((l) => l.token === target.token);
		if (!link) {
			throw new CliError(`リンクが見つかりません: ${target.argument}`, {
				hint: "kumo link ls で URL を確かめてください。",
				code: "not_found",
			});
		}
		if (link.revokedAt) {
			throw new CliError(`取り消し済みのリンクです: ${link.url}`, {
				hint:
					"取り消したリンクは、置き換えても見られるようにはなりません。ファイルの中身を置き換えるときは、" +
					"ファイル ID（kumo link ls --all で確かめられる）で指定してください。",
				code: "link_revoked",
			});
		}
		fileId = link.fileId;
	} else {
		fileId = target.fileId;
	}
	try {
		return await api.request<FileDetailResponse>("GET", `/api/files/${encodeURIComponent(fileId)}`);
	} catch (error) {
		if (error instanceof CliError && error.code === "not_found") {
			throw new CliError(`置き換えるファイルが見つかりません: ${fileId}`, { hint: "kumo ls で ID を確かめてください。", code: "not_found" });
		}
		throw error;
	}
}

function duplicateContent(fileId: string, details?: Record<string, unknown>): CliError {
	return new CliError(`同じ内容のファイルがすでにあります（${fileId}）。置き換えていません。`, {
		hint:
			`同じ内容は 1 つのファイルとしてだけ置けます。そのファイル（kumo link ls ${fileId}）を使うか、` +
			`不要なら kumo rm ${fileId} で消してから、もう一度実行してください。`,
		code: "duplicate_content",
		details: details ?? { fileId },
	});
}

/** `PUT /api/files/{id}/content` with the SHA-256 the file had when it was looked up as If-Match. */
async function sendReplacement(api: AdminApi, current: FileSummary, ready: Ready): Promise<ReplaceContentResponse> {
	try {
		return await api.request<ReplaceContentResponse>("PUT", `/api/files/${encodeURIComponent(current.id)}/content`, {
			body: ready.data as unknown as BodyInit,
			headers: {
				"Content-Type": ready.contentType,
				[HEADER_SHA256]: ready.sha256,
				[HEADER_FILENAME]: encodeURIComponent(ready.name),
				"If-Match": `"${current.sha256}"`,
			},
		});
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		const options = { code: error.code, details: error.details };
		switch (error.code) {
			case "precondition_failed":
				throw new CliError("置き換える直前に、このファイルの内容がほかの操作で変わりました。置き換えていません。", {
					...options,
					hint:
						"ほかの置き換え（エージェントなど）と重なった可能性があります。今の内容を kumo get で確かめ、" +
						"それでも置き換えるときは、同じコマンドをもう一度実行してください。",
				});
			case "duplicate_content":
				throw duplicateContent(String(error.details?.fileId ?? "?"), error.details);
			case "not_found":
				throw new CliError(`置き換えるファイルが見つかりません: ${current.id}`, {
					...options,
					hint: "直前に削除されたか、管理用 Worker が置き換えに対応していない（デプロイ前の）可能性があります。kumo ls で確かめてください。",
				});
			case "upload_in_progress":
				throw uploadInProgress(error, "もう一度実行してください。");
			case "quota_exceeded":
				throw new CliError(error.message, {
					...options,
					hint: "置き換えの間は、元の内容と新しい内容の合計で上限を判定します。kumo usage で使用量を確かめてください。",
				});
			case "network_error":
				throw new CliError(error.message, {
					...options,
					hint: [
						error.hint,
						"置き換えが済んだかは分かりません。同じコマンドをもう一度実行すると、済んでいなければ置き換え、" +
							"済んでいればキャッシュの削除だけをやり直します。",
					]
						.filter(Boolean)
						.join(""),
				});
			default:
				throw error;
		}
	}
}

/** Images and SVG are shown as images, the rest as pages. A change between them is warned about (Issue #26). */
function shownAs(contentType: string): "画像" | "HTML" {
	return contentType.startsWith("image/") ? "画像" : "HTML";
}

/** `kumo put <path> --replace <id|url>`: same preprocessing as put, then replace the file's content (specs/005-replace-content). */
async function replaceOne(
	api: AdminApi,
	path: string,
	target: FileDetailResponse,
	options: PutOptions,
	as: As | undefined,
): Promise<PutResult> {
	const ready = await readyToSend(path, options, as);
	const current = target.file;
	// Content that another file has cannot become this file's (FR-007 of 001). Check before sending it.
	if (ready.sha256 !== current.sha256) {
		const existing = await findExisting(api, ready.sha256);
		if (existing && existing.id !== current.id) throw duplicateContent(existing.id);
	}
	const response = await sendReplacement(api, current, ready);

	const warnings = [...ready.warnings];
	const before = shownAs(response.previous.contentType);
	const after = shownAs(response.file.contentType);
	if (response.replaced && before !== after) {
		warnings.push(`形式の種類が変わりました（${before} → ${after}）。同じリンクを開いた人には、${after}として表示されます。`);
	}
	const result: PutResult & { file: FileSummary; links: Link[] } = {
		path,
		kind: ready.kind,
		warnings,
		file: response.file,
		replaced: response.replaced,
		previous: response.previous,
		purge: response.purge,
		links: target.links.filter((l) => l.revokedAt === null),
	};
	await tagAndLink(api, result, options);
	if (result.link) result.links = [result.link, ...result.links];
	return result;
}

function describe(result: PutResult): string[] {
	if (!result.file) return [];
	const { file } = result;
	const kind = result.kind ? `  ${KIND_LABELS[result.kind]}` : "";
	if (result.replaced !== undefined) return describeReplacement(result, file, kind);
	const lines = [
		`${file.id}  ${file.name}  ${formatBytes(file.size)}${kind}${result.duplicate ? "  （重複: 既存のファイルを使用）" : ""}`,
	];
	if (result.link) lines.push(`  リンク: ${result.link.url}`);
	return lines;
}

function describeReplacement(result: PutResult, file: FileSummary, kind: string): string[] {
	const size = formatBytes(file.size);
	let state = "内容が同じため、置き換えていません";
	if (result.replaced) state = "置き換えました";
	else if (result.purge?.ok) state += "（キャッシュの削除だけをやり直しました）";
	const names = result.replaced && result.previous ? `${result.previous.name} → ${file.name}` : file.name;
	const lines = [`${file.id}  ${names}  ${size}${kind}  ${state}`];
	const links = result.links ?? [];
	for (const link of links) lines.push(`  リンク: ${link.url}${link.label ? `  ${link.label}` : ""}`);
	if (links.length === 0) lines.push("  有効なリンクはありません。");
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

/** A failed purge after --replace: the replacement stays, the same command retries it (like kumo link revoke). */
function purgeFailure(result: PutResult): string | undefined {
	if (!result.file || !result.purge || result.purge.ok) return undefined;
	const done = result.replaced ? "の置き換えは完了しましたが、" : "の";
	return (
		`${result.file.id} ${done}配信側のキャッシュ削除に失敗しました（${result.purge.error}）。` +
		"同じコマンドで削除をやり直せます。やり直さなくても、1 時間以内にすべてのリンクが新しい内容になります。"
	);
}

/** `kumo put`: see contracts/cli.md of 001 and 002, and specs/005-replace-content for --replace. */
export async function put(runtime: Runtime, paths: string[], options: PutOptions): Promise<number> {
	if (options.tag) parseTagChanges(options.tag.map((t) => `+${t}`)); // reject bad tags before uploading
	const as = parseAs(options.as);
	let replaceTarget: ReplaceTarget | undefined;
	if (options.replace !== undefined) {
		if (paths.length !== 1) {
			throw new CliError(`--replace では、置き換える内容のファイルを 1 つだけ指定してください（${paths.length} 個あります）。`, {
				hint: "例: kumo put guide.html --replace <ファイル ID かリンクの URL>",
				code: "invalid_argument",
				exitCode: EXIT_USAGE,
			});
		}
		replaceTarget = parseReplaceTarget(options.replace);
	}
	const api = await runtime.api();
	// With --replace, find the file (and its current SHA-256 for If-Match) before reading anything.
	const target = replaceTarget ? await resolveTarget(api, replaceTarget) : undefined;
	const results: PutResult[] = [];
	try {
		for (const path of paths) {
			try {
				const result = target ? await replaceOne(api, path, target, options, as) : await putOne(api, path, options, as);
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
	const purgeFailures = results.map(purgeFailure).filter((message) => message !== undefined);
	const summary = summarize(results);
	const human = results.flatMap(describe);
	if (paths.length > 1) human.push(describeSummary(summary));
	if (failed.length > 0) human.push(`失敗: ${failed.length} 件（${failed.map((r) => r.path).join("、")}）`);
	printResult(runtime.out, human, { results, summary });
	for (const message of purgeFailures) printWarning(runtime.out, message);
	return failed.length > 0 || purgeFailures.length > 0 ? 1 : 0;
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
		.option(
			"--replace <id|url>",
			"置いたファイルの中身を、このファイルで置き換える（ファイル ID かリンクの URL で指定。URL は変わらない。パスは 1 つだけ）",
		)
		.action(wrap(async (runtime, paths, options) => put(runtime, paths as string[], options as PutOptions)));
};
