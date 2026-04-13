import * as fs from "node:fs/promises";
import * as path from "node:path";
import pc from "picocolors";
import {
	addFiles,
	commitFiles,
	fetchRemote,
	getStatus,
	hasRemote,
	pullFromRemote,
	pushToRemote,
} from "../git/repo.js";
import { createBackup } from "./backup.js";
import { makeAllowlistFn, needsPathRewrite } from "./env-helpers.js";
import type { Environment } from "./environment.js";
import { detectRepoVersion, migrateToV3 } from "./migration.js";
import { expandPathsForLocal, rewritePathsForRepo } from "./path-rewriter.js";
import type { ProvisionResult } from "./provisioner.js";
import { discoverTools, preflightCheck, provision, writeManifest } from "./provisioner.js";
import { scanDirectory } from "./scanner.js";
import { ToolManifestSchema } from "./tool-manifest.js";

/**
 * Options for sync operations.
 */
export interface SyncOptions {
	/** @deprecated Use environments instead. Falls back to single claude env. */
	claudeDir?: string;
	syncRepoDir: string;
	homeDir?: string;
	environments?: Environment[];
	/** When true, compute changes without writing files or pushing/pulling. */
	dryRun?: boolean;
	/** Limit operation to a specific environment by id. */
	filterEnv?: string;
	/** When true, emit progress messages to stdout during operations. */
	verbose?: boolean;
	/** Force overwrite of locally modified files during pull. */
	force?: boolean;
	/** Skip tool discovery during push. */
	skipDiscovery?: boolean;
	/** Skip tool provisioning during pull. */
	noProvision?: boolean;
}

/**
 * Logs a message to stdout when verbose mode is enabled.
 */
function verboseLog(options: SyncOptions, message: string): void {
	if (options.verbose) {
		console.log(pc.dim(`  [verbose] ${message}`));
	}
}

/**
 * Writes file content and preserves the source file's permission mode.
 *
 * Plugin hooks and scripts require executable bits (e.g., 0o755).
 * Plain fs.writeFile creates files with default 0o644, which breaks
 * executable scripts after sync. This copies the mode from srcPath
 * so that git records it correctly (push) and local files remain
 * executable (pull).
 */
async function writeFilePreservingMode(
	srcPath: string,
	destPath: string,
	content: string,
): Promise<void> {
	const stat = await fs.stat(srcPath);
	await fs.writeFile(destPath, content);
	await fs.chmod(destPath, stat.mode);
}

/**
 * Result of a syncPush operation.
 */
export interface SyncPushResult {
	filesUpdated: number;
	pushed: boolean;
	message: string;
	fileChanges: FileChange[];
	perEnvironment?: Record<string, { filesUpdated: number; fileChanges: FileChange[] }>;
	/** Errors encountered per environment (non-fatal). */
	errors?: Record<string, string>;
	/** True when --dry-run was used. */
	dryRun?: boolean;
}

/**
 * Result of a syncPull operation.
 */
export interface SyncPullResult {
	backupDir: string;
	filesApplied: number;
	message: string;
	fileChanges: FileChange[];
	/** Files skipped because both local and remote had changes (merge conflict). */
	conflicts?: FileChange[];
	perEnvironment?: Record<
		string,
		{ filesApplied: number; fileChanges: FileChange[]; conflicts?: FileChange[] }
	>;
	/** Errors encountered per environment (non-fatal). */
	errors?: Record<string, string>;
	/** True when --dry-run was used. */
	dryRun?: boolean;
	/** Result of tool provisioning, if manifest was found during pull. */
	provisioning?: ProvisionResult;
}

/**
 * Represents a file change detected during sync status comparison.
 */
export interface FileChange {
	path: string;
	type: "modified" | "added" | "deleted";
}

/**
 * Result of a syncStatus operation.
 */
export interface SyncStatusResult {
	localModifications: FileChange[];
	remoteDrift: { ahead: number; behind: number };
	excludedCount: number;
	syncedCount: number;
	branch: string | null;
	tracking: string | null;
	isClean: boolean;
	hasRemote: boolean;
	perEnvironment?: Record<
		string,
		{ localModifications: FileChange[]; syncedCount: number; excludedCount: number }
	>;
}

/**
 * Resolves the effective config dir and home dir for a legacy SyncOptions.
 */
function resolveLegacyPaths(options: SyncOptions): {
	claudeDir: string;
	homeDir: string;
} {
	const claudeDir = options.claudeDir ?? path.join(options.homeDir ?? "", ".claude");
	const homeDir = options.homeDir ?? path.dirname(claudeDir);
	return { claudeDir, homeDir };
}

/**
 * Returns the subdirectory within the sync repo for an environment.
 * v1 repos use the root (empty string), v2 repos use env.id.
 */
function getRepoSubdir(syncRepoDir: string, envId: string, version: 1 | 2): string {
	return version === 1 ? syncRepoDir : path.join(syncRepoDir, envId);
}

/**
 * Collects shared fragment file paths from the sync repo.
 * shared/ lives ONLY in the sync repo, not in any config dir.
 */
async function syncSharedDirectory(syncRepoDir: string): Promise<string[]> {
	const sharedDir = path.join(syncRepoDir, "shared");
	const changedFiles: string[] = [];
	try {
		await fs.access(sharedDir);
	} catch {
		return changedFiles; // shared/ doesn't exist yet
	}
	// Use scanDirectory from scanner.ts to get all files under shared/
	const sharedFiles = await scanDirectory(sharedDir);
	for (const relativePath of sharedFiles) {
		changedFiles.push(`shared/${relativePath}`);
	}
	return changedFiles;
}

/**
 * Pushes local config files to the sync repo and remote.
 */
export async function syncPush(options: SyncOptions): Promise<SyncPushResult> {
	const { syncRepoDir } = options;

	// Check remote exists
	verboseLog(options, "Checking remote configuration...");
	const remoteConfigured = await hasRemote(syncRepoDir);
	if (!remoteConfigured) {
		throw new Error(
			`No remote configured. Add a remote with: git -C ${syncRepoDir} remote add origin <url>`,
		);
	}

	// Fetch and check if behind
	verboseLog(options, "Fetching from remote...");
	await fetchRemote(syncRepoDir);
	const preStatus = await getStatus(syncRepoDir);
	if (preStatus.behind > 0) {
		throw new Error(
			`Remote is ${preStatus.behind} commit(s) ahead of local. ` +
				"Run 'ai-sync pull' first to merge remote changes, then retry push.\n" +
				"If you have local conflicts, resolve them in the sync repo at: " +
				syncRepoDir,
		);
	}

	verboseLog(options, "Detecting repo version...");
	const version = await detectRepoVersion(syncRepoDir);
	verboseLog(options, `Repo version: v${version}`);
	const perEnvironment: Record<string, { filesUpdated: number; fileChanges: FileChange[] }> = {};
	const errors: Record<string, string> = {};
	const envs = options.filterEnv
		? (options.environments ?? []).filter((e) => e.id === options.filterEnv)
		: (options.environments ?? []);

	if (envs.length > 0 && version === 2) {
		// v2 multi-environment mode
		for (const env of envs) {
			try {
				verboseLog(options, `Processing environment: ${env.id}`);
				const configDir = env.getConfigDir();
				const homeDir = options.homeDir ?? path.dirname(configDir);
				const repoSubdir = getRepoSubdir(syncRepoDir, env.id, 2);

				try {
					await fs.access(configDir);
				} catch {
					// Config dir doesn't exist for this env, skip
					verboseLog(options, `Config dir not found for ${env.id}, skipping`);
					perEnvironment[env.id] = { filesUpdated: 0, fileChanges: [] };
					continue;
				}

				const allowlistFn = makeAllowlistFn(env);
				verboseLog(options, `Scanning ${configDir}...`);
				const localFiles = await scanDirectory(configDir, allowlistFn);
				verboseLog(options, `Found ${localFiles.length} files for ${env.id}`);

				if (!options.dryRun) {
					// Copy each file from configDir to repoSubdir
					await fs.mkdir(repoSubdir, { recursive: true });
					for (const relativePath of localFiles) {
						const srcPath = path.join(configDir, relativePath);
						const destPath = path.join(repoSubdir, relativePath);
						await fs.mkdir(path.dirname(destPath), { recursive: true });
						let content = await fs.readFile(srcPath, "utf-8");
						if (needsPathRewrite(relativePath, env)) {
							verboseLog(options, `Rewriting paths in ${relativePath}`);
							content = rewritePathsForRepo(content, homeDir);
						}
						await writeFilePreservingMode(srcPath, destPath, content);
					}

					// Delete files from repo subdir that no longer exist locally
					try {
						const repoFiles = await scanDirectory(repoSubdir, allowlistFn);
						const localFileSet = new Set(localFiles);
						for (const repoFile of repoFiles) {
							if (!localFileSet.has(repoFile)) {
								await fs.rm(path.join(repoSubdir, repoFile));
							}
						}
					} catch {
						// Subdir might not exist yet
					}
				}

				perEnvironment[env.id] = { filesUpdated: 0, fileChanges: [] };
			} catch (err) {
				errors[env.id] = err instanceof Error ? err.message : String(err);
				perEnvironment[env.id] = { filesUpdated: 0, fileChanges: [] };
			}
		}
	} else {
		// v1 flat mode or single-environment fallback
		verboseLog(options, "Using v1 flat mode");
		const { claudeDir, homeDir } = resolveLegacyPaths(options);
		verboseLog(options, `Scanning ${claudeDir}...`);
		const localFiles = await scanDirectory(claudeDir);
		verboseLog(options, `Found ${localFiles.length} files`);

		for (const relativePath of localFiles) {
			const srcPath = path.join(claudeDir, relativePath);
			const destPath = path.join(syncRepoDir, relativePath);
			await fs.mkdir(path.dirname(destPath), { recursive: true });
			let content = await fs.readFile(srcPath, "utf-8");
			if (path.basename(relativePath) === "settings.json") {
				verboseLog(options, "Rewriting paths in settings.json");
				content = rewritePathsForRepo(content, homeDir);
			}
			await writeFilePreservingMode(srcPath, destPath, content);
		}

		// Delete files from repo that no longer exist locally
		const repoFiles = await scanDirectory(syncRepoDir);
		const localFileSet = new Set(localFiles);
		for (const repoFile of repoFiles) {
			if (!localFileSet.has(repoFile)) {
				verboseLog(options, `Removing deleted file: ${repoFile}`);
				await fs.rm(path.join(syncRepoDir, repoFile));
			}
		}
	}

	const hasErrors = Object.keys(errors).length > 0;
	const errorsResult = hasErrors ? errors : undefined;

	// Check git status
	verboseLog(options, "Checking git status...");
	const status = await getStatus(syncRepoDir);
	if (status.isClean()) {
		if (status.ahead > 0 && !options.dryRun) {
			await pushToRemote(syncRepoDir);
			return {
				filesUpdated: 0,
				pushed: true,
				message: "Pushed previously committed changes to remote",
				fileChanges: [],
				perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
				errors: errorsResult,
				dryRun: options.dryRun,
			};
		}
		return {
			filesUpdated: 0,
			pushed: false,
			message: options.dryRun ? "Dry run: no changes detected" : "No changes to push",
			fileChanges: [],
			perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
			errors: errorsResult,
			dryRun: options.dryRun,
		};
	}

	// Build file change list from git status
	const fileChanges: FileChange[] = status.files.map((f) => ({
		path: f.path,
		type: f.working_dir === "?" ? "added" : f.working_dir === "D" ? "deleted" : "modified",
	}));

	// Update per-environment stats
	if (envs.length > 0 && version === 2) {
		for (const env of envs) {
			const prefix = `${env.id}/`;
			const envChanges = fileChanges.filter((c) => c.path.startsWith(prefix));
			perEnvironment[env.id] = {
				filesUpdated: envChanges.length,
				fileChanges: envChanges.map((c) => ({
					...c,
					path: c.path.slice(prefix.length),
				})),
			};
		}
	}

	if (options.dryRun) {
		// Revert working tree changes so dry-run is truly side-effect free.
		// This only affects the managed sync repo (not user project files).
		// Any manual edits in the sync repo will be reverted — this is acceptable
		// because the sync repo is machine-managed and not meant for hand-editing.
		const git = await import("simple-git").then((m) => m.simpleGit(syncRepoDir));
		await git.checkout(["."]);
		// Remove untracked files added during dry-run scan
		await git.clean("f", ["-d"]);
		return {
			filesUpdated: fileChanges.length,
			pushed: false,
			message: `Dry run: ${fileChanges.length} file(s) would be pushed`,
			fileChanges,
			perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
			errors: errorsResult,
			dryRun: true,
		};
	}

	// Stage, commit, push
	verboseLog(options, `Staging ${fileChanges.length} file(s)...`);
	const sharedFiles = await syncSharedDirectory(syncRepoDir);
	const filesToStage = [...new Set([...status.files.map((f) => f.path), ...sharedFiles])];

	// Tool discovery (non-fatal)
	if (!options.skipDiscovery) {
		try {
			const enabledEnvs = options.environments ?? [];
			const claudeEnv = enabledEnvs.find((e) => e.id === "claude");
			if (claudeEnv) {
				const settingsPath = path.join(claudeEnv.getConfigDir(), "settings.json");
				const pluginsPath = path.join(
					claudeEnv.getConfigDir(),
					"plugins",
					"installed_plugins.json",
				);
				const tools = await discoverTools({ settingsPath, pluginsPath });
				if (tools.length > 0) {
					const manifest = {
						version: 1 as const,
						discoveredAt: new Date().toISOString(),
						sourcePlatform: process.platform as "darwin" | "linux" | "win32",
						tools,
						autoInstall: false,
					};
					await writeManifest(manifest, syncRepoDir);
					filesToStage.push("tools/manifest.json");
				}
			}
		} catch (err) {
			// Discovery errors are non-fatal — log and continue
			if (options.verbose) {
				console.warn("Tool discovery warning:", err);
			}
		}
	}

	// Auto-upgrade to v3 when fragments or tools are present
	const repoVersion = await detectRepoVersion(syncRepoDir);
	const hasFragments = sharedFiles.length > 0;
	const hasTools = filesToStage.includes("tools/manifest.json");
	if (repoVersion === 2 && (hasFragments || hasTools)) {
		await migrateToV3(syncRepoDir);
		filesToStage.push(".sync-version");
	}

	if (filesToStage.length > 0) {
		await addFiles(syncRepoDir, filesToStage);
	}
	verboseLog(options, "Committing...");
	await commitFiles(syncRepoDir, "sync: update config");
	verboseLog(options, "Pushing to remote...");
	await pushToRemote(syncRepoDir);

	return {
		filesUpdated: fileChanges.length,
		pushed: true,
		message: `Pushed ${fileChanges.length} files to remote`,
		fileChanges,
		perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
		errors: errorsResult,
	};
}

/**
 * Pulls remote changes into local config directories.
 */
export async function syncPull(options: SyncOptions): Promise<SyncPullResult> {
	const { syncRepoDir } = options;

	// Check remote exists
	verboseLog(options, "Checking remote configuration...");
	const remoteConfigured = await hasRemote(syncRepoDir);
	if (!remoteConfigured) {
		throw new Error(
			`No remote configured. Add a remote with: git -C ${syncRepoDir} remote add origin <url>`,
		);
	}

	verboseLog(options, "Detecting repo version...");
	const version = await detectRepoVersion(syncRepoDir);
	verboseLog(options, `Repo version: v${version}`);
	const allFileChanges: FileChange[] = [];
	const allConflicts: FileChange[] = [];
	let backupDir = "";
	let totalApplied = 0;
	const perEnvironment: Record<
		string,
		{ filesApplied: number; fileChanges: FileChange[]; conflicts?: FileChange[] }
	> = {};
	const errors: Record<string, string> = {};
	const envs = options.filterEnv
		? (options.environments ?? []).filter((e) => e.id === options.filterEnv)
		: (options.environments ?? []);

	if (envs.length > 0 && version === 2) {
		// v2 multi-environment mode

		// Phase 1: Snapshot repo state BEFORE pull for 3-way merge detection
		const prePullContents = new Map<string, Map<string, string>>();
		for (const env of envs) {
			const repoSubdir = getRepoSubdir(syncRepoDir, env.id, 2);
			const allowlistFn = makeAllowlistFn(env);
			const contents = new Map<string, string>();
			try {
				const repoFiles = await scanDirectory(repoSubdir, allowlistFn);
				for (const f of repoFiles) {
					contents.set(f, await fs.readFile(path.join(repoSubdir, f), "utf-8"));
				}
			} catch {
				// Repo subdir doesn't exist yet
			}
			prePullContents.set(env.id, contents);
		}

		// Phase 2: Backup all environments, then pull
		if (!options.dryRun) {
			verboseLog(options, "Creating backup of current config...");
			const backupBaseDir = path.join(path.dirname(syncRepoDir), ".ai-sync-backups");
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			backupDir = path.join(backupBaseDir, timestamp);
			await fs.mkdir(backupDir, { recursive: true });

			for (const env of envs) {
				const configDir = env.getConfigDir();
				try {
					await fs.access(configDir);
					const envBackupDir = path.join(backupDir, env.id);
					const allowlistFn = makeAllowlistFn(env);
					const existingFiles = await scanDirectory(configDir, allowlistFn);
					if (existingFiles.length > 0) {
						await fs.mkdir(envBackupDir, { recursive: true });
						for (const relativePath of existingFiles) {
							const srcPath = path.join(configDir, relativePath);
							const destPath = path.join(envBackupDir, relativePath);
							await fs.mkdir(path.dirname(destPath), { recursive: true });
							await fs.copyFile(srcPath, destPath);
						}
					}
				} catch {
					// Config dir doesn't exist, nothing to back up
				}
			}

			// Pull from remote
			verboseLog(options, "Pulling from remote...");
			await pullFromRemote(syncRepoDir);
		} else {
			// Dry-run: fetch to see what's available but don't pull
			verboseLog(options, "Fetching from remote (dry-run)...");
			await fetchRemote(syncRepoDir);
		}

		// Phase 3: Apply files per environment with merge detection
		for (const env of envs) {
			try {
				verboseLog(options, `Processing environment: ${env.id}`);
				const configDir = env.getConfigDir();
				const homeDir = options.homeDir ?? path.dirname(configDir);
				const repoSubdir = getRepoSubdir(syncRepoDir, env.id, 2);
				const allowlistFn = makeAllowlistFn(env);
				const envChanges: FileChange[] = [];
				const envConflicts: FileChange[] = [];
				const prePull = prePullContents.get(env.id) ?? new Map<string, string>();

				let repoFiles: string[] = [];
				try {
					await fs.access(repoSubdir);
					repoFiles = await scanDirectory(repoSubdir, allowlistFn);
				} catch {
					// No files for this environment in repo
					perEnvironment[env.id] = { filesApplied: 0, fileChanges: [] };
					continue;
				}

				verboseLog(options, `Found ${repoFiles.length} files in repo for ${env.id}`);

				if (!options.dryRun) {
					await fs.mkdir(configDir, { recursive: true });
				}

				const repoFileSet = new Set(repoFiles);

				for (const relativePath of repoFiles) {
					const srcPath = path.join(repoSubdir, relativePath);
					const destPath = path.join(configDir, relativePath);
					const rewrite = needsPathRewrite(relativePath, env);
					let remoteContent = await fs.readFile(srcPath, "utf-8");
					if (rewrite) {
						verboseLog(options, `Expanding paths in ${relativePath}`);
						remoteContent = expandPathsForLocal(remoteContent, homeDir);
					}

					// Read local file content
					let localContent: string | null = null;
					try {
						localContent = await fs.readFile(destPath, "utf-8");
					} catch {
						// File doesn't exist locally
					}

					// Get pre-pull base content (expanded for comparison)
					const rawBase = prePull.get(relativePath);
					const baseContent =
						rawBase !== undefined
							? rewrite
								? expandPathsForLocal(rawBase, homeDir)
								: rawBase
							: null;

					if (localContent === null || baseContent === null) {
						// New file from remote or first sync — apply it
						const changeType: FileChange["type"] = localContent === null ? "added" : "modified";
						const needsWrite = localContent === null || localContent !== remoteContent;
						if (needsWrite) {
							if (!options.dryRun) {
								await fs.mkdir(path.dirname(destPath), { recursive: true });
								await writeFilePreservingMode(srcPath, destPath, remoteContent);
							}
							envChanges.push({ path: relativePath, type: changeType });
							allFileChanges.push({
								path: `${env.id}/${relativePath}`,
								type: changeType,
							});
						}
					} else {
						// File exists both locally and in repo pre-pull: 3-way merge
						const localChanged = localContent !== baseContent;
						const remoteChanged = remoteContent !== baseContent;

						if (!localChanged) {
							// No local modifications — safe to apply remote
							if (remoteChanged) {
								if (!options.dryRun) {
									await fs.mkdir(path.dirname(destPath), { recursive: true });
									await writeFilePreservingMode(srcPath, destPath, remoteContent);
								}
								envChanges.push({ path: relativePath, type: "modified" });
								allFileChanges.push({
									path: `${env.id}/${relativePath}`,
									type: "modified",
								});
							}
						} else if (!remoteChanged) {
							// Only local changes — keep local version
							verboseLog(options, `Keeping local changes: ${relativePath}`);
						} else if (options.force) {
							// Both changed + --force — overwrite with remote
							if (!options.dryRun) {
								await fs.mkdir(path.dirname(destPath), { recursive: true });
								await writeFilePreservingMode(srcPath, destPath, remoteContent);
							}
							envChanges.push({ path: relativePath, type: "modified" });
							allFileChanges.push({
								path: `${env.id}/${relativePath}`,
								type: "modified",
							});
						} else {
							// Both changed — conflict, keep local version
							verboseLog(options, `Conflict (keeping local): ${relativePath}`);
							envConflicts.push({ path: relativePath, type: "modified" });
							allConflicts.push({
								path: `${env.id}/${relativePath}`,
								type: "modified",
							});
						}
					}
				}

				// Handle deletions: remove local files no longer in repo
				if (!options.dryRun) {
					try {
						const localFiles = await scanDirectory(configDir, allowlistFn);
						for (const localFile of localFiles) {
							if (!repoFileSet.has(localFile)) {
								const wasInRepo = prePull.has(localFile);
								if (!wasInRepo) {
									// Never in repo — local-only file, leave it alone
									continue;
								}
								// Remote deleted this file — check for local modifications
								let localModified = false;
								try {
									const localData = await fs.readFile(path.join(configDir, localFile), "utf-8");
									const rawBase = prePull.get(localFile);
									const baseData =
										rawBase !== undefined && needsPathRewrite(localFile, env)
											? expandPathsForLocal(rawBase, homeDir)
											: rawBase;
									localModified = localData !== baseData;
								} catch {
									// Can't read, treat as unmodified
								}

								if (localModified && !options.force) {
									verboseLog(options, `Conflict (remote deleted, local modified): ${localFile}`);
									envConflicts.push({
										path: localFile,
										type: "deleted",
									});
									allConflicts.push({
										path: `${env.id}/${localFile}`,
										type: "deleted",
									});
								} else {
									await fs.rm(path.join(configDir, localFile));
									envChanges.push({
										path: localFile,
										type: "deleted",
									});
									allFileChanges.push({
										path: `${env.id}/${localFile}`,
										type: "deleted",
									});
								}
							}
						}
					} catch {
						// Nothing to clean up
					}
				}

				totalApplied += repoFiles.length;
				perEnvironment[env.id] = {
					filesApplied: repoFiles.length,
					fileChanges: envChanges,
					conflicts: envConflicts.length > 0 ? envConflicts : undefined,
				};
			} catch (err) {
				errors[env.id] = err instanceof Error ? err.message : String(err);
				perEnvironment[env.id] = { filesApplied: 0, fileChanges: [] };
			}
		}
	} else {
		// v1 flat mode or single-environment fallback
		verboseLog(options, "Using v1 flat mode");
		const { claudeDir, homeDir } = resolveLegacyPaths(options);

		// Snapshot repo state before pull for merge detection
		const v1PrePull = new Map<string, string>();
		try {
			const prePullFiles = await scanDirectory(syncRepoDir);
			for (const f of prePullFiles) {
				v1PrePull.set(f, await fs.readFile(path.join(syncRepoDir, f), "utf-8"));
			}
		} catch {
			// Repo might not have files yet
		}

		// Create backup
		verboseLog(options, "Creating backup of current config...");
		const backupBaseDir = path.join(path.dirname(syncRepoDir), ".ai-sync-backups");
		// Fallback: check if old backup dir exists (migration from claude-sync)
		const oldBackupDir = path.join(path.dirname(syncRepoDir), ".claude-sync-backups");
		let effectiveBackupBase = backupBaseDir;
		try {
			await fs.access(oldBackupDir);
			effectiveBackupBase = oldBackupDir;
		} catch {
			// use new path
		}
		backupDir = await createBackup(claudeDir, effectiveBackupBase);
		verboseLog(options, `Backup created at ${backupDir}`);

		// Pull from remote
		verboseLog(options, "Pulling from remote...");
		await pullFromRemote(syncRepoDir);

		// Scan repo for files to apply
		verboseLog(options, "Scanning repo for files to apply...");
		const repoFiles = await scanDirectory(syncRepoDir);
		verboseLog(options, `Found ${repoFiles.length} files in repo`);
		const repoFileSet = new Set(repoFiles);

		for (const relativePath of repoFiles) {
			const srcPath = path.join(syncRepoDir, relativePath);
			const destPath = path.join(claudeDir, relativePath);
			const isSettings = path.basename(relativePath) === "settings.json";
			let remoteContent = await fs.readFile(srcPath, "utf-8");
			if (isSettings) {
				remoteContent = expandPathsForLocal(remoteContent, homeDir);
			}

			// Read local file
			let localContent: string | null = null;
			try {
				localContent = await fs.readFile(destPath, "utf-8");
			} catch {
				// Doesn't exist locally
			}

			// Get pre-pull base (expanded for comparison)
			const rawBase = v1PrePull.get(relativePath);
			const baseContent =
				rawBase !== undefined && isSettings
					? expandPathsForLocal(rawBase, homeDir)
					: (rawBase ?? null);

			if (localContent === null || baseContent === null) {
				// New file — apply
				const changeType: FileChange["type"] = localContent === null ? "added" : "modified";
				const needsWrite = localContent === null || localContent !== remoteContent;
				if (needsWrite) {
					await fs.mkdir(path.dirname(destPath), { recursive: true });
					await writeFilePreservingMode(srcPath, destPath, remoteContent);
					allFileChanges.push({ path: relativePath, type: changeType });
				}
			} else {
				const localChanged = localContent !== baseContent;
				const remoteChanged = remoteContent !== baseContent;

				if (!localChanged) {
					if (remoteChanged) {
						await fs.mkdir(path.dirname(destPath), { recursive: true });
						await writeFilePreservingMode(srcPath, destPath, remoteContent);
						allFileChanges.push({ path: relativePath, type: "modified" });
					}
				} else if (!remoteChanged) {
					verboseLog(options, `Keeping local changes: ${relativePath}`);
				} else if (options.force) {
					await fs.mkdir(path.dirname(destPath), { recursive: true });
					await writeFilePreservingMode(srcPath, destPath, remoteContent);
					allFileChanges.push({ path: relativePath, type: "modified" });
				} else {
					verboseLog(options, `Conflict (keeping local): ${relativePath}`);
					allConflicts.push({ path: relativePath, type: "modified" });
				}
			}
		}

		// Remove local files that no longer exist in the repo (propagate deletions)
		const localFiles = await scanDirectory(claudeDir);
		for (const localFile of localFiles) {
			if (!repoFileSet.has(localFile)) {
				const wasInRepo = v1PrePull.has(localFile);
				if (!wasInRepo) continue;

				let localModified = false;
				try {
					const localData = await fs.readFile(path.join(claudeDir, localFile), "utf-8");
					const rawBase = v1PrePull.get(localFile);
					const isSettings = path.basename(localFile) === "settings.json";
					const baseData =
						rawBase !== undefined && isSettings ? expandPathsForLocal(rawBase, homeDir) : rawBase;
					localModified = localData !== baseData;
				} catch {
					// Can't read
				}

				if (localModified && !options.force) {
					verboseLog(options, `Conflict (remote deleted, local modified): ${localFile}`);
					allConflicts.push({ path: localFile, type: "deleted" });
				} else {
					await fs.rm(path.join(claudeDir, localFile));
					allFileChanges.push({ path: localFile, type: "deleted" });
				}
			}
		}

		totalApplied = repoFiles.length;
	}

	const hasErrors = Object.keys(errors).length > 0;

	const conflictSuffix =
		allConflicts.length > 0
			? ` (${allConflicts.length} conflict(s) — local changes preserved, push first then pull)`
			: "";

	// Tool provisioning (non-fatal, skipped on dry-run and when noProvision is set)
	let provisioningResult: ProvisionResult | undefined;
	if (!options.noProvision && !options.dryRun) {
		const manifestPath = path.join(syncRepoDir, "tools", "manifest.json");
		try {
			const manifestContent = await fs.readFile(manifestPath, "utf-8");
			const manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
			if (manifest.tools.length > 0) {
				const preflight = await preflightCheck(manifest);
				if (!preflight.ok) {
					provisioningResult = {
						installed: [],
						skipped: [],
						failed: [],
						commands: [],
						rolledBack: true,
						rollbackPartial: false,
					};
				} else {
					provisioningResult = await provision({
						manifest,
						autoInstall: manifest.autoInstall,
						backupDir: backupDir || "",
					});
				}
			}
		} catch (provErr) {
			// No manifest or invalid — log in verbose mode
			if (options.verbose) {
				console.warn(
					pc.yellow(`  [verbose] Provisioning skipped: ${provErr instanceof Error ? provErr.message : String(provErr)}`),
				);
			}
		}
	}

	return {
		backupDir,
		filesApplied: totalApplied,
		message: options.dryRun
			? `Dry run: ${allFileChanges.length} file(s) would be applied${conflictSuffix}`
			: `Applied ${totalApplied} files from remote. Backup at: ${backupDir}${conflictSuffix}`,
		fileChanges: allFileChanges,
		conflicts: allConflicts.length > 0 ? allConflicts : undefined,
		perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
		errors: hasErrors ? errors : undefined,
		dryRun: options.dryRun,
		provisioning: provisioningResult,
	};
}

/**
 * Compares local config, sync repo, and remote for status.
 */
export async function syncStatus(options: SyncOptions): Promise<SyncStatusResult> {
	const { syncRepoDir } = options;

	// Check remote and fetch if available
	verboseLog(options, "Checking remote configuration...");
	const remoteConfigured = await hasRemote(syncRepoDir);
	let gitStatus: {
		ahead: number;
		behind: number;
		current: string | null;
		tracking: string | null;
	};

	if (remoteConfigured) {
		verboseLog(options, "Fetching from remote...");
		await fetchRemote(syncRepoDir);
		const status = await getStatus(syncRepoDir);
		gitStatus = {
			ahead: status.ahead,
			behind: status.behind,
			current: status.current,
			tracking: status.tracking,
		};
	} else {
		const status = await getStatus(syncRepoDir);
		gitStatus = {
			ahead: 0,
			behind: 0,
			current: status.current,
			tracking: null,
		};
	}

	verboseLog(options, "Detecting repo version...");
	const version = await detectRepoVersion(syncRepoDir);
	verboseLog(options, `Repo version: v${version}`);
	const allModifications: FileChange[] = [];
	let totalSynced = 0;
	let totalExcluded = 0;
	const perEnvironment: Record<
		string,
		{ localModifications: FileChange[]; syncedCount: number; excludedCount: number }
	> = {};
	const envs = options.filterEnv
		? (options.environments ?? []).filter((e) => e.id === options.filterEnv)
		: (options.environments ?? []);

	if (envs.length > 0 && version === 2) {
		// v2 multi-environment mode
		for (const env of envs) {
			verboseLog(options, `Comparing environment: ${env.id}`);
			const configDir = env.getConfigDir();
			const homeDir = options.homeDir ?? path.dirname(configDir);
			const repoSubdir = getRepoSubdir(syncRepoDir, env.id, 2);
			const allowlistFn = makeAllowlistFn(env);
			const envMods: FileChange[] = [];

			let localFiles: string[] = [];
			let repoFiles: string[] = [];

			try {
				localFiles = await scanDirectory(configDir, allowlistFn);
			} catch {
				// Config dir doesn't exist
			}

			try {
				repoFiles = await scanDirectory(repoSubdir, allowlistFn);
			} catch {
				// Repo subdir doesn't exist
			}

			verboseLog(
				options,
				`${env.id}: ${localFiles.length} local files, ${repoFiles.length} repo files`,
			);

			const localFileSet = new Set(localFiles);
			const repoFileSet = new Set(repoFiles);

			// Compare local vs repo
			for (const relativePath of localFiles) {
				if (!repoFileSet.has(relativePath)) {
					envMods.push({ path: relativePath, type: "added" });
					allModifications.push({ path: `${env.id}/${relativePath}`, type: "added" });
					continue;
				}
				const localContent = await fs.readFile(path.join(configDir, relativePath), "utf-8");
				const repoContent = await fs.readFile(path.join(repoSubdir, relativePath), "utf-8");
				let normalizedLocal = localContent;
				if (needsPathRewrite(relativePath, env)) {
					normalizedLocal = rewritePathsForRepo(localContent, homeDir);
				}
				if (normalizedLocal !== repoContent) {
					envMods.push({ path: relativePath, type: "modified" });
					allModifications.push({
						path: `${env.id}/${relativePath}`,
						type: "modified",
					});
				}
			}

			for (const repoFile of repoFiles) {
				if (!localFileSet.has(repoFile)) {
					envMods.push({ path: repoFile, type: "deleted" });
					allModifications.push({ path: `${env.id}/${repoFile}`, type: "deleted" });
				}
			}

			// Count excluded files
			let excludedCount = 0;
			try {
				const allEntries = await fs.readdir(configDir, {
					recursive: true,
					withFileTypes: true,
				});
				const totalFiles = allEntries.filter((e) => e.isFile()).length;
				excludedCount = totalFiles - localFiles.length;
			} catch {
				// Config dir doesn't exist
			}

			totalSynced += localFiles.length;
			totalExcluded += excludedCount;
			perEnvironment[env.id] = {
				localModifications: envMods,
				syncedCount: localFiles.length,
				excludedCount,
			};
		}
	} else {
		// v1 flat mode or single-environment fallback
		verboseLog(options, "Using v1 flat mode");
		const { claudeDir, homeDir } = resolveLegacyPaths(options);

		verboseLog(options, `Scanning local: ${claudeDir}`);
		const localFiles = await scanDirectory(claudeDir);
		verboseLog(options, `Scanning repo: ${syncRepoDir}`);
		const repoFiles = await scanDirectory(syncRepoDir);
		verboseLog(options, `${localFiles.length} local files, ${repoFiles.length} repo files`);

		const localFileSet = new Set(localFiles);
		const repoFileSet = new Set(repoFiles);

		for (const relativePath of localFiles) {
			if (!repoFileSet.has(relativePath)) {
				allModifications.push({ path: relativePath, type: "added" });
				continue;
			}
			const localContent = await fs.readFile(path.join(claudeDir, relativePath), "utf-8");
			const repoContent = await fs.readFile(path.join(syncRepoDir, relativePath), "utf-8");
			let normalizedLocal = localContent;
			if (path.basename(relativePath) === "settings.json") {
				normalizedLocal = rewritePathsForRepo(localContent, homeDir);
			}
			if (normalizedLocal !== repoContent) {
				allModifications.push({ path: relativePath, type: "modified" });
			}
		}

		for (const repoFile of repoFiles) {
			if (!localFileSet.has(repoFile)) {
				allModifications.push({ path: repoFile, type: "deleted" });
			}
		}

		// Count excluded files
		try {
			const allEntries = await fs.readdir(claudeDir, {
				recursive: true,
				withFileTypes: true,
			});
			totalExcluded = allEntries.filter((e) => e.isFile()).length - localFiles.length;
		} catch {
			// Can't read
		}
		totalSynced = localFiles.length;
	}

	// Include shared directory files in the status report
	const sharedStatusFiles = await syncSharedDirectory(syncRepoDir);
	totalSynced += sharedStatusFiles.length;

	return {
		localModifications: allModifications,
		remoteDrift: {
			ahead: gitStatus.ahead,
			behind: gitStatus.behind,
		},
		excludedCount: totalExcluded,
		syncedCount: totalSynced,
		branch: gitStatus.current,
		tracking: gitStatus.tracking,
		isClean: allModifications.length === 0 && gitStatus.ahead === 0 && gitStatus.behind === 0,
		hasRemote: remoteConfigured,
		perEnvironment: Object.keys(perEnvironment).length > 0 ? perEnvironment : undefined,
	};
}
