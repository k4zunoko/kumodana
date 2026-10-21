import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import type { Command } from "commander";
import { windowsDir } from "../browser.ts";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { formatBytes, printResult, printWarning } from "../output.ts";
import { KIND_LABELS, parseAs, prepare } from "../prepare.ts";
import type { Runtime } from "../runtime.ts";
import { asOption, readSource } from "./put.ts";
import type { Register } from "./index.ts";

export type PreviewOptions = {
	as?: string;
	output?: string;
	/** `--no-open` sets this to false. */
	open?: boolean;
	cwd?: string;
};

/** Opens a file with the default browser. */
export type Opener = (path: string) => Promise<void>;

/**
 * The platform's opener for a file. On Windows it is started by absolute path (`%SystemRoot%\explorer.exe`), not by a
 * bare name that Windows would first look up in the current folder (CWE-427).
 */
export function fileOpenerCommand(
	path: string,
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): [string, string[]] {
	if (platform === "win32") return [win32.join(windowsDir(env), "explorer.exe"), [path]];
	if (platform === "darwin") return ["open", [path]];
	return ["xdg-open", [path]];
}

/** Starts the platform's opener without a shell, so that `&` and similar characters in paths are harmless. */
export const openInBrowser: Opener = (path) => {
	const [command, args] = fileOpenerCommand(path);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolvePromise();
		});
	});
};

/**
 * `kumo preview <path>`: the same detection and conversion as `kumo put`, without the admin API (FR-021,
 * specs/002-markdown-share contracts/cli.md).
 */
export async function preview(
	runtime: Runtime,
	path: string,
	options: PreviewOptions,
	opener: Opener = openInBrowser,
): Promise<number> {
	const as = parseAs(options.as);
	const prepared = prepare(await readSource(path), basename(path), as);
	if (!runtime.out.json) for (const warning of prepared.warnings) printWarning(runtime.out, warning);
	const label = `形式: ${KIND_LABELS[prepared.kind]}`;

	if (prepared.kind !== "markdown" && prepared.kind !== "text") {
		printResult(runtime.out, [label, "変換は不要です。このファイルはそのまま置かれます。"], {
			kind: prepared.kind,
			path: null,
			size: null,
			opened: false,
			warnings: prepared.warnings,
		});
		return 0;
	}

	let target: string;
	let open = options.open !== false;
	if (options.output) {
		open = false;
		target = resolve(options.cwd ?? ".", options.output);
		try {
			await writeFile(target, prepared.data, { flag: "wx" });
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
	} else {
		target = join(await mkdtemp(join(tmpdir(), "kumo-preview-")), prepared.name);
		await writeFile(target, prepared.data);
	}

	if (open) {
		try {
			await opener(target);
		} catch (error) {
			throw new CliError(`ブラウザを開けませんでした（${error instanceof Error ? error.message : String(error)}）。`, {
				hint: `変換した結果は ${target} にあります。`,
				code: "open_failed",
			});
		}
	}
	printResult(runtime.out, [label, `${target}（${formatBytes(prepared.data.length)}）`], {
		kind: prepared.kind,
		path: target,
		size: prepared.data.length,
		opened: open,
		warnings: prepared.warnings,
	});
	return 0;
}

export const registerPreview: Register = (program: Command, wrap) => {
	program
		.command("preview")
		.description("置く前に、変換の結果をブラウザで確かめる（管理 API は使わない）")
		.argument("<path>", "確かめるファイル")
		.addOption(asOption())
		.option("-o, --output <path>", "ブラウザで開かず、指定した場所に保存する（上書きはしない）")
		.option("--no-open", "ブラウザで開かない")
		.action(wrap(async (runtime, path, options) => preview(runtime, path as string, options as PreviewOptions)));
};
