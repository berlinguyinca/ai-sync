/**
 * Default sync targets: the allowlist of files and directories to sync from ~/.claude.
 *
 * Files are matched exactly. Directories (ending with /) match any file nested underneath.
 */
export const DEFAULT_SYNC_TARGETS: readonly string[] = [
	"settings.json",
	"CLAUDE.md",
	"agents/",
	"commands/",
	"hooks/",
	"get-shit-done/",
	"package.json",
	"gsd-file-manifest.json",
	"skills/",
	"rules/",
	"keybindings.json",
] as const;

/**
 * Plugin-specific paths to include in sync.
 * These are checked in addition to DEFAULT_SYNC_TARGETS.
 */
export const PLUGIN_SYNC_PATTERNS: readonly string[] = [
	"plugins/blocklist.json",
	"plugins/known_marketplaces.json",
	"plugins/marketplaces/",
	"plugins/installed_plugins.json",
	"plugins/cache/",
	"plugins/data/",
] as const;

/**
 * Plugin-specific paths to explicitly exclude from sync.
 * These take priority over PLUGIN_SYNC_PATTERNS.
 */
export const PLUGIN_IGNORE_PATTERNS: readonly string[] = [
	"plugins/install-counts-cache.json",
] as const;

/**
 * Repo-level sync targets that live outside any environment subdirectory.
 * These paths are relative to the sync repo root, not to any env subdirectory.
 */
export const REPO_LEVEL_SYNC_TARGETS: readonly string[] = [
	"shared/", // All shared fragments
	"tools/", // Tool manifest directory
] as const;

/**
 * Checks whether a repo-root-relative path is in the repo-level sync targets.
 * Used for paths like "shared/standards/tdd.md" and "tools/manifest.json".
 */
export function isRepoLevelPathAllowed(relativePath: string): boolean {
	for (const target of REPO_LEVEL_SYNC_TARGETS) {
		if (target.endsWith("/") && relativePath.startsWith(target)) return true;
		if (relativePath === target) return true;
	}
	return false;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Matches a relative path against one ignore pattern (case-insensitive).
 *
 * - Pattern ending in "/" with no other "/" (e.g. "logs/", "orch-*\/"): matches a
 *   directory segment at any depth, and everything under it.
 * - Pattern ending in "/" with an inner "/" (e.g. "plugins/cache/"): anchored at the
 *   config root; matches the directory and everything under it.
 * - Pattern containing a "/" elsewhere (e.g. "plugins/x.json"): anchored at the config root.
 * - Pattern without "/" (e.g. "auth.json", "*.bak*"): matched against the file
 *   name at any depth, so secrets nested in a synced directory are still excluded.
 *
 * "*" matches within a single path segment.
 */
function matchesIgnorePattern(relativePath: string, pattern: string): boolean {
	const parts = relativePath.split("/");
	if (pattern.endsWith("/")) {
		const dir = pattern.slice(0, -1);
		const dirRe = globToRegExp(dir);
		if (!dir.includes("/")) {
			// Any directory segment (not the final file name) may match.
			return parts.slice(0, -1).some((segment) => dirRe.test(segment));
		}
		const segments = dir.split("/").length;
		return parts.length > segments && dirRe.test(parts.slice(0, segments).join("/"));
	}
	if (pattern.includes("/")) {
		return globToRegExp(pattern).test(relativePath);
	}
	return globToRegExp(pattern).test(parts[parts.length - 1] ?? "");
}

/**
 * Checks whether a relative path matches any of the ignore patterns.
 * Unlike isPathAllowed, this ignores the allowlist: it only answers "is this excluded?".
 */
export function isPathIgnored(relativePath: string, ignorePatterns: readonly string[]): boolean {
	return ignorePatterns.some((pattern) => matchesIgnorePattern(relativePath, pattern));
}

/**
 * Checks whether a relative path is allowed by the sync manifest.
 *
 * Allowlist behavior: only known paths are included, everything else is rejected.
 * Ignore patterns take priority over sync patterns.
 *
 * Accepts optional custom lists for environment-specific allowlists.
 * Falls back to the defaults (Claude Code targets) when not provided.
 */
export function isPathAllowed(
	relativePath: string,
	syncTargets?: readonly string[],
	pluginPatterns?: readonly string[],
	ignorePatterns?: readonly string[],
): boolean {
	const targets = syncTargets ?? DEFAULT_SYNC_TARGETS;
	const plugins = pluginPatterns ?? PLUGIN_SYNC_PATTERNS;
	const ignores = ignorePatterns ?? PLUGIN_IGNORE_PATTERNS;

	// Check ignore patterns first (these always win)
	if (isPathIgnored(relativePath, ignores)) {
		return false;
	}

	// Check sync targets
	for (const target of targets) {
		if (target.endsWith("/")) {
			// Directory target: match any file nested under it
			if (relativePath.startsWith(target)) {
				return true;
			}
		} else {
			// File target: exact match
			if (relativePath === target) {
				return true;
			}
		}
	}

	// Check plugin sync patterns
	for (const pattern of plugins) {
		if (pattern.endsWith("/")) {
			// Directory pattern: match any file nested under it
			if (relativePath.startsWith(pattern)) {
				return true;
			}
		} else {
			// File pattern: exact match
			if (relativePath === pattern) {
				return true;
			}
		}
	}

	// Allowlist behavior: reject anything not explicitly matched
	return false;
}
