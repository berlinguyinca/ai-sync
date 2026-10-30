import * as path from "node:path";
import { type Environment, isFragmentCapable } from "./environment.js";
import { isPathAllowed, isPathIgnored } from "./manifest.js";
import type { AllowlistFn } from "./scanner.js";

/**
 * Creates an allowlist function for an environment's sync targets.
 */
export function makeAllowlistFn(env: Environment): AllowlistFn {
	const fragmentDirs = isFragmentCapable(env) ? env.getFragmentDirs() : [];
	const allowed = (relativePath: string): boolean =>
		isPathAllowed(
			relativePath,
			[...env.getSyncTargets(), ...fragmentDirs],
			env.getPluginSyncPatterns(),
			env.getIgnorePatterns(),
		);
	const ignorePatterns = env.getIgnorePatterns();
	return Object.assign(allowed, {
		isIgnored: (relativePath: string): boolean => isPathIgnored(relativePath, ignorePatterns),
	});
}

/**
 * Checks whether a file needs {{HOME}} path rewriting for the given environment.
 */
export function needsPathRewrite(relativePath: string, env: Environment): boolean {
	const targets = env.getPathRewriteTargets();
	return targets.some((t) => path.basename(relativePath) === t);
}
