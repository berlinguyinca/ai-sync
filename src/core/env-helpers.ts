import * as path from "node:path";
import { type Environment, isFragmentCapable } from "./environment.js";
import { isPathAllowed } from "./manifest.js";

/**
 * Creates an allowlist function for an environment's sync targets.
 */
export function makeAllowlistFn(env: Environment): (relativePath: string) => boolean {
	const fragmentDirs = isFragmentCapable(env) ? env.getFragmentDirs() : [];
	return (relativePath: string) =>
		isPathAllowed(
			relativePath,
			[...env.getSyncTargets(), ...fragmentDirs],
			env.getPluginSyncPatterns(),
			env.getIgnorePatterns(),
		);
}

/**
 * Checks whether a file needs {{HOME}} path rewriting for the given environment.
 */
export function needsPathRewrite(relativePath: string, env: Environment): boolean {
	const targets = env.getPathRewriteTargets();
	return targets.some((t) => path.basename(relativePath) === t);
}
