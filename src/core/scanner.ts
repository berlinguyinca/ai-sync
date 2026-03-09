import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath } from "../platform/paths.js";
import { isPathAllowed } from "./manifest.js";

/**
 * Scans a source directory and returns all files that match the sync manifest allowlist.
 *
 * @param sourceDir - Absolute path to the directory to scan (typically ~/.claude)
 * @returns Sorted array of relative paths (relative to sourceDir) for allowed files
 * @throws Error if sourceDir does not exist
 */
export async function scanDirectory(sourceDir: string): Promise<string[]> {
	// Verify source directory exists
	try {
		await fs.access(sourceDir);
	} catch {
		throw new Error(`Source directory does not exist: ${sourceDir}`);
	}

	// Recursively read directory (Node 22 feature)
	const entries = await fs.readdir(sourceDir, { recursive: true, withFileTypes: true });

	const allowedFiles: string[] = [];

	for (const entry of entries) {
		// Only include files, not directories
		if (!entry.isFile()) {
			continue;
		}

		// Build relative path from the entry
		// entry.parentPath is absolute, so we compute relative from sourceDir
		const relativePath = normalizePath(
			path.relative(sourceDir, path.join(entry.parentPath, entry.name)),
		);

		// Skip files inside .git directories (cloned plugin repos, etc.)
		if (relativePath.includes(".git/") || relativePath.startsWith(".git")) {
			continue;
		}

		if (isPathAllowed(relativePath)) {
			allowedFiles.push(relativePath);
		}
	}

	return allowedFiles.sort();
}
