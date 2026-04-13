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
	for (const pattern of ignores) {
		if (relativePath === pattern) {
			return false;
		}
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
