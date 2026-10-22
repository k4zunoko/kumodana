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
			"\n使われる資格情報は kumo login --status で確かめられる。手順は docs/runbook.md §7 を参照。",
	)
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
