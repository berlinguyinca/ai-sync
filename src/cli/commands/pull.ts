import type { Command } from "commander";
import pc from "picocolors";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import type { SyncPullResult } from "../../core/sync-engine.js";
import { syncPull } from "../../core/sync-engine.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";
import { printFileChanges } from "../format.js";

/**
 * Options for the pull command handler.
 */
export interface PullOptions {
	repoPath?: string;
	claudeDir?: string;
	dryRun?: boolean;
	env?: string;
	verbose?: boolean;
	force?: boolean;
	noProvision?: boolean;
}

/**
 * Core pull logic extracted for testability.
 * Delegates to syncPull from the sync engine.
 */
export async function handlePull(options: PullOptions): Promise<SyncPullResult> {
	const environments = getEnabledEnvironmentInstances();
	return syncPull({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
		environments,
		dryRun: options.dryRun,
		filterEnv: options.env,
		verbose: options.verbose,
		force: options.force,
		noProvision: options.noProvision,
	});
}

/**
 * Registers the "pull" subcommand on the CLI program.
 */
export function registerPullCommand(program: Command): void {
	program
		.command("pull")
		.description("Pull remote changes to local config directories")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.option("-v, --verbose", "Show detailed file changes", false)
		.option("-n, --dry-run", "Show what would be pulled without making changes", false)
		.option("-f, --force", "Overwrite locally modified files instead of preserving them", false)
		.option("--env <id>", "Only pull a specific environment (e.g., claude or opencode)")
		.option("--no-provision", "Skip tool provisioning", false)
		.action(
			async (opts: {
				repoPath?: string;
				claudeDir?: string;
				verbose: boolean;
				dryRun: boolean;
				force: boolean;
				env?: string;
				provision: boolean;
			}) => {
				try {
					const result = await handlePull({ ...opts, noProvision: !opts.provision });
					if (result.errors) {
						for (const [envId, message] of Object.entries(result.errors)) {
							console.error(pc.red(`  ${envId}: ${message}`));
						}
					}
					if (opts.verbose && result.fileChanges.length > 0) {
						printFileChanges(result.fileChanges);
					}
					if (result.dryRun) {
						console.log(pc.cyan(result.message));
					} else if (result.fileChanges.length > 0) {
						console.log(pc.green(`Pulled ${result.fileChanges.length} changed files from remote`));
					} else {
						console.log(pc.green("Pulled from remote -- already up to date"));
					}
					if (result.conflicts && result.conflicts.length > 0) {
						console.log(
							pc.yellow(
								`\n${result.conflicts.length} file(s) had local changes — kept local versions:`,
							),
						);
						for (const c of result.conflicts) {
							const label = c.type === "deleted" ? "(remote deleted)" : "(both modified)";
							console.log(pc.yellow(`  ${c.path} ${label}`));
						}
						console.log(
							pc.yellow(
								"\nRun 'ai-sync push' to publish your local changes, or 'ai-sync pull --force' to overwrite.",
							),
						);
					}
					if (!result.dryRun && result.backupDir) {
						console.log(pc.dim(`Backup saved to: ${result.backupDir}`));
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(pc.red(`Pull failed: ${message}`));
					process.exitCode = 1;
				}
			},
		);
}
