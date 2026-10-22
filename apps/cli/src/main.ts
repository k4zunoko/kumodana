import { Command, CommanderError } from "commander";
import { commands } from "./commands/index.ts";
import { CliError, EXIT_USAGE } from "./errors.ts";
import { createOutput, printError } from "./output.ts";
import { createRuntime, runCommand } from "./runtime.ts";

/** With --json, a usage error Commander finds is thrown as a CliError, so it is printed as JSON without the English text and help. */
class KumoCommand extends Command {
	override createCommand(name?: string): Command {
		return new KumoCommand(name);
	}

	override error(message: string, options?: { code?: string; exitCode?: number }): never {
		// Commander reads the options of kumo itself, wherever they are, before it reports any usage error.
		if (this.optsWithGlobals().json !== true) return super.error(message, options);
		const names: string[] = [];
		for (let command: Command | null = this; command?.parent; command = command.parent) names.unshift(command.name());
		throw new CliError(message.replace(/^error: /, ""), {
			code: "usage_error",
			hint: `${["kumo", ...names, "--help"].join(" ")} で使い方を確認してください。`,
			exitCode: EXIT_USAGE,
		});
	}
}

const program = new KumoCommand("kumo")
	.description("kumodana（雲棚）: 画像、HTML、Markdown 文書を置いてリンクで共有する、自分専用の棚")
	.version("0.1.0")
	.option("--json", "結果を JSON で出力する")
	.addHelpText(
		"after",
		"\n初めて使うときは、kumo login <管理用 Worker の URL> でブラウザからログインする。" +
			"\n使われる資格情報は kumo login --status で確かめられる。手順は docs/runbook.md §7 を参照。" +
			"\n\n--json はすべてのコマンドで使える（コマンドの前でも後でもよい）。結果は標準出力に JSON で書き、" +
			'\nエラーは標準エラー出力に {"error":{"code":…,"message":…,"hint":…}} の形で書く。' +
			"\n終了コード: 0 成功、1 操作の失敗（API のエラー、通信の失敗、一部の失敗を含む）、" +
			"\n2 使い方の誤り（引数の不足、ローカルでの検証失敗）",
	)
	// Subcommands copy these settings when they are created, so they come before the commands are registered.
	.configureHelp({ showGlobalOptions: true })
	.showHelpAfterError()
	.exitOverride();

for (const register of commands) {
	register(program, (body) => async (...args: unknown[]) => {
		const runtime = createRuntime({ json: program.opts().json === true });
		process.exitCode = await runCommand(runtime, () => body(runtime, ...args));
	});
}

try {
	await program.parseAsync(process.argv);
} catch (error) {
	if (error instanceof CliError) {
		process.exitCode = printError(createOutput(true), error);
	} else if (error instanceof CommanderError) {
		const ok = error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help";
		process.exitCode = ok ? 0 : EXIT_USAGE;
	} else {
		throw error;
	}
}
