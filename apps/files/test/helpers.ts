import { env } from "cloudflare:workers";

export async function resetStorage(): Promise<void> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM links"),
		env.DB.prepare("DELETE FROM file_tags"),
		env.DB.prepare("DELETE FROM files"),
	]);
	const listed = await env.BUCKET.list();
	if (listed.objects.length > 0) await env.BUCKET.delete(listed.objects.map((o) => o.key));
}

type Seed = {
	id: string;
	body?: string;
	name?: string;
	contentType?: string;
	status?: "pending" | "ready" | "deleting";
	withObject?: boolean;
	links?: { token: string; revoked?: boolean }[];
	/** The R2 key. `files/<id>` unless given (a replaced file has another key, specs/005-replace-content). */
	r2Key?: string;
	sha256?: string;
};

export async function seed(file: Seed): Promise<void> {
	const body = file.body ?? `content-${file.id}`;
	const now = Date.now();
	const r2Key = file.r2Key ?? `files/${file.id}`;
	await env.DB.prepare(
		`INSERT INTO files (id, r2_key, name, content_type, size, sha256, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			file.id,
			r2Key,
			file.name ?? `${file.id}.png`,
			file.contentType ?? "image/png",
			new TextEncoder().encode(body).length,
			file.sha256 ?? file.id.padEnd(64, "0"),
			file.status ?? "ready",
			now,
			now,
		)
		.run();
	if (file.withObject !== false) {
		await env.BUCKET.put(r2Key, body, { httpMetadata: { contentType: file.contentType ?? "image/png" } });
	}
	for (const link of file.links ?? []) {
		await env.DB.prepare("INSERT INTO links (token, file_id, label, created_at, revoked_at) VALUES (?, ?, NULL, ?, ?)")
			.bind(link.token, file.id, now, link.revoked ? now : null)
			.run();
	}
}

export const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAA";
export const TOKEN_B = "BBBBBBBBBBBBBBBBBBBBBB";
export const TOKEN_C = "CCCCCCCCCCCCCCCCCCCCCC";
export const TOKEN_D = "DDDDDDDDDDDDDDDDDDDDDD";
export const TOKEN_UNKNOWN = "ZZZZZZZZZZZZZZZZZZZZZZ";
