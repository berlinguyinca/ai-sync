import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { simpleGit } from "simple-git";
import { createBackup } from "../../core/backup.js";
import { expandPathsForLocal } from "../../core/path-rewriter.js";
import { scanDirectory } from "../../core/scanner.js";
import { installSkills } from "../../core/skills.js";
import { isGitRepo } from "../../git/repo.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

export interface BootstrapOptions {
	repoUrl: string;
	repoPath?: string;
	claudeDir?: string;
	force?: boolean;
}

export interface BootstrapResult {
	syncRepoDir: string;
	claudeDir: string;
	filesApplied: number;
	backupDir: string | null;
	message: string;
}

/**
 * Core bootstrap logic: clones a remote sync repo and applies its files locally.
 * This is the inverse of init -- instead of creating a sync repo from local config,
 * it clones a remote repo and applies its contents to ~/.claude.
 */
export async function handleBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
	const syncRepoDir = options.repoPath ?? getSyncRepoDir();
	const claudeDir = options.claudeDir ?? getClaudeDir();
	const homeDir = path.dirname(claudeDir);

	// Guard: sync repo must not already exist (unless --force)
	if (await isGitRepo(syncRepoDir)) {
		if (!options.force) {
			throw new Error(`Sync repo already exists at ${syncRepoDir}. Use --force to re-clone.`);
		}
		await fs.rm(syncRepoDir, { recursive: true, force: true });
	}

	// Clone the remote repo
	try {
		await simpleGit().clone(options.repoUrl, syncRepoDir);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Clone failed: check your repository URL and authentication. Details: ${msg}`);
	}

	// Create ~/.claude if it doesn't exist (new machine)
	await fs.mkdir(claudeDir, { recursive: true });

	// Backup existing config if any allowlisted files exist
	let backupDir: string | null = null;
	try {
		const existingFiles = await scanDirectory(claudeDir);
		if (existingFiles.length > 0) {
			const backupBaseDir = path.join(path.dirname(syncRepoDir), ".claude-sync-backups");
			backupDir = await createBackup(claudeDir, backupBaseDir);
		}
	} catch {
		// No existing files or claudeDir just created -- expected on new machine
	}

	// Apply repo files to claudeDir (same logic as syncPull)
	const repoFiles = await scanDirectory(syncRepoDir);
	for (const relativePath of repoFiles) {
		const srcPath = path.join(syncRepoDir, relativePath);
		const destPath = path.join(claudeDir, relativePath);
		await fs.mkdir(path.dirname(destPath), { recursive: true });
		let content = await fs.readFile(srcPath, "utf-8");
		if (path.basename(relativePath) === "settings.json") {
			content = expandPathsForLocal(content, homeDir);
		}
		await fs.writeFile(destPath, content);
	}

	// Install Claude Code skills (e.g., /sync command)
	await installSkills(claudeDir);

	return {
		syncRepoDir,
		claudeDir,
		filesApplied: repoFiles.length,
		backupDir,
		message: backupDir
			? `Bootstrapped ${repoFiles.length} files from ${options.repoUrl}. Backup at: ${backupDir}`
			: `Bootstrapped ${repoFiles.length} files from ${options.repoUrl}`,
	};
}

/**
 * Registers the "bootstrap" subcommand on the CLI program.
 */
export function registerBootstrapCommand(program: Command): void {
	program
		.command("bootstrap <repo-url>")
		.description("Set up a new machine from an existing remote sync repo")
		.option("--force", "Re-clone even if sync repo already exists", false)
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.action(
			async (repoUrl: string, opts: { force: boolean; repoPath: string; claudeDir: string }) => {
				try {
					const result = await handleBootstrap({
						repoUrl,
						force: opts.force,
						repoPath: opts.repoPath,
						claudeDir: opts.claudeDir,
					});
					console.log(pc.green(`Bootstrapped ${result.filesApplied} files from remote`));
					console.log(pc.green(`  Sync repo: ${result.syncRepoDir}`));
					console.log(pc.green(`  Claude dir: ${result.claudeDir}`));
					if (result.backupDir) {
						console.log(pc.yellow(`  Backup of existing config: ${result.backupDir}`));
					}
					// Check for package.json and suggest npm install
					try {
						await fs.access(path.join(result.claudeDir, "package.json"));
						console.log(pc.dim("  Tip: Run 'npm install' in ~/.claude if plugins require it"));
					} catch {
						// No package.json -- no suggestion needed
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(pc.red(`Bootstrap failed: ${message}`));
					process.exitCode = 1;
				}
			},
		);
}
