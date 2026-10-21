import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exiftool } from "exiftool-vendored";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { endExiftool, stripMetadata } from "../src/exif.ts";

afterAll(endExiftool);

const workDirs: string[] = [];

// Remove the working copies. Windows may keep a file busy for a moment (a virus scanner, for example); a folder that
// still cannot be removed is left behind, because cleanup must never fail a test.
afterEach(async () => {
	await Promise.all(
		workDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined)),
	);
});

async function workingCopy(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kumo-exif-test-"));
	workDirs.push(dir);
	const path = join(dir, name);
	await copyFile(new URL(`./fixtures/${name}`, import.meta.url), path);
	return path;
}

describe("stripMetadata", () => {
	it("removes GPS and camera data but keeps orientation and the ICC profile (JPEG)", async () => {
		const original = await workingCopy("gps-rotated.jpg");
		const before = await readFile(original);
		const beforeStat = await stat(original);

		const stripped = await stripMetadata(original);
		try {
			const tags = await exiftool.read(stripped.path);
			expect(tags.GPSLatitude).toBeUndefined();
			expect(tags.Make).toBeUndefined();
			expect(tags.Orientation).toBe(6);
			expect(tags.ProfileDescription).toBe("sRGB IEC61966-2.1");
			expect(stripped.path).not.toBe(original);
		} finally {
			await stripped.cleanup();
		}

		expect(await readFile(original)).toEqual(before);
		expect((await stat(original)).mtimeMs).toBe(beforeStat.mtimeMs);
	});

	it("removes GPS from PNG", async () => {
		const original = await workingCopy("gps.png");
		const stripped = await stripMetadata(original);
		try {
			const tags = await exiftool.read(stripped.path);
			expect(tags.GPSLatitude).toBeUndefined();
		} finally {
			await stripped.cleanup();
		}
	});

	it("deletes its temporary copy on cleanup", async () => {
		const original = await workingCopy("gps-rotated.jpg");
		const stripped = await stripMetadata(original);
		await stripped.cleanup();
		await expect(stat(stripped.path)).rejects.toThrow();
	});

	it("keeps GPS when metadata is kept (the original is uploaded as is)", async () => {
		const original = await workingCopy("gps-rotated.jpg");
		const tags = await exiftool.read(original);
		expect(tags.GPSLatitude).toBeCloseTo(35.681236, 4);
	});
});
