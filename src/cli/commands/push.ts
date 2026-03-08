import type { Command } from "commander";
import pc from "picocolors";
import { syncPush } from "../../core/sync-engine.js";
import type { SyncPushResult } from "../../core/sync-engine.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

/**
 * Options for the push command handler.
 */
export interface PushOptions {
	repoPath?: string;
	claudeDir?: string;
}

/**
 * Core push logic extracted for testability.
 * Delegates to syncPush from the sync engine.
 */
export async function handlePush(options: PushOptions): Promise<SyncPushResult> {
	return syncPush({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
	});
}

/**
 * Registers the "push" subcommand on the CLI program.
 */
export function registerPushCommand(program: Command): void {
	program
		.command("push")
		.description("Push local ~/.claude changes to the remote repo")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.action(async (opts) => {
			try {
				const result = await handlePush(opts);
				if (result.pushed) {
					console.log(pc.green(`Pushed ${result.filesUpdated} files to remote`));
				} else {
					console.log(pc.yellow("No changes to push -- already up to date"));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Push failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
