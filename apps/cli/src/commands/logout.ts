import type { Command } from "commander";
import { loginFilePath, readConfigFile } from "../config.ts";
import { hasConfigServiceToken, hasEnvServiceToken } from "../credentials.ts";
import { CliError, EXIT_USAGE } from "../errors.ts";
import { type LoginRecord, readLogin, writeLogin } from "../login-store.ts";
import { revokeToken } from "../oauth.ts";
import { printError, printResult, printWarning } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Register } from "./index.ts";

const REVOKE_HINT =
	"取り消すには、npx cf zero-trust access applications revoke-tokens <app-id>（このアプリのすべての許可）か、" +
	"npx cf zero-trust access users revoke --email <所有者のメールアドレス>（所有者のすべてのセッション）を実行してください。" +
	"どちらも、ほかの PC の許可も消します（docs/runbook.md §7）。";

/**
 * `kumo logout` (specs/003-cli-login contracts/cli.md, research L12): revoke this PC's grant, then clear the
 * session from login.json whether or not the revocation worked. The URL and the registration stay.
 */
export async function logout(runtime: Runtime): Promise<number> {
	const { ctx, out } = runtime;
	const path = loginFilePath(ctx.env, ctx.platform);
	let record: LoginRecord | undefined;
	try {
		record = await readLogin(path, ctx.urls, ctx.loginFs);
	} catch (error) {
		if (error instanceof CliError && error.code === "login_invalid") {
			throw new CliError(error.message, {
				code: "login_invalid",
				hint: `この記録からは許可を取り消せません。${path} は削除してかまいません。${REVOKE_HINT}`,
				exitCode: EXIT_USAGE,
			});
		}
		throw error;
	}

	const session = record?.session;
	if (!record || !session) {
		printResult(out, "ログインしていません。", { loggedOut: false, revoked: false, adminUrl: null });
		return 0;
	}
	out.secrets.push(session.accessToken, session.refreshToken);

	let revokeError: unknown;
	try {
		await revokeToken(record.endpoints.revocation, { token: session.refreshToken, clientId: record.client.clientId }, ctx.fetchImpl);
	} catch (error) {
		revokeError = error;
	}

	try {
		await writeLogin(path, { ...record, session: null }, ctx.loginFs);
	} catch (error) {
		const reason = error instanceof CliError ? String(error.details?.errno ?? error.code) : String(error);
		throw new CliError(`ログインの記録から資格情報を消せませんでした（${reason}）: ${path}`, {
			code: "login_write_failed",
			hint: revokeError
				? `許可も取り消せていません。${path} を削除してください。${REVOKE_HINT}`
				: `許可は取り消しました。${path} を削除してください。`,
		});
	}

	if (hasEnvServiceToken(ctx.env)) {
		printWarning(
			out,
			"環境変数 KUMODANA_CLIENT_ID・KUMODANA_CLIENT_SECRET があるため、今後もそのサービストークンで管理操作が行われます。",
		);
	} else {
		const file = await readConfigFile(ctx.env, ctx.platform).catch(() => ({}) as Record<string, unknown>);
		if (hasConfigServiceToken(file)) printWarning(out, "今後は config.json のサービストークンで管理操作が行われます。");
	}

	const revoked = revokeError === undefined;
	printResult(
		out,
		revoked
			? `ログアウトしました: ${record.adminUrl}（この PC の許可を取り消しました）`
			: `ログアウトしました: ${record.adminUrl}（この PC の資格情報を消しました。許可は取り消せていません）`,
		{ loggedOut: true, revoked, adminUrl: record.adminUrl },
	);
	if (revoked) return 0;

	// Like `kumo rm` when the cache purge fails: the work is done, then exit code 1 (review item 10).
	const reason = revokeError instanceof Error ? revokeError.message : String(revokeError);
	return printError(
		out,
		new CliError(`この PC の許可を取り消せませんでした（${reason}）。許可は期間が切れるまで有効です。`, {
			code: "revoke_failed",
			hint: REVOKE_HINT,
		}),
	);
}

export const registerLogout: Register = (program: Command, wrap) => {
	program
		.command("logout")
		.description("この PC の許可を取り消し、保存したトークンを消す")
		.action(wrap(async (runtime) => logout(runtime)));
};
