import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scanDirectory } from "./scanner.js";
import {
	rewritePathsForRepo,
	expandPathsForLocal,
} from "./path-rewriter.js";
import { createBackup } from "./backup.js";
import {
	pushToRemote,
	pullFromRemote,
	fetchRemote,
	getStatus,
	hasRemote,
	addFiles,
	commitFiles,
} from "../git/repo.js";

/**
 * Options for sync operations.
 */
export interface SyncOptions {
	claudeDir: string;
	syncRepoDir: string;
	homeDir?: string;
}

/**
 * Result of a syncPush operation.
 */
export interface SyncPushResult {
	filesUpdated: number;
	pushed: boolean;
	message: string;
	fileChanges: FileChange[];
}

/**
 * Result of a syncPull operation.
 */
export interface SyncPullResult {
	backupDir: string;
	filesApplied: number;
	message: string;
	fileChanges: FileChange[];
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
}

/**
 * Pushes local Claude config files to the sync repo and remote.
 *
 * Scans ~/.claude for allowlisted files, copies them to the sync repo with
 * path rewriting on settings.json, detects deleted files, stages, commits,
 * and pushes to remote.
 *
 * @param options - Sync configuration
 * @returns Push result with filesUpdated count, pushed flag, and message
 * @throws Error if no remote is configured or if remote is ahead
 */
export async function syncPush(options: SyncOptions): Promise<SyncPushResult> {
	const { claudeDir, syncRepoDir } = options;
	const homeDir = options.homeDir ?? path.dirname(claudeDir);

	// Check remote exists
	const remoteConfigured = await hasRemote(syncRepoDir);
	if (!remoteConfigured) {
		throw new Error(
			`No remote configured. Add a remote with: git -C ${syncRepoDir} remote add origin <url>`,
		);
	}

	// Fetch and check if behind
	await fetchRemote(syncRepoDir);
	const preStatus = await getStatus(syncRepoDir);
	if (preStatus.behind > 0) {
		throw new Error(
			"Remote has changes. Run 'claude-sync pull' first.",
		);
	}

	// Scan claudeDir for allowlisted files
	const localFiles = await scanDirectory(claudeDir);

	// Copy each file from claudeDir to syncRepoDir
	for (const relativePath of localFiles) {
		const srcPath = path.join(claudeDir, relativePath);
		const destPath = path.join(syncRepoDir, relativePath);

		await fs.mkdir(path.dirname(destPath), { recursive: true });

		let content = await fs.readFile(srcPath, "utf-8");

		// Apply path rewriting for settings.json
		if (path.basename(relativePath) === "settings.json") {
			content = rewritePathsForRepo(content, homeDir);
		}

		await fs.writeFile(destPath, content);
	}

	// Scan syncRepoDir for repo files and delete files not in local
	const repoFiles = await scanDirectory(syncRepoDir);
	const localFileSet = new Set(localFiles);
	for (const repoFile of repoFiles) {
		if (!localFileSet.has(repoFile)) {
			await fs.rm(path.join(syncRepoDir, repoFile));
		}
	}

	// Check git status
	const status = await getStatus(syncRepoDir);
	if (status.isClean()) {
		// Handle unpushed commits from a previous failed push
		if (status.ahead > 0) {
			await pushToRemote(syncRepoDir);
			return {
				filesUpdated: 0,
				pushed: true,
				message: "Pushed previously committed changes to remote",
				fileChanges: [],
			};
		}
		return {
			filesUpdated: 0,
			pushed: false,
			message: "No changes to push",
			fileChanges: [],
		};
	}

	// Build file change list from git status
	const fileChanges: FileChange[] = status.files.map((f) => ({
		path: f.path,
		type:
			f.working_dir === "?" ? "added"
			: f.working_dir === "D" ? "deleted"
			: "modified",
	}));

	// Stage, commit, push
	await addFiles(syncRepoDir, ["."]);
	await commitFiles(syncRepoDir, "sync: update claude config");
	await pushToRemote(syncRepoDir);

	return {
		filesUpdated: fileChanges.length,
		pushed: true,
		message: `Pushed ${fileChanges.length} files to remote`,
		fileChanges,
	};
}

/**
 * Pulls remote changes into local Claude config directory.
 *
 * Creates a backup of current state first, then git pulls from remote,
 * then copies repo files to ~/.claude with path expansion on settings.json.
 *
 * @param options - Sync configuration
 * @returns Pull result with backupDir, filesApplied count, and message
 * @throws Error if no remote is configured or if backup creation fails
 */
export async function syncPull(options: SyncOptions): Promise<SyncPullResult> {
	const { claudeDir, syncRepoDir } = options;
	const homeDir = options.homeDir ?? path.dirname(claudeDir);

	// Check remote exists
	const remoteConfigured = await hasRemote(syncRepoDir);
	if (!remoteConfigured) {
		throw new Error(
			`No remote configured. Add a remote with: git -C ${syncRepoDir} remote add origin <url>`,
		);
	}

	// Create backup before applying any changes
	const backupBaseDir = path.join(
		path.dirname(syncRepoDir),
		".claude-sync-backups",
	);
	const backupDir = await createBackup(claudeDir, backupBaseDir);

	// Pull from remote
	await pullFromRemote(syncRepoDir);

	// Scan repo for files to apply
	const repoFiles = await scanDirectory(syncRepoDir);

	// Copy each file from syncRepoDir to claudeDir, tracking changes
	const fileChanges: FileChange[] = [];

	for (const relativePath of repoFiles) {
		const srcPath = path.join(syncRepoDir, relativePath);
		const destPath = path.join(claudeDir, relativePath);

		await fs.mkdir(path.dirname(destPath), { recursive: true });

		let content = await fs.readFile(srcPath, "utf-8");

		// Apply path expansion for settings.json
		if (path.basename(relativePath) === "settings.json") {
			content = expandPathsForLocal(content, homeDir);
		}

		// Detect whether this is a new file or a content change
		let changeType: FileChange["type"] | null = null;
		try {
			const existing = await fs.readFile(destPath, "utf-8");
			if (existing !== content) {
				changeType = "modified";
			}
		} catch {
			changeType = "added";
		}

		await fs.writeFile(destPath, content);

		if (changeType) {
			fileChanges.push({ path: relativePath, type: changeType });
		}
	}

	// Remove local files that no longer exist in the repo (propagate deletions)
	const localFiles = await scanDirectory(claudeDir);
	const repoFileSet = new Set(repoFiles);
	for (const localFile of localFiles) {
		if (!repoFileSet.has(localFile)) {
			await fs.rm(path.join(claudeDir, localFile));
			fileChanges.push({ path: localFile, type: "deleted" });
		}
	}

	return {
		backupDir,
		filesApplied: repoFiles.length,
		message: `Applied ${repoFiles.length} files from remote. Backup at: ${backupDir}`,
		fileChanges,
	};
}

/**
 * Compares local Claude config, sync repo, and remote for status.
 *
 * Fetches remote (if configured), compares local files vs repo files
 * (normalizing settings.json paths), and reports ahead/behind counts.
 *
 * @param options - Sync configuration
 * @returns Status result with localModifications, remoteDrift, excludedCount, etc.
 */
export async function syncStatus(
	options: SyncOptions,
): Promise<SyncStatusResult> {
	const { claudeDir, syncRepoDir } = options;
	const homeDir = options.homeDir ?? path.dirname(claudeDir);

	// Check remote and fetch if available
	const remoteConfigured = await hasRemote(syncRepoDir);
	let gitStatus: { ahead: number; behind: number; current: string | null; tracking: string | null };

	if (remoteConfigured) {
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

	// Scan both directories.
	// Both scanDirectory calls return normalized forward-slash paths (via normalizePath
	// in scanner.ts), ensuring Set comparisons work consistently across platforms.
	const localFiles = await scanDirectory(claudeDir);
	const repoFiles = await scanDirectory(syncRepoDir);

	const localFileSet = new Set(localFiles);
	const repoFileSet = new Set(repoFiles);

	const modifications: FileChange[] = [];

	// Compare local files against repo
	for (const relativePath of localFiles) {
		if (!repoFileSet.has(relativePath)) {
			// File exists locally but not in repo
			modifications.push({ path: relativePath, type: "added" });
			continue;
		}

		// Both exist -- compare content
		const localContent = await fs.readFile(
			path.join(claudeDir, relativePath),
			"utf-8",
		);
		const repoContent = await fs.readFile(
			path.join(syncRepoDir, relativePath),
			"utf-8",
		);

		// Normalize settings.json for comparison
		let normalizedLocal = localContent;
		if (path.basename(relativePath) === "settings.json") {
			normalizedLocal = rewritePathsForRepo(localContent, homeDir);
		}

		if (normalizedLocal !== repoContent) {
			modifications.push({ path: relativePath, type: "modified" });
		}
	}

	// Check for files in repo but not local (deleted locally)
	for (const repoFile of repoFiles) {
		if (!localFileSet.has(repoFile)) {
			modifications.push({ path: repoFile, type: "deleted" });
		}
	}

	// Count excluded files: total files in claudeDir minus allowlisted count
	let totalFiles = 0;
	try {
		const allEntries = await fs.readdir(claudeDir, {
			recursive: true,
			withFileTypes: true,
		});
		totalFiles = allEntries.filter((e) => e.isFile()).length;
	} catch {
		// If we can't read, excluded count is 0
	}
	const excludedCount = totalFiles - localFiles.length;

	return {
		localModifications: modifications,
		remoteDrift: {
			ahead: gitStatus.ahead,
			behind: gitStatus.behind,
		},
		excludedCount,
		syncedCount: localFiles.length,
		branch: gitStatus.current,
		tracking: gitStatus.tracking,
		isClean: modifications.length === 0 && gitStatus.ahead === 0 && gitStatus.behind === 0,
		hasRemote: remoteConfigured,
	};
}
