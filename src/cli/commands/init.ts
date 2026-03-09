import type { Command } from "commander";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import pc from "picocolors";
import { rewritePathsForRepo } from "../../core/path-rewriter.js";
import { scanDirectory } from "../../core/scanner.js";
import { installSkills } from "../../core/skills.js";
import {
	addFiles,
	commitFiles,
	initRepo,
	isGitRepo,
	writeGitattributes,
} from "../../git/repo.js";
import { getClaudeDir, getHomeDir, getSyncRepoDir } from "../../platform/paths.js";

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
 * Creates a git-backed sync repo from ~/.claude.
 */
export async function handleInit(options: InitOptions): Promise<InitResult> {
	const claudeDir = options.claudeDir ?? getClaudeDir();
	const syncRepoDir = options.repoPath ?? getSyncRepoDir();

	// Check if source ~/.claude exists
	try {
		await fs.access(claudeDir);
	} catch {
		throw new Error(`No ~/.claude directory found at ${claudeDir}`);
	}

	// Check if sync repo already exists
	if (await isGitRepo(syncRepoDir)) {
		if (!options.force) {
			throw new Error(
				`Sync repo already exists at ${syncRepoDir}. Use --force to re-initialize.`,
			);
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
	await commitFiles(
		syncRepoDir,
		"chore: initialize sync repo with line ending config",
	);

	// Scan source directory for allowed files
	const allowedFiles = await scanDirectory(claudeDir);

	// Copy allowed files to sync repo
	const copiedFiles: string[] = [];
	for (const relativePath of allowedFiles) {
		const sourcePath = path.join(claudeDir, relativePath);
		const destPath = path.join(syncRepoDir, relativePath);

		// Ensure parent directory exists
		await fs.mkdir(path.dirname(destPath), { recursive: true });

		// Read source file
		let content = await fs.readFile(sourcePath, "utf-8");

		// Apply path rewriting for settings.json
		// Derive homeDir from claudeDir (claudeDir is typically ~/.claude, so parent is ~)
		if (path.basename(relativePath) === "settings.json") {
			const homeDir = path.dirname(claudeDir);
			content = rewritePathsForRepo(content, homeDir);
		}

		// Write to sync repo
		await fs.writeFile(destPath, content);
		copiedFiles.push(relativePath);
	}

	// Commit synced files
	if (copiedFiles.length > 0) {
		await addFiles(syncRepoDir, copiedFiles);
		await commitFiles(syncRepoDir, "feat: initial sync of claude config");
	}

	// Calculate excluded count (rough: scan all files in source, subtract allowed)
	const allEntries = await fs.readdir(claudeDir, {
		recursive: true,
		withFileTypes: true,
	});
	const totalFiles = allEntries.filter((e) => e.isFile()).length;
	const filesExcluded = totalFiles - copiedFiles.length;

	// Install Claude Code skills (e.g., /sync command)
	await installSkills(claudeDir);

	return {
		syncRepoDir,
		filesSynced: copiedFiles.length,
		filesExcluded,
	};
}

/**
 * Registers the "init" subcommand on the CLI program.
 */
export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize a git-backed sync repo from ~/.claude")
		.option("--force", "Re-initialize an existing sync repo", false)
		.option(
			"--repo-path <path>",
			"Custom path for the sync repo",
			getSyncRepoDir(),
		)
		.action(async (opts: { force: boolean; repoPath: string }) => {
			try {
				const result = await handleInit({
					force: opts.force,
					repoPath: opts.repoPath,
				});

				console.log(
					pc.green(`Sync repo initialized at ${result.syncRepoDir}`),
				);
				console.log(
					pc.green(`  Files synced: ${result.filesSynced}`),
				);
				console.log(
					pc.yellow(`  Files excluded: ${result.filesExcluded}`),
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Error: ${message}`));
				process.exitCode = 1;
			}
		});
}
