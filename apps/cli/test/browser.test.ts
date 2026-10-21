import { describe, expect, it } from "vitest";
import { openerCommand } from "../src/browser.ts";

const URL_WITH_AMPERSANDS =
	"https://team.example.invalid/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback&state=s&code_challenge=x&code_challenge_method=S256";

describe("opening the browser (research L7)", () => {
	it("passes the URL as one argument, never through a shell", () => {
		expect(openerCommand(URL_WITH_AMPERSANDS, "win32")).toEqual([
			"rundll32.exe",
			["url.dll,FileProtocolHandler", URL_WITH_AMPERSANDS],
		]);
		expect(openerCommand(URL_WITH_AMPERSANDS, "darwin")).toEqual(["open", [URL_WITH_AMPERSANDS]]);
		expect(openerCommand(URL_WITH_AMPERSANDS, "linux")).toEqual(["xdg-open", [URL_WITH_AMPERSANDS]]);
	});
});
