import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addFiles, commitFiles, getStatus, hasRemote, pushToRemote } from "../git/repo.js";
import { scanDirectory } from "./scanner.js";

export const SYNC_VERSION_FILE = ".sync-version";

/**
 * Detects whether the sync repo uses v1 (flat, claude-only), v2 (subdirectory, multi-env),
 * or v3 (shared/ + tools/ directories) format.
 */
export async function detectRepoVersion(syncRepoDir: string): Promise<1 | 2 | 3> {
	try {
		const content = await fs.readFile(path.join(syncRepoDir, SYNC_VERSION_FILE), "utf-8");
		if (content.trim() === "3") return 3;
		if (content.trim() === "2") return 2;
	} catch {
		// No version file → v1
	}
	return 1;
}

export interface MigrateResult {
	movedFiles: string[];
	message: string;
}

/**
 * Migrates a v1 (flat) sync repo to v2 (subdirectory) format.
 *
 * Moves all root-level allowlisted files into a `claude/` subdirectory,
 * writes `.sync-version` with content "2", commits, and pushes.
 */
export async function migrateToV2(syncRepoDir: string): Promise<MigrateResult> {
	// Check current version
	const version = await detectRepoVersion(syncRepoDir);
	if (version === 2) {
		return { movedFiles: [], message: "Already at v2 format" };
	}

	// Verify repo is clean
	const status = await getStatus(syncRepoDir);
	if (!status.isClean()) {
		throw new Error("Sync repo has uncommitted changes. Commit or discard them before migrating.");
	}

	// Scan for allowlisted files at the repo root (v1 format)
	const files = await scanDirectory(syncRepoDir);

	// Move each file into claude/ subdirectory
	const claudeSubdir = path.join(syncRepoDir, "claude");
	const movedFiles: string[] = [];

	for (const relativePath of files) {
		const srcPath = path.join(syncRepoDir, relativePath);
		const destPath = path.join(claudeSubdir, relativePath);

		await fs.mkdir(path.dirname(destPath), { recursive: true });
		await fs.rename(srcPath, destPath);
		movedFiles.push(relativePath);
	}

	// Clean up empty directories left behind
	await cleanEmptyDirs(syncRepoDir, [".git", "claude"]);

	// Write .sync-version
	await fs.writeFile(path.join(syncRepoDir, SYNC_VERSION_FILE), "2\n");

	// Stage, commit, push
	const postMigrateStatus = await getStatus(syncRepoDir);
	const filesToStage = postMigrateStatus.files.map((f) => f.path);
	if (filesToStage.length > 0) {
		await addFiles(syncRepoDir, filesToStage);
	}
	await commitFiles(syncRepoDir, "chore: migrate to v2 multi-environment repo structure");

	if (await hasRemote(syncRepoDir)) {
		await pushToRemote(syncRepoDir);
	}

	return {
		movedFiles,
		message: `Migrated ${movedFiles.length} files to v2 subdirectory structure`,
	};
}

export interface MigrateV3Result {
	success: boolean;
	message: string;
}

/**
 * Migrates a v2 sync repo to v3 format.
 *
 * Creates shared/ and tools/ directories, writes `.sync-version` with content "3", and commits.
 */
export async function migrateToV3(syncRepoDir: string): Promise<MigrateV3Result> {
	// Check current version — must be v2
	const version = await detectRepoVersion(syncRepoDir);
	if (version === 1) {
		throw new Error("Cannot migrate to v3: repo is at v1. Migrate to v2 first.");
	}
	if (version === 3) {
		return { success: true, message: "Already at v3 format" };
	}

	// Create shared/ directory if not exists
	await fs.mkdir(path.join(syncRepoDir, "shared"), { recursive: true });

	// Create tools/ directory if not exists
	await fs.mkdir(path.join(syncRepoDir, "tools"), { recursive: true });

	// Write .sync-version with "3\n"
	await fs.writeFile(path.join(syncRepoDir, SYNC_VERSION_FILE), "3\n");

	// Stage and commit with explicit file list
	await addFiles(syncRepoDir, [SYNC_VERSION_FILE]);
	await commitFiles(syncRepoDir, "chore: migrate sync repo to v3 format");

	return { success: true, message: "Migrated sync repo to v3 format" };
}

/**
 * Checks that the repo version is known and supported by this version of ai-sync.
 * Throws if the version is greater than 3 (i.e. from a newer tool version).
 */
export function checkVersionCompatibility(repoVersion: number): void {
	if (repoVersion > 3) {
		throw new Error(`Unknown repo version ${repoVersion}. Please update ai-sync.`);
	}
}

/**
 * Removes empty directories under baseDir, excluding specified directory names.
 */
async function cleanEmptyDirs(baseDir: string, exclude: string[]): Promise<void> {
	const entries = await fs.readdir(baseDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (exclude.includes(entry.name)) continue;

		const dirPath = path.join(baseDir, entry.name);
		await cleanEmptyDirsRecursive(dirPath);
	}
}

async function cleanEmptyDirsRecursive(dirPath: string): Promise<boolean> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });

	// Recursively clean subdirectories first
	for (const entry of entries) {
		if (entry.isDirectory()) {
			await cleanEmptyDirsRecursive(path.join(dirPath, entry.name));
		}
	}

	// Re-read after cleaning subdirs
	const remaining = await fs.readdir(dirPath);
	if (remaining.length === 0) {
		await fs.rmdir(dirPath);
		return true;
	}
	return false;
}
