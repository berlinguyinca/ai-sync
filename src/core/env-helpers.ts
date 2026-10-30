import * as path from "node:path";
import { type Environment, isFragmentCapable } from "./environment.js";
import { isPathAllowed, isPathIgnored } from "./manifest.js";
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
 * Creates an allowlist function for an environment's sync targets.
 */
export function makeAllowlistFn(env: Environment, options: AllowlistOptions = {}): AllowlistFn {
	const fragmentDirs = isFragmentCapable(env) ? env.getFragmentDirs() : [];
	const allowed = (relativePath: string): boolean =>
		isPathAllowed(
			relativePath,
			[...env.getSyncTargets(), ...fragmentDirs],
			getEffectivePluginPatterns(env, options),
			env.getIgnorePatterns(),
		);
	const ignorePatterns = env.getIgnorePatterns();
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
	return (relativePath: string): boolean =>
		isPathAllowed(relativePath, undefined, options.plugins === false ? [] : undefined);
}
