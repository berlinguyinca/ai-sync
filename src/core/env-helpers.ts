import * as path from "node:path";
import { type Environment, isFragmentCapable } from "./environment.js";
import { isPathAllowed, isPathIgnored, PLUGIN_IGNORE_PATTERNS } from "./manifest.js";
import type { AllowlistFn } from "./scanner.js";
import type { SyncConfig } from "./sync-config.js";

/** Options resolved from `tools/sync-config.json`. Omitted = defaults (plugins synced). */
export type AllowlistOptions = Partial<SyncConfig>;

/**
 * Returns the plugin sync patterns in effect: empty when `plugins` is false.
 */
export function getEffectivePluginPatterns(
	env: Environment,
	options: AllowlistOptions = {},
): readonly string[] {
	return options.plugins === false ? [] : env.getPluginSyncPatterns();
}

/**
 * Expands user `exclude` globs into ignore patterns. A pattern naming a path
 * (contains "/" and does not end in "/") also excludes everything beneath it, so
 * `skills/autospec*` covers `skills/autospec-run/SKILL.md`. Patterns without "/"
 * already match any path segment, and trailing-slash patterns are directory patterns.
 */
export function expandExcludePatterns(exclude: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const raw of exclude ?? []) {
		out.push(raw);
		if (!raw.endsWith("/") && raw.replace(/^\//, "").includes("/")) out.push(`${raw}/`);
	}
	return out;
}

/**
 * Creates an allowlist function for an environment's sync targets.
 */
export function makeAllowlistFn(env: Environment, options: AllowlistOptions = {}): AllowlistFn {
	const fragmentDirs = isFragmentCapable(env) ? env.getFragmentDirs() : [];
	const ignorePatterns = [...env.getIgnorePatterns(), ...expandExcludePatterns(options.exclude)];
	const allowed = (relativePath: string): boolean =>
		isPathAllowed(
			relativePath,
			[...env.getSyncTargets(), ...fragmentDirs],
			getEffectivePluginPatterns(env, options),
			ignorePatterns,
		);
	return Object.assign(allowed, {
		isIgnored: (relativePath: string): boolean => isPathIgnored(relativePath, ignorePatterns),
		followExternalSymlinks: env.followExternalSymlinks?.() ?? true,
	});
}

/**
 * Checks whether a file needs {{HOME}} path rewriting for the given environment.
 */
export function needsPathRewrite(relativePath: string, env: Environment): boolean {
	const targets = env.getPathRewriteTargets();
	return targets.some((t) => path.basename(relativePath) === t);
}

/**
 * Allowlist for v1 flat mode (no environment): the default Claude Code
 * targets, with plugin patterns dropped when `plugins` is false.
 */
export function makeDefaultAllowlistFn(options: AllowlistOptions = {}): AllowlistFn {
	const ignorePatterns = [...PLUGIN_IGNORE_PATTERNS, ...expandExcludePatterns(options.exclude)];
	return (relativePath: string): boolean =>
		isPathAllowed(
			relativePath,
			undefined,
			options.plugins === false ? [] : undefined,
			ignorePatterns,
		);
}
