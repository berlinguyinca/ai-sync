import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

/** Lists entries of a directory, sorted; empty if it cannot be read. */
export async function listDir(dir: string) {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/**
 * Recursively yields every path under `dir` (files, dirs and symlinks) without
 * following symlinks. Skips node_modules and .git.
 */
export async function* walk(dir: string, maxDepth = 12): AsyncGenerator<string> {
	if (maxDepth < 0) return;
	for (const entry of await listDir(dir)) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const full = path.join(dir, entry.name);
		yield full;
		if (entry.isDirectory()) yield* walk(full, maxDepth - 1);
	}
}

/** True if `p` is a symlink whose target does not exist. */
export async function isBrokenSymlink(p: string): Promise<boolean> {
	try {
		const l = await fs.lstat(p);
		if (!l.isSymbolicLink()) return false;
		await fs.stat(p);
		return false;
	} catch (err) {
		return (
			(err as NodeJS.ErrnoException).code === "ENOENT" ||
			(err as NodeJS.ErrnoException).code === "ELOOP"
		);
	}
}

export function rel(configDir: string, p: string): string {
	return path.relative(configDir, p).split(path.sep).join("/");
}
