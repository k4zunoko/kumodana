import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Output } from "../src/output.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";

export const SECRET = "super-secret-value-1234";

export type Captured = { stdout: string[]; stderr: string[] };

export function captureOutput(json = false): { out: Output; captured: Captured } {
	const captured: Captured = { stdout: [], stderr: [] };
	const out: Output = {
		json,
		stdout: (t) => captured.stdout.push(t),
		stderr: (t) => captured.stderr.push(t),
		secrets: [],
	};
	return { out, captured };
}

export type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;

/** A local HTTP server that stands in for the admin API. */
export async function mockApi(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		await handler(req, Buffer.concat(chunks), res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export function testRuntime(url: string, json = false): { runtime: Runtime; captured: Captured } {
	const { out, captured } = captureOutput(json);
	const runtime = createRuntime({
		json,
		out,
		loadConfig: async () => ({ adminUrl: url, clientId: "cli-id.access", clientSecret: SECRET }),
	});
	return { runtime, captured };
}

export function allOutput(captured: Captured): string {
	return [...captured.stdout, ...captured.stderr].join("\n");
}
