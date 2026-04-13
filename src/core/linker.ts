import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Environment } from "./environment.js";

/**
 * Result of a link or unlink operation for one environment.
 */
export interface LinkResult {
	envId: string;
	linked: string[];
	skipped: string[];
	backedUp: string[];
}

/**
 * Returns the list of sync targets that can be symlinked (no path rewriting needed).
 * Targets that require {{HOME}} path rewriting must stay as copies.
 */
export function getLinkableTargets(env: Environment): string[] {
	const rewriteTargets = new Set(env.getPathRewriteTargets());
	const linkable: string[] = [];

	for (const target of env.getSyncTargets()) {
		// Directory targets never need path rewriting themselves
		if (target.endsWith("/")) {
			linkable.push(target);
			continue;
		}
		// File targets: skip if they need path rewriting
		if (!rewriteTargets.has(target) && !rewriteTargets.has(path.basename(target))) {
			linkable.push(target);
		}
	}

	// Plugin patterns: only include directories (files like installed_plugins.json need rewriting)
	for (const pattern of env.getPluginSyncPatterns()) {
		if (pattern.endsWith("/")) {
			linkable.push(pattern);
			continue;
		}
		if (!rewriteTargets.has(path.basename(pattern))) {
			linkable.push(pattern);
		}
	}

	return linkable;
}

/**
 * Returns sync targets that cannot be symlinked because they need path rewriting.
 */
export function getUnlinkableTargets(env: Environment): string[] {
	const rewriteTargets = new Set(env.getPathRewriteTargets());
	const unlinkable: string[] = [];

	for (const target of [...env.getSyncTargets(), ...env.getPluginSyncPatterns()]) {
		if (target.endsWith("/")) continue;
		if (rewriteTargets.has(target) || rewriteTargets.has(path.basename(target))) {
			unlinkable.push(target);
		}
	}

	return unlinkable;
}

/**
 * Creates symlinks from an environment's config dir to the sync repo.
 *
 * For each linkable sync target:
 * 1. Backs up the existing file/dir in the config dir
 * 2. Ensures the target exists in the sync repo (copies from config if needed)
 * 3. Creates a symlink: configDir/target → repoSubdir/target
 *
 * Files requiring {{HOME}} path rewriting are skipped (returned in `skipped`).
 */
export async function linkEnvironment(
	env: Environment,
	syncRepoDir: string,
	backupDir: string,
): Promise<LinkResult> {
	const configDir = env.getConfigDir();
	const repoSubdir = path.join(syncRepoDir, env.id);
	const linkable = getLinkableTargets(env);
	const skipped = getUnlinkableTargets(env);
	const linked: string[] = [];
	const backedUp: string[] = [];

	await fs.mkdir(repoSubdir, { recursive: true });

	for (const target of linkable) {
		const configPath = path.join(configDir, target);
		const repoPath = path.join(repoSubdir, target);

		// Check if already a symlink pointing to the right place
		try {
			const linkTarget = await fs.readlink(configPath.replace(/\/$/, ""));
			if (linkTarget === repoPath.replace(/\/$/, "")) {
				linked.push(target);
				continue;
			}
		} catch {
			// Not a symlink, proceed
		}

		const isDir = target.endsWith("/");
		const configTarget = isDir ? configPath.replace(/\/$/, "") : configPath;
		const repoTarget = isDir ? repoPath.replace(/\/$/, "") : repoPath;

		// Check if source exists in config dir
		let configExists = false;
		try {
			await fs.access(configTarget);
			configExists = true;
		} catch {
			// Doesn't exist locally
		}

		// Check if target exists in repo
		let repoExists = false;
		try {
			await fs.access(repoTarget);
			repoExists = true;
		} catch {
			// Doesn't exist in repo
		}

		// If neither exists, skip
		if (!configExists && !repoExists) {
			continue;
		}

		// If config exists but repo doesn't, seed the repo from config
		if (configExists && !repoExists) {
			await fs.mkdir(path.dirname(repoTarget), { recursive: true });
			await copyRecursive(configTarget, repoTarget);
		}

		// Back up existing config file/dir (if not already a symlink)
		if (configExists) {
			const stat = await fs.lstat(configTarget);
			if (!stat.isSymbolicLink()) {
				const backupPath = path.join(backupDir, env.id, target.replace(/\/$/, ""));
				await fs.mkdir(path.dirname(backupPath), { recursive: true });
				await copyRecursive(configTarget, backupPath);
				backedUp.push(target);

				// Remove the original
				await fs.rm(configTarget, { recursive: true });
			}
		}

		// Create symlink
		await fs.mkdir(path.dirname(configTarget), { recursive: true });
		await fs.symlink(repoTarget, configTarget);
		linked.push(target);
	}

	return { envId: env.id, linked, skipped, backedUp };
}

/**
 * Removes symlinks for an environment, replacing them with copies of the repo content.
 */
export async function unlinkEnvironment(
	env: Environment,
	syncRepoDir: string,
): Promise<LinkResult> {
	const configDir = env.getConfigDir();
	const repoSubdir = path.join(syncRepoDir, env.id);
	const linkable = getLinkableTargets(env);
	const unlinked: string[] = [];

	for (const target of linkable) {
		const isDir = target.endsWith("/");
		const configTarget = isDir
			? path.join(configDir, target).replace(/\/$/, "")
			: path.join(configDir, target);
		const repoTarget = isDir
			? path.join(repoSubdir, target).replace(/\/$/, "")
			: path.join(repoSubdir, target);

		// Check if it's a symlink
		try {
			const stat = await fs.lstat(configTarget);
			if (!stat.isSymbolicLink()) continue;
		} catch {
			continue;
		}

		// Remove symlink
		await fs.rm(configTarget);

		// Copy content back from repo
		try {
			await fs.access(repoTarget);
			await fs.mkdir(path.dirname(configTarget), { recursive: true });
			await copyRecursive(repoTarget, configTarget);
			unlinked.push(target);
		} catch {
			// Repo target doesn't exist, nothing to copy back
			unlinked.push(target);
		}
	}

	return { envId: env.id, linked: unlinked, skipped: [], backedUp: [] };
}

/**
 * Symlinks the shared fragment directory from the sync repo into a config dir.
 * This allows @-references in CLAUDE.md to resolve relative to the config dir.
 */
export async function linkSharedDirectory(
	syncRepoDir: string,
	configDir: string,
	backupDir: string,
): Promise<{ linked: boolean; backedUp: boolean }> {
	const repoSharedDir = path.join(syncRepoDir, "shared");

	// 1. Check if syncRepoDir/shared/ exists
	try {
		await fs.access(repoSharedDir);
	} catch {
		return { linked: false, backedUp: false };
	}

	const configSharedPath = path.join(configDir, "shared");
	let backedUp = false;

	// 2. Check if configDir/shared already exists
	let existingStat: import("node:fs").Stats | null = null;
	try {
		existingStat = await fs.lstat(configSharedPath);
	} catch {
		// Does not exist — nothing to do before linking
	}

	if (existingStat !== null) {
		if (existingStat.isSymbolicLink()) {
			// Remove the old symlink
			await fs.rm(configSharedPath);
		} else {
			// Real directory: back it up, then remove
			const backupPath = path.join(backupDir, "shared");
			await fs.mkdir(path.dirname(backupPath), { recursive: true });
			await copyRecursive(configSharedPath, backupPath);
			backedUp = true;
			await fs.rm(configSharedPath, { recursive: true });
		}
	}

	// 3. Create symlink: configDir/shared -> syncRepoDir/shared
	await fs.mkdir(configDir, { recursive: true });
	await fs.symlink(repoSharedDir, configSharedPath);

	return { linked: true, backedUp };
}

/**
 * Recursively copies a file or directory.
 */
async function copyRecursive(src: string, dest: string): Promise<void> {
	const stat = await fs.stat(src);
	if (stat.isDirectory()) {
		await fs.mkdir(dest, { recursive: true });
		const entries = await fs.readdir(src, { withFileTypes: true });
		for (const entry of entries) {
			await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
		}
	} else {
		await fs.copyFile(src, dest);
		await fs.chmod(dest, stat.mode);
	}
}
