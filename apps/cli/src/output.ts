import { CliError, EXIT_FAILED } from "./errors.ts";

export type Output = {
	json: boolean;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Values that must never appear in any output (the service-token secret). */
	secrets: string[];
};

export function createOutput(json: boolean, secrets: string[] = []): Output {
	return {
		json,
		stdout: (text) => process.stdout.write(`${text}\n`),
		stderr: (text) => process.stderr.write(`${text}\n`),
		secrets,
	};
}

export function redact(text: string, secrets: string[]): string {
	let result = text;
	for (const secret of secrets) {
		if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
	}
	return result;
}

/** Writes a result: human text in normal mode, `data` as JSON with --json. */
export function printResult(out: Output, human: string | string[], data: unknown): void {
	if (out.json) {
		out.stdout(redact(JSON.stringify(data, null, 2), out.secrets));
	} else {
		const lines = Array.isArray(human) ? human : [human];
		for (const line of lines) out.stdout(redact(line, out.secrets));
	}
}

export function printWarning(out: Output, message: string): void {
	out.stderr(redact(out.json ? JSON.stringify({ warning: message }) : `警告: ${message}`, out.secrets));
}

/** Writes an error to stderr and returns the exit code to use. */
export function printError(out: Output, error: unknown): number {
	const cliError =
		error instanceof CliError
			? error
			: new CliError(error instanceof Error ? error.message : String(error), { code: "unexpected" });
	if (out.json) {
		const body = {
			error: {
				code: cliError.code,
				message: cliError.message,
				...(cliError.hint ? { hint: cliError.hint } : {}),
				...(cliError.details ? { details: cliError.details } : {}),
			},
		};
		out.stderr(redact(JSON.stringify(body), out.secrets));
	} else {
		out.stderr(redact(`エラー: ${cliError.message}`, out.secrets));
		if (cliError.hint) out.stderr(redact(`対処: ${cliError.hint}`, out.secrets));
		out.stderr(`（${cliError.code}）`);
	}
	return cliError.exitCode ?? EXIT_FAILED;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes;
	let unit = "B";
	for (const next of units) {
		if (value < 1000) break;
		value /= 1000;
		unit = next;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

/** Terminal display width: East Asian wide characters and emoji take two columns. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff) ||
			(code >= 0x20000 && code <= 0x3fffd);
		width += wide ? 2 : 1;
	}
	return width;
}
