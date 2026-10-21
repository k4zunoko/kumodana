import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** Opens a URL with the default browser. */
export type UrlOpener = (url: string) => Promise<void>;

/**
 * The Windows folder. Programs there are started by absolute path: given a bare name, Windows looks in the current
 * folder before PATH, so a file named like the program in that folder would run instead (CWE-427).
 */
export function windowsDir(env: Record<string, string | undefined> = process.env): string {
	const root = env.SystemRoot?.trim();
	return root ? root : String.raw`C:\Windows`;
}

/**
 * The command that opens a URL on each platform (research L7). It is started without a shell, so `&` and other
 * characters in the URL reach the browser as they are (`cmd /c start` would cut the URL at `&`).
 */
export function openerCommand(
	url: string,
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): [string, string[]] {
	if (platform === "win32") {
		return [win32.join(windowsDir(env), "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]];
	}
	if (platform === "darwin") return ["open", [url]];
	return ["xdg-open", [url]];
}

export const openUrl: UrlOpener = (url) => {
	const [command, args] = openerCommand(url);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
};
