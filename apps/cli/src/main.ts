import { Command, CommanderError } from "commander";
import { commands } from "./commands/index.ts";
import { EXIT_USAGE } from "./errors.ts";
import { createRuntime, runCommand } from "./runtime.ts";

const program = new Command("kumo")
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
	if (error instanceof CommanderError) {
		const ok = error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help";
		process.exitCode = ok ? 0 : EXIT_USAGE;
	} else {
		throw error;
	}
}
