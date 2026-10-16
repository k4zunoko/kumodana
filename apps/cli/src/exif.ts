import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { exiftool } from "exiftool-vendored";

export type StrippedCopy = { path: string; cleanup: () => Promise<void> };

/**
 * Copies the file to a temp directory and removes its metadata there (FR-004, FR-005, research R9).
 * Orientation and the ICC profile are kept so the image still displays correctly.
 * The original file is only read.
 */
export async function stripMetadata(originalPath: string): Promise<StrippedCopy> {
	const dir = await mkdtemp(join(tmpdir(), "kumodana-"));
	const cleanup = () => rm(dir, { recursive: true, force: true });
	try {
		const path = join(dir, basename(originalPath));
		await copyFile(originalPath, path);
		await exiftool.deleteAllTags(path, { retain: ["Orientation", "ICC_Profile"] });
		return { path, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

let ended = false;

/** Stops the exiftool child process so the CLI can exit. */
export async function endExiftool(): Promise<void> {
	if (ended) return;
	ended = true;
	await exiftool.end();
}
