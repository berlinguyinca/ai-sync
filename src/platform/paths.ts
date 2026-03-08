import * as os from "node:os";
import * as path from "node:path";

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
 * Returns the path to the sync repo directory.
 * Uses a custom path if provided, otherwise defaults to ~/.claude-sync.
 */
export function getSyncRepoDir(customPath?: string): string {
	return customPath ?? path.join(getHomeDir(), ".claude-sync");
}
