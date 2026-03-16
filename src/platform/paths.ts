import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Normalizes a relative path by converting all backslashes to forward slashes.
 * Ensures consistent POSIX-style paths regardless of the source platform.
 *
 * @param relativePath - The path to normalize
 * @returns Path with all backslashes replaced by forward slashes
 */
export function normalizePath(relativePath: string): string {
	return relativePath.replaceAll("\\", "/");
}

/**
 * Returns the user's home directory.
 */
export function getHomeDir(): string {
	return os.homedir();
}

/**
 * Returns the path to the ~/.claude directory.
 */
export function getClaudeDir(): string {
	return path.join(getHomeDir(), ".claude");
}

/**
 * Returns the path to the OpenCode config directory.
 * Respects XDG_CONFIG_HOME if set.
 */
export function getOpenCodeConfigDir(): string {
	const xdgConfig = process.env.XDG_CONFIG_HOME;
	const base = xdgConfig || path.join(getHomeDir(), ".config");
	return path.join(base, "opencode");
}

/**
 * Returns the path to the sync repo directory.
 * Uses a custom path if provided, otherwise defaults to ~/.ai-sync.
 * Falls back to ~/.claude-sync if it exists (migration from claude-sync).
 */
export function getSyncRepoDir(customPath?: string): string {
	if (customPath) return customPath;
	const newPath = path.join(getHomeDir(), ".ai-sync");
	const oldPath = path.join(getHomeDir(), ".claude-sync");
	// Use old path if it exists and new path doesn't
	if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
		return oldPath;
	}
	return newPath;
}

/**
 * Resolves the ai-sync install directory by walking up from the
 * currently running script until we find a directory that is both
 * a git repo and contains a package.json with name "ai-sync".
 */
export function getInstallDir(): string {
	// Check environment variables first
	const envDir = process.env.AI_SYNC_INSTALL_DIR ?? process.env.CLAUDE_SYNC_INSTALL_DIR;
	if (envDir) return envDir;

	const thisFile = fileURLToPath(import.meta.url);
	let dir = path.dirname(thisFile);

	for (let i = 0; i < 5; i++) {
		const pkgPath = path.join(dir, "package.json");
		const gitDir = path.join(dir, ".git");
		if (fs.existsSync(pkgPath) && fs.existsSync(gitDir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "ai-sync" || pkg.name === "claude-sync") return dir;
			} catch {
				// malformed package.json, keep searching
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	throw new Error("Could not find ai-sync install directory");
}
