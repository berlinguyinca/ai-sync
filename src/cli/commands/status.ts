import type { Command } from "commander";
import pc from "picocolors";
import { syncStatus } from "../../core/sync-engine.js";
import type { SyncStatusResult } from "../../core/sync-engine.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

/**
 * Options for the status command handler.
 */
export interface StatusOptions {
	repoPath?: string;
	claudeDir?: string;
}

/**
 * Core status logic extracted for testability.
 * Delegates to syncStatus from the sync engine.
 */
export async function handleStatus(options: StatusOptions): Promise<SyncStatusResult> {
	return syncStatus({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
	});
}

/**
 * Type indicator for file change display.
 */
function changeTypeIndicator(type: "modified" | "added" | "deleted"): string {
	switch (type) {
		case "modified":
			return pc.yellow("M");
		case "added":
			return pc.green("A");
		case "deleted":
			return pc.red("D");
	}
}

/**
 * Registers the "status" subcommand on the CLI program.
 */
export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show sync status between local ~/.claude and remote")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.action(async (opts) => {
			try {
				const result = await handleStatus(opts);

				if (!result.hasRemote) {
					console.log(pc.yellow("No remote configured"));
				}

				if (
					result.isClean &&
					result.remoteDrift.ahead === 0 &&
					result.remoteDrift.behind === 0
				) {
					console.log(pc.green("Everything is in sync"));
				} else {
					// Local modifications
					if (result.localModifications.length > 0) {
						console.log("Local changes:");
						for (const change of result.localModifications) {
							console.log(`  ${changeTypeIndicator(change.type)} ${change.path}`);
						}
					}

					// Remote drift
					if (result.remoteDrift.behind > 0) {
						console.log(
							pc.yellow(
								`Remote is ${result.remoteDrift.behind} commit(s) ahead -- run 'claude-sync pull'`,
							),
						);
					}
					if (result.remoteDrift.ahead > 0) {
						console.log(
							`Local is ${result.remoteDrift.ahead} commit(s) ahead -- run 'claude-sync push'`,
						);
					}
				}

				console.log(
					pc.dim(`Excluded: ${result.excludedCount} files (not in sync manifest)`),
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Status failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
