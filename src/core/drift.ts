import * as fs from "node:fs/promises";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { makeAllowlistFn, needsPathRewrite } from "./env-helpers.js";
import type { Environment } from "./environment.js";
import { listStaged } from "./merge/staging.js";
import { detectRepoVersion } from "./migration.js";
import { rewritePathsForRepo } from "./path-rewriter.js";
import { scanDirectory } from "./scanner.js";

/**
 * Per-environment drift classification.
 *
 * Buckets follow the 3-way merge semantics used by `syncPull`:
 *   - localOnly:    local differs from sync-repo HEAD, remote matches HEAD
 *   - remoteOnly:   local matches HEAD, remote differs from HEAD
 *   - bothChanged:  local and remote both differ from HEAD (a real conflict)
 *   - stagedPending: entries currently staged for review under
 *                    `<syncRepoDir>/.ai-sync/pending/` for this env.
 */
export interface DriftReport {
	envName: string;
	localOnly: string[];
	remoteOnly: string[];
	bothChanged: string[];
	stagedPending: string[];
}

/**
 * Reads the contents of `<ref>:<relPath>` from the git repo at `repoDir`.
 * Returns `null` if the ref or file does not exist in that ref.
 */
async function readRefContent(
	repoDir: string,
	ref: string,
	relPath: string,
): Promise<string | null> {
	try {
		return await simpleGit(repoDir).show([`${ref}:${relPath}`]);
	} catch {
		return null;
	}
}

/**
 * Returns true when the local repo has a tracking ref for `<ref>` (e.g.
 * `origin/main`). Avoids throwing when the remote has never been fetched.
 */
async function refExists(repoDir: string, ref: string): Promise<boolean> {
	try {
		await simpleGit(repoDir).revparse([ref]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Classifies drift between local config, sync-repo HEAD (base), and the
 * remote tracking ref (origin/main) for a single environment.
 *
 * No network I/O is performed — callers are expected to have already
 * fetched the remote if up-to-date remote drift is desired.
 *
 * The repoSubdir is derived from the repo's version: v2/v3 repos use
 * `<syncRepoDir>/<env.id>/`, v1 repos use `<syncRepoDir>/` directly.
 */
export async function classifyDriftForEnv(
	env: Environment,
	syncRepoDir: string,
	homeDir: string,
): Promise<DriftReport> {
	const configDir = env.getConfigDir();
	const allowlistFn = makeAllowlistFn(env);
	const version = await detectRepoVersion(syncRepoDir);
	const repoSubdir = version === 1 ? syncRepoDir : path.join(syncRepoDir, env.id);
	const repoSubdirRel = version === 1 ? "" : env.id;
	const remoteRef = "origin/main";
	const remoteAvailable = await refExists(syncRepoDir, remoteRef);

	// Gather all files we need to consider: union of local + repo HEAD.
	let localFiles: string[] = [];
	try {
		localFiles = await scanDirectory(configDir, allowlistFn);
	} catch {
		// Config dir absent — nothing local to compare
	}

	let repoFiles: string[] = [];
	try {
		repoFiles = await scanDirectory(repoSubdir, allowlistFn);
	} catch {
		// Repo subdir absent — first sync for this env
	}

	const allFiles = new Set<string>([...localFiles, ...repoFiles]);

	const localOnly: string[] = [];
	const remoteOnly: string[] = [];
	const bothChanged: string[] = [];

	for (const relativePath of allFiles) {
		const rewrite = needsPathRewrite(relativePath, env);

		// base = HEAD (sync repo content as currently committed)
		let baseContent: string | null = null;
		try {
			baseContent = await fs.readFile(path.join(repoSubdir, relativePath), "utf-8");
		} catch {
			// File not present in repo HEAD
		}

		// local = local config content, normalized to repo form for fair comparison
		let localContent: string | null = null;
		try {
			const raw = await fs.readFile(path.join(configDir, relativePath), "utf-8");
			localContent = rewrite ? rewritePathsForRepo(raw, homeDir) : raw;
		} catch {
			// File not present locally
		}

		// remote = origin/main:<repoSubdirRel>/<relativePath>
		const remoteRelPath = repoSubdirRel ? `${repoSubdirRel}/${relativePath}` : relativePath;
		const remoteContent = remoteAvailable
			? await readRefContent(syncRepoDir, remoteRef, remoteRelPath)
			: baseContent;

		const localChanged = localContent !== baseContent;
		const remoteChanged = remoteAvailable && remoteContent !== baseContent;

		if (!localChanged && !remoteChanged) continue;

		if (localChanged && remoteChanged && localContent !== remoteContent) {
			bothChanged.push(relativePath);
		} else if (localChanged) {
			localOnly.push(relativePath);
		} else if (remoteChanged) {
			remoteOnly.push(relativePath);
		}
	}

	localOnly.sort();
	remoteOnly.sort();
	bothChanged.sort();

	// Staged-pending entries scoped to this env.
	let stagedPending: string[] = [];
	try {
		const staged = await listStaged(syncRepoDir);
		stagedPending = staged
			.filter((e) => e.envName === env.id)
			.map((e) => e.relativePath)
			.sort();
	} catch {
		// No manifest yet — leave empty
	}

	return {
		envName: env.id,
		localOnly,
		remoteOnly,
		bothChanged,
		stagedPending,
	};
}

/**
 * Convenience wrapper: classifies drift for every passed-in environment.
 */
export async function classifyDrift(
	envs: Environment[],
	syncRepoDir: string,
	homeDir: string,
): Promise<DriftReport[]> {
	const reports: DriftReport[] = [];
	for (const env of envs) {
		reports.push(await classifyDriftForEnv(env, syncRepoDir, homeDir));
	}
	return reports;
}
