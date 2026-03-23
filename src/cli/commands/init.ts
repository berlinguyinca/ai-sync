import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import { makeAllowlistFn, needsPathRewrite } from "../../core/env-helpers.js";
import { rewritePathsForRepo } from "../../core/path-rewriter.js";
import { scanDirectory } from "../../core/scanner.js";
import { installSkills } from "../../core/skills.js";
import { addFiles, commitFiles, initRepo, isGitRepo, writeGitattributes } from "../../git/repo.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

/**
 * Result of the init command for programmatic inspection.
 */
export interface InitResult {
	syncRepoDir: string;
	filesSynced: number;
	filesExcluded: number;
}

/**
 * Options for the init handler.
 */
export interface InitOptions {
	force?: boolean;
	repoPath?: string;
	claudeDir?: string;
}

/**
 * Core init logic extracted for testability.
 * Creates a git-backed sync repo from local config directories.
 */
export async function handleInit(options: InitOptions): Promise<InitResult> {
	const claudeDir = options.claudeDir ?? getClaudeDir();
	const syncRepoDir = options.repoPath ?? getSyncRepoDir();
	// Use multi-env mode only when claudeDir is NOT explicitly passed
	const useMultiEnv = !options.claudeDir;
	const environments = useMultiEnv ? getEnabledEnvironmentInstances() : [];

	// Check if sync repo already exists
	if (await isGitRepo(syncRepoDir)) {
		if (!options.force) {
			throw new Error(`Sync repo already exists at ${syncRepoDir}. Use --force to re-initialize.`);
		}
		// With --force, remove existing and start fresh
		await fs.rm(syncRepoDir, { recursive: true, force: true });
	}

	// Create sync repo directory
	await fs.mkdir(syncRepoDir, { recursive: true });

	// Initialize git repo
	await initRepo(syncRepoDir);

	// Create .gitattributes as first commit
	await writeGitattributes(syncRepoDir);
	await addFiles(syncRepoDir, [".gitattributes"]);
	await commitFiles(syncRepoDir, "chore: initialize sync repo with line ending config");

	let totalCopied = 0;
	let totalExcluded = 0;

	if (useMultiEnv && environments.length > 0) {
		// v2 multi-environment format
		for (const env of environments) {
			const configDir = env.id === "claude" ? claudeDir : env.getConfigDir();

			try {
				await fs.access(configDir);
			} catch {
				// Config dir doesn't exist, skip
				continue;
			}

			const allowlistFn = makeAllowlistFn(env);
			const allowedFiles = await scanDirectory(configDir, allowlistFn);
			const homeDir = path.dirname(configDir);
			const envSubdir = path.join(syncRepoDir, env.id);

			for (const relativePath of allowedFiles) {
				const sourcePath = path.join(configDir, relativePath);
				const destPath = path.join(envSubdir, relativePath);
				await fs.mkdir(path.dirname(destPath), { recursive: true });
				let content = await fs.readFile(sourcePath, "utf-8");
				if (needsPathRewrite(relativePath, env)) {
					content = rewritePathsForRepo(content, homeDir);
				}
				await fs.writeFile(destPath, content);
			}

			totalCopied += allowedFiles.length;

			// Count excluded
			try {
				const allEntries = await fs.readdir(configDir, {
					recursive: true,
					withFileTypes: true,
				});
				totalExcluded += allEntries.filter((e) => e.isFile()).length - allowedFiles.length;
			} catch {
				// Can't count
			}
		}

		// Write .sync-version
		await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2\n");

		// Commit synced files
		if (totalCopied > 0) {
			await addFiles(syncRepoDir, ["."]);
			await commitFiles(syncRepoDir, "feat: initial sync of config");
		}

		// Best effort: init should still succeed even if skill installation fails
		try {
			await installSkills(claudeDir, environments);
		} catch {
			// Ignore skill install failures here; users can run install-skills later.
		}
	} else {
		// v1 legacy: single claude environment (fallback for no envs)
		try {
			await fs.access(claudeDir);
		} catch {
			throw new Error(`No ~/.claude directory found at ${claudeDir}`);
		}

		const allowedFiles = await scanDirectory(claudeDir);
		const copiedFiles: string[] = [];
		for (const relativePath of allowedFiles) {
			const sourcePath = path.join(claudeDir, relativePath);
			const destPath = path.join(syncRepoDir, relativePath);
			await fs.mkdir(path.dirname(destPath), { recursive: true });
			let content = await fs.readFile(sourcePath, "utf-8");
			if (path.basename(relativePath) === "settings.json") {
				const homeDir = path.dirname(claudeDir);
				content = rewritePathsForRepo(content, homeDir);
			}
			await fs.writeFile(destPath, content);
			copiedFiles.push(relativePath);
		}

		if (copiedFiles.length > 0) {
			await addFiles(syncRepoDir, copiedFiles);
			await commitFiles(syncRepoDir, "feat: initial sync of claude config");
		}

		totalCopied = copiedFiles.length;

		const allEntries = await fs.readdir(claudeDir, {
			recursive: true,
			withFileTypes: true,
		});
		totalExcluded = allEntries.filter((e) => e.isFile()).length - totalCopied;

		try {
			await installSkills(claudeDir);
		} catch {
			// Ignore skill install failures here; users can run install-skills later.
		}
	}

	return {
		syncRepoDir,
		filesSynced: totalCopied,
		filesExcluded: totalExcluded,
	};
}

/**
 * Registers the "init" subcommand on the CLI program.
 */
export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize a git-backed sync repo from local config")
		.option("--force", "Re-initialize an existing sync repo", false)
		.option("--repo-path <path>", "Custom path for the sync repo", getSyncRepoDir())
		.action(async (opts: { force: boolean; repoPath: string }) => {
			try {
				const result = await handleInit({
					force: opts.force,
					repoPath: opts.repoPath,
				});

				console.log(pc.green(`Sync repo initialized at ${result.syncRepoDir}`));
				console.log(pc.green(`  Files synced: ${result.filesSynced}`));
				console.log(pc.yellow(`  Files excluded: ${result.filesExcluded}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Error: ${message}`));
				process.exitCode = 1;
			}
		});
}
