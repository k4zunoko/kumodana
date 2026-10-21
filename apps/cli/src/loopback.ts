import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Listen } from "./context.ts";
import { CliError } from "./errors.ts";
import { clean } from "./oauth.ts";

/** Receives the browser's redirect on 127.0.0.1 (specs/003-cli-login research L6). */
export type CallbackServer = {
	redirectUri: string;
	/** Resolves with the authorization code, or rejects with `login_denied` / `login_timeout`. */
	waitForCode: (timeoutMs: number) => Promise<string>;
	close: () => Promise<void>;
};

const listenOnLoopback: Listen = (server) =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve((server.address() as AddressInfo).port);
		});
	});

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(res: ServerResponse, status: number, title: string, message: string): void {
	const body =
		`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
		`<meta name="viewport" content="width=device-width, initial-scale=1">` +
		`<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;line-height:1.7}</style>` +
		`</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

type Outcome = { code: string } | { error: CliError };

/**
 * Listens on a free port of 127.0.0.1 and accepts only `GET /callback` with `Host: 127.0.0.1:<port>`. A wrong
 * `state` gets an error page and the wait goes on, so a stale tab or another page cannot end the login.
 */
export async function startCallbackServer(state: string, listen: Listen = listenOnLoopback): Promise<CallbackServer> {
	let outcome: Outcome | undefined;
	let notify: (() => void) | undefined;
	let host = "";

	const settle = (result: Outcome) => {
		outcome = result;
		notify?.();
	};

	const handle = (req: IncomingMessage, res: ServerResponse) => {
		if (req.headers.host !== host) {
			page(res, 400, "受け付けられません", "この要求は受け付けられません。");
			return;
		}
		const url = new URL(req.url ?? "/", `http://${host}`);
		if (req.method !== "GET" || url.pathname !== "/callback") {
			page(res, 404, "見つかりません", "このページはありません。");
			return;
		}
		if (outcome) {
			page(res, 400, "終わっています", "このログインは、もう終わっています。");
			return;
		}
		if (!sameText(url.searchParams.get("state") ?? "", state)) {
			page(
				res,
				400,
				"このログインの応答ではありません",
				"この応答は、いま実行中の kumo login のものではありません。ターミナルに表示された URL を開き直してください。",
			);
			return;
		}
		const error = url.searchParams.get("error");
		if (error !== null) {
			const name = clean(error, 64) ?? "error";
			const description = clean(url.searchParams.get("error_description"));
			page(res, 400, "ログインできませんでした", "ターミナルに戻って、表示された案内を確かめてください。");
			settle({
				error: new CliError(`ログインが拒否されました（${name}${description ? `: ${description}` : ""}）。`, {
					code: "login_denied",
					hint: "所有者のアカウントでログインしたか確かめてから、もう一度 kumo login を実行してください。",
				}),
			});
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			page(res, 400, "応答に必要な値がありません", "ターミナルに表示された URL を開き直してください。");
			return;
		}
		page(res, 200, "ログインしました", "kumo に戻ってください。このタブは閉じてかまいません。");
		settle({ code });
	};

	const server: Server = createServer(handle);
	let port: number;
	try {
		port = await listen(server);
	} catch (error) {
		server.close();
		const reason = error instanceof Error ? error.message : String(error);
		throw new CliError(`ログインの結果を受け取る口（127.0.0.1）を用意できませんでした: ${reason}`, {
			code: "callback_unavailable",
		});
	}
	host = `127.0.0.1:${port}`;

	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeIdleConnections();
			// A browser may keep its connection open; do not let it hold the CLI.
			setTimeout(() => server.closeAllConnections(), 1000).unref();
		});
	};

	const waitForCode = (timeoutMs: number) =>
		new Promise<string>((resolve, reject) => {
			const finish = () => {
				clearTimeout(timer);
				notify = undefined;
				if (!outcome) return;
				if ("code" in outcome) resolve(outcome.code);
				else reject(outcome.error);
			};
			const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
			const timer = setTimeout(() => {
				notify = undefined;
				reject(
					new CliError(`${minutes} 分以内にブラウザからの応答がありませんでした。`, {
						code: "login_timeout",
						hint:
							"所有者のアカウントでログインしたか確かめて、もう一度 kumo login を実行してください。" +
							"ブラウザにクライアント（client）のエラーが表示された場合は、この PC の登録が使えなくなっています。" +
							"login.json を削除してから kumo login を実行してください。",
					}),
				);
			}, timeoutMs);
			notify = finish;
			if (outcome) finish();
		});

	return { redirectUri: `http://${host}/callback`, waitForCode, close };
}
