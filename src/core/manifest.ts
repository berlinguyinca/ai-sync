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
] as const;

/**
 * Plugin-specific paths to include in sync.
 * These are checked in addition to DEFAULT_SYNC_TARGETS.
 */
export const PLUGIN_SYNC_PATTERNS: readonly string[] = [
	"plugins/blocklist.json",
	"plugins/known_marketplaces.json",
	"plugins/marketplaces/",
] as const;

/**
 * Plugin-specific paths to explicitly exclude from sync.
 * These take priority over PLUGIN_SYNC_PATTERNS.
 */
export const PLUGIN_IGNORE_PATTERNS: readonly string[] = [
	"plugins/install-counts-cache.json",
] as const;

/**
 * Checks whether a relative path (relative to ~/.claude) is allowed by the sync manifest.
 *
 * Allowlist behavior: only known paths are included, everything else is rejected.
 * Ignore patterns take priority over sync patterns.
 */
export function isPathAllowed(relativePath: string): boolean {
	// Check ignore patterns first (these always win)
	for (const pattern of PLUGIN_IGNORE_PATTERNS) {
		if (relativePath === pattern) {
			return false;
		}
	}

	// Check default sync targets
	for (const target of DEFAULT_SYNC_TARGETS) {
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
	for (const pattern of PLUGIN_SYNC_PATTERNS) {
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
