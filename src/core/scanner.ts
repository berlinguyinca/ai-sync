import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath } from "../platform/paths.js";
import { isPathAllowed } from "./manifest.js";

/**
 * Allowlist predicate. May carry an `isIgnored` predicate (ignore patterns only,
 * without the allowlist) used to vet the targets of symlinked files.
 */
export type AllowlistFn = ((relativePath: string) => boolean) & {
	isIgnored?: (relativePath: string) => boolean;
};

/**
 * Scans a source directory and returns all files that match the allowlist.
 *
 * Follows symlinks to both files and directories so that e.g.
 * `commands/gw -> /external/path` is included. Tracks visited real
 * paths to prevent infinite cycles from circular symlinks.
 *
 * @param sourceDir - Absolute path to the directory to scan
 * @param allowlistFn - Optional custom allowlist function. Defaults to isPathAllowed().
 * @returns Sorted array of relative paths (relative to sourceDir) for allowed files
 * @throws Error if sourceDir does not exist
 */
export async function scanDirectory(
	sourceDir: string,
	allowlistFn?: AllowlistFn,
): Promise<string[]> {
	const checkAllowed = allowlistFn ?? isPathAllowed;

	// Verify source directory exists
	try {
		await fs.access(sourceDir);
	} catch {
		throw new Error(`Source directory does not exist: ${sourceDir}`);
	}

	const allowedFiles: string[] = [];
	// Track visited real paths to prevent symlink cycles
	const visitedDirs = new Set<string>();
	visitedDirs.add(await fs.realpath(sourceDir));

	const rootReal = await fs.realpath(sourceDir);
	await scanDir(sourceDir, "", checkAllowed, allowedFiles, visitedDirs, rootReal);

	return allowedFiles.sort();
}

/**
 * Recursively scans a directory, following symlinks while tracking
 * visited real paths to prevent cycles.
 */
async function scanDir(
	baseDir: string,
	prefix: string,
	checkAllowed: AllowlistFn,
	results: string[],
	visitedDirs: Set<string>,
	rootReal: string,
): Promise<void> {
	const dirPath = prefix ? path.join(baseDir, prefix) : baseDir;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const relativePath = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name);

		// Skip .git directories
		if (
			relativePath.includes(".git/") ||
			relativePath.startsWith(".git") ||
			entry.name === ".git"
		) {
			continue;
		}

		if (entry.isFile()) {
			if (checkAllowed(relativePath)) {
				results.push(relativePath);
			}
		} else if (entry.isDirectory()) {
			await scanDir(baseDir, relativePath, checkAllowed, results, visitedDirs, rootReal);
		} else if (entry.isSymbolicLink()) {
			// Resolve the symlink target
			const fullPath = path.join(dirPath, entry.name);
			let stat: import("node:fs").Stats;
			try {
				stat = await fs.stat(fullPath);
			} catch {
				// Broken symlink, skip
				continue;
			}

			if (stat.isFile()) {
				if (
					checkAllowed(relativePath) &&
					!(await targetIsIgnored(fullPath, rootReal, checkAllowed.isIgnored))
				) {
					results.push(relativePath);
				}
			} else if (stat.isDirectory()) {
				// Prevent cycles: check if we've already visited this real path
				const realPath = await fs.realpath(fullPath);
				if (visitedDirs.has(realPath)) {
					continue;
				}
				if (await dirTargetIsIgnored(realPath, rootReal, checkAllowed.isIgnored)) {
					continue;
				}
				visitedDirs.add(realPath);
				await scanDir(baseDir, relativePath, checkAllowed, results, visitedDirs, rootReal);
			}
		}
	}
}

/**
 * Checks a symlinked file's resolved target against the ignore patterns, so a link
 * such as `extensions/creds -> ../auth.json` cannot smuggle an ignored file into the sync.
 * Checks the target's basename and, when the target lives inside the config dir,
 * its path relative to that dir.
 */
async function targetIsIgnored(
	linkPath: string,
	rootReal: string,
	isIgnored: ((relativePath: string) => boolean) | undefined,
): Promise<boolean> {
	if (!isIgnored) return false;
	let target: string;
	try {
		target = await fs.realpath(linkPath);
	} catch {
		return true;
	}
	if (isIgnored(path.basename(target))) return true;
	const rel = path.relative(rootReal, target);
	if (isInsideRoot(rel)) {
		return isIgnored(normalizePath(rel));
	}
	return false;
}

/** True when `rel` (from path.relative) is a non-empty path that stays inside the root. */
function isInsideRoot(rel: string): boolean {
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Checks a symlinked directory's resolved target against the ignore patterns, so a link
 * such as `extensions/l -> ../logs` cannot smuggle an ignored directory into the sync.
 * Probes `<dir>/x` so directory patterns (`logs/`) match; checks the target's own basename
 * and, when inside the config dir, every segment of its root-relative path.
 */
async function dirTargetIsIgnored(
	realPath: string,
	rootReal: string,
	isIgnored: ((relativePath: string) => boolean) | undefined,
): Promise<boolean> {
	if (!isIgnored) return false;
	if (isIgnored(`${path.basename(realPath)}/x`)) return true;
	const rel = path.relative(rootReal, realPath);
	if (isInsideRoot(rel)) {
		return isIgnored(`${normalizePath(rel)}/x`);
	}
	return false;
}
