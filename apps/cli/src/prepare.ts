import type { AllowedContentType } from "@kumodana/shared/limits";
import { MAX_FILE_BYTES } from "@kumodana/shared/limits";
import { CliError, EXIT_USAGE } from "./errors.ts";
import { renderMarkdown, renderText, sharedName } from "./markdown.ts";
import { formatBytes } from "./output.ts";
import { AS_VALUES, type As, type Kind, sniff } from "./sniff.ts";
import { extensionWarning, jsonWarning } from "./warnings.ts";

/**
 * Turns a file's bytes into what `kumo put` sends and `kumo preview` shows (specs/002-markdown-share
 * contracts/cli.md): images, SVG, and HTML as they are; Markdown documents and text converted to HTML.
 */

export type Prepared = {
	kind: Kind;
	contentType: AllowedContentType;
	/** The bytes to send. For images and SVG, metadata is still to be removed by `kumo put`. */
	data: Uint8Array;
	/** The name on the shelf. */
	name: string;
	warnings: string[];
};

export const KIND_LABELS: Record<Kind, string> = {
	image: "画像",
	svg: "SVG",
	html: "HTML",
	markdown: "Markdown → HTML",
	text: "テキスト → HTML",
};

/** Validates `--as` (FR-006). */
export function parseAs(value: string | undefined): As | undefined {
	if (value === undefined) return undefined;
	if ((AS_VALUES as readonly string[]).includes(value)) return value as As;
	throw new CliError(`--as には markdown か text を指定してください: ${value}`, {
		code: "invalid_argument",
		exitCode: EXIT_USAGE,
	});
}

export function prepare(bytes: Uint8Array, name: string, as: As | undefined): Prepared {
	const sniffed = sniff(bytes, as ? { as } : {});
	if (!sniffed.ok) {
		throw new CliError(sniffed.reason, { code: sniffed.code, ...(sniffed.hint ? { hint: sniffed.hint } : {}) });
	}
	const warnings: string[] = [];
	const extension = extensionWarning(name, sniffed.kind, as !== undefined);
	if (extension) warnings.push(extension);

	if ("contentType" in sniffed) {
		return { kind: sniffed.kind, contentType: sniffed.contentType, data: bytes, name, warnings };
	}

	let rendered;
	if (sniffed.kind === "markdown") {
		if (!as) {
			const json = jsonWarning(sniffed.text);
			if (json) warnings.push(json);
		}
		rendered = renderMarkdown(sniffed.text, { fallbackTitle: name });
	} else {
		rendered = renderText(sniffed.text, { title: name });
	}
	warnings.push(...rendered.warnings);
	if (rendered.html.length > MAX_FILE_BYTES) {
		throw new CliError(`変換後の HTML が大きすぎます（${formatBytes(rendered.html.length)}）。100MB 未満にしてください。`, {
			code: "file_too_large",
		});
	}
	return {
		kind: sniffed.kind,
		contentType: "text/html; charset=utf-8",
		data: rendered.html,
		name: sharedName(name),
		warnings,
	};
}
