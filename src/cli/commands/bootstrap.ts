import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { simpleGit } from "simple-git";
import { createBackup } from "../../core/backup.js";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import { makeAllowlistFn, needsPathRewrite } from "../../core/env-helpers.js";
import { detectRepoVersion } from "../../core/migration.js";
import { expandPathsForLocal } from "../../core/path-rewriter.js";
import { scanDirectory } from "../../core/scanner.js";
import { installSkills } from "../../core/skills.js";
import { isGitRepo } from "../../git/repo.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

/**
 * Checks SSH connectivity to the host in the given URL.
 * Returns null on success, or an error message string on failure.
 */
function checkSshConnectivity(repoUrl: string): string | null {
	// Only check for SSH-style URLs
	const sshMatch = repoUrl.match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)/);
	if (!sshMatch && !repoUrl.includes("git@")) return null;

	const host = sshMatch?.[1] ?? "github.com";

	// Validate hostname to prevent command injection — only allow DNS-safe characters
	if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
		return `Invalid hostname in repository URL: ${host}`;
	}

	try {
		execSync(`ssh -T -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${host}`, {
			stdio: "pipe",
			timeout: 10_000,
		});
		return null;
	} catch (error) {
		// ssh -T to github returns exit code 1 on success (with "Hi user!" message)
		if (error && typeof error === "object" && "stderr" in error) {
			const stderr = String((error as { stderr: unknown }).stderr);
			if (stderr.includes("successfully authenticated") || stderr.includes("Hi ")) {
				return null;
			}
		}
		return (
			`SSH connection to ${host} failed. Check that:\n` +
			"  1. Your SSH key is added to the agent: ssh-add -l\n" +
			"  2. Your key is registered on GitHub: gh ssh-key list\n" +
			"  3. You can reach the host: ssh -T " +
			host
		);
	}
}

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
 */
export async function handleBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
	const syncRepoDir = options.repoPath ?? getSyncRepoDir();
	const claudeDir = options.claudeDir ?? getClaudeDir();
	const homeDir = path.dirname(claudeDir);
	const environments = getEnabledEnvironmentInstances();

	// Guard: sync repo must not already exist (unless --force)
	if (await isGitRepo(syncRepoDir)) {
		if (!options.force) {
			throw new Error(`Sync repo already exists at ${syncRepoDir}. Use --force to re-clone.`);
		}
		await fs.rm(syncRepoDir, { recursive: true, force: true });
	}

	// Validate SSH connectivity for SSH URLs before attempting clone
	const sshError = checkSshConnectivity(options.repoUrl);
	if (sshError) {
		throw new Error(sshError);
	}

	// Clone the remote repo
	try {
		await simpleGit().clone(options.repoUrl, syncRepoDir);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Clone failed: check your repository URL and authentication. Details: ${msg}`);
	}

	const version = await detectRepoVersion(syncRepoDir);
	let backupDir: string | null = null;
	let totalApplied = 0;

	if (version === 2 && environments.length > 0) {
		// v2 multi-environment mode
		for (const env of environments) {
			const configDir = env.id === "claude" ? claudeDir : env.getConfigDir();
			const envHomeDir = path.dirname(configDir);
			const repoSubdir = path.join(syncRepoDir, env.id);
			const allowlistFn = makeAllowlistFn(env);

			// Create config dir if needed
			await fs.mkdir(configDir, { recursive: true });

			// Backup existing config
			try {
				const existingFiles = await scanDirectory(configDir, allowlistFn);
				if (existingFiles.length > 0) {
					const backupBaseDir = path.join(path.dirname(syncRepoDir), ".ai-sync-backups");
					if (!backupDir) {
						const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
						backupDir = path.join(backupBaseDir, timestamp);
					}
					const envBackupDir = path.join(backupDir, env.id);
					await fs.mkdir(envBackupDir, { recursive: true });
					for (const relativePath of existingFiles) {
						const srcPath = path.join(configDir, relativePath);
						const destPath = path.join(envBackupDir, relativePath);
						await fs.mkdir(path.dirname(destPath), { recursive: true });
						await fs.copyFile(srcPath, destPath);
					}
				}
			} catch {
				// No existing files
			}

			// Apply repo files to config dir
			try {
				const repoFiles = await scanDirectory(repoSubdir, allowlistFn);
				for (const relativePath of repoFiles) {
					const srcPath = path.join(repoSubdir, relativePath);
					const destPath = path.join(configDir, relativePath);
					await fs.mkdir(path.dirname(destPath), { recursive: true });
					let content = await fs.readFile(srcPath, "utf-8");
					if (needsPathRewrite(relativePath, env)) {
						content = expandPathsForLocal(content, envHomeDir);
					}
					await fs.writeFile(destPath, content);
				}
				totalApplied += repoFiles.length;
			} catch {
				// No subdir for this env in repo
			}
		}

		// Install skills for all environments
		await installSkills(claudeDir, environments);
	} else {
		// v1 flat mode
		await fs.mkdir(claudeDir, { recursive: true });

		// Backup existing config
		try {
			const existingFiles = await scanDirectory(claudeDir);
			if (existingFiles.length > 0) {
				const backupBaseDir = path.join(path.dirname(syncRepoDir), ".ai-sync-backups");
				backupDir = await createBackup(claudeDir, backupBaseDir);
			}
		} catch {
			// No existing files
		}

		// Apply repo files
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
		totalApplied = repoFiles.length;

		await installSkills(claudeDir);
	}

	return {
		syncRepoDir,
		claudeDir,
		filesApplied: totalApplied,
		backupDir,
		message: backupDir
			? `Bootstrapped ${totalApplied} files from ${options.repoUrl}. Backup at: ${backupDir}`
			: `Bootstrapped ${totalApplied} files from ${options.repoUrl}`,
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
					console.log(pc.green(`  Config dir: ${result.claudeDir}`));
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
