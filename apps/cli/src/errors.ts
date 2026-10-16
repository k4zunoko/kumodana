/** Exit codes (contracts/cli.md): 0 success, 1 operation failed, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** An error the CLI reports as「何が起きたか＋どうすればよいか＋エラーコード」. */
export class CliError extends Error {
	readonly hint: string | undefined;
	readonly code: string;
	readonly exitCode: number;
	readonly details: Record<string, unknown> | undefined;

	constructor(
		message: string,
		options: { hint?: string; code?: string; exitCode?: number; details?: Record<string, unknown> } = {},
	) {
		super(message);
		this.hint = options.hint;
		this.code = options.code ?? "cli_error";
		this.exitCode = options.exitCode ?? EXIT_FAILED;
		this.details = options.details;
	}
}
