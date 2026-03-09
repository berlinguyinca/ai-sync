import type { Command } from "commander";
import pc from "picocolors";
import type { SyncPullResult } from "../../core/sync-engine.js";
import { syncPull } from "../../core/sync-engine.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

/**
 * Options for the pull command handler.
 */
export interface PullOptions {
	repoPath?: string;
	claudeDir?: string;
}

/**
 * Core pull logic extracted for testability.
 * Delegates to syncPull from the sync engine.
 */
export async function handlePull(options: PullOptions): Promise<SyncPullResult> {
	return syncPull({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
	});
}

/**
 * Registers the "pull" subcommand on the CLI program.
 */
export function registerPullCommand(program: Command): void {
	program
		.command("pull")
		.description("Pull remote changes to local ~/.claude")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.option("-v, --verbose", "Show detailed file changes", false)
		.action(async (opts) => {
			try {
				const result = await handlePull(opts);
				if (opts.verbose && result.fileChanges.length > 0) {
					for (const change of result.fileChanges) {
						const indicator =
							change.type === "modified" ? pc.yellow("M")
							: change.type === "added" ? pc.green("A")
							: pc.red("D");
						console.log(`  ${indicator} ${change.path}`);
					}
				}
				console.log(pc.green(`Pulled ${result.filesApplied} files from remote`));
				console.log(pc.dim(`Backup saved to: ${result.backupDir}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Pull failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
