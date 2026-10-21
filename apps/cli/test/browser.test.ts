import { describe, expect, it } from "vitest";
import { openerCommand, windowsDir } from "../src/browser.ts";
import { fileOpenerCommand } from "../src/commands/preview.ts";

const URL_WITH_AMPERSANDS =
	"https://team.example.invalid/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&state=s&code_challenge=x&code_challenge_method=S256";

describe("opening the browser (research L7)", () => {
	it("passes the URL as one argument, never through a shell", () => {
		expect(openerCommand(URL_WITH_AMPERSANDS, "darwin")).toEqual(["open", [URL_WITH_AMPERSANDS]]);
		expect(openerCommand(URL_WITH_AMPERSANDS, "linux")).toEqual(["xdg-open", [URL_WITH_AMPERSANDS]]);
	});

	it("starts rundll32.exe by absolute path, so the current folder cannot supply it (CWE-427)", () => {
		expect(openerCommand(URL_WITH_AMPERSANDS, "win32", { SystemRoot: String.raw`D:\WINNT` })).toEqual([
			String.raw`D:\WINNT\System32\rundll32.exe`,
			["url.dll,FileProtocolHandler", URL_WITH_AMPERSANDS],
		]);
		expect(openerCommand(URL_WITH_AMPERSANDS, "win32", {})[0]).toBe(String.raw`C:\Windows\System32\rundll32.exe`);
		expect(windowsDir({ SystemRoot: " " })).toBe(String.raw`C:\Windows`);
	});

	it("does not trust a SystemRoot that is not an absolute path (it would bring back the current-folder lookup)", () => {
		for (const root of ["", " ", "Windows", String.raw`.\Windows`, String.raw`C:Windows`, ".."]) {
			expect(windowsDir({ SystemRoot: root })).toBe(String.raw`C:\Windows`);
			expect(openerCommand("x", "win32", { SystemRoot: root })[0]).toBe(String.raw`C:\Windows\System32\rundll32.exe`);
			expect(fileOpenerCommand("x", "win32", { SystemRoot: root })[0]).toBe(String.raw`C:\Windows\explorer.exe`);
		}
		expect(windowsDir({ SystemRoot: String.raw` D:\WINNT ` })).toBe(String.raw`D:\WINNT`);
	});

	it("starts explorer.exe for kumo preview by absolute path too", () => {
		expect(fileOpenerCommand(String.raw`C:\tmp\a&b.html`, "win32", { SystemRoot: String.raw`C:\Windows` })).toEqual([
			String.raw`C:\Windows\explorer.exe`,
			[String.raw`C:\tmp\a&b.html`],
		]);
		expect(fileOpenerCommand("/tmp/a.html", "darwin")).toEqual(["open", ["/tmp/a.html"]]);
		expect(fileOpenerCommand("/tmp/a.html", "linux")).toEqual(["xdg-open", ["/tmp/a.html"]]);
	});

	it.runIf(process.platform === "win32")("finds the real programs at those paths on this PC", async () => {
		const { access } = await import("node:fs/promises");
		await expect(access(openerCommand("x")[0])).resolves.toBeUndefined();
		await expect(access(fileOpenerCommand("x")[0])).resolves.toBeUndefined();
	});
});
