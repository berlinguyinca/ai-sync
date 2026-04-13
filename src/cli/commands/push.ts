import type { Command } from "commander";
import pc from "picocolors";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import type { SyncPushResult } from "../../core/sync-engine.js";
import { syncPush } from "../../core/sync-engine.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";
import { printFileChanges } from "../format.js";

/**
 * Options for the push command handler.
 */
export interface PushOptions {
	repoPath?: string;
	claudeDir?: string;
	dryRun?: boolean;
	env?: string;
	verbose?: boolean;
	skipDiscovery?: boolean;
}

/**
 * Core push logic extracted for testability.
 * Delegates to syncPush from the sync engine.
 */
export async function handlePush(options: PushOptions): Promise<SyncPushResult> {
	const environments = getEnabledEnvironmentInstances();
	return syncPush({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
		environments,
		dryRun: options.dryRun,
		filterEnv: options.env,
		verbose: options.verbose,
		skipDiscovery: options.skipDiscovery,
	});
}

/**
 * Prints per-environment error summary if any errors occurred.
 */
function printErrors(errors: Record<string, string>): void {
	for (const [envId, message] of Object.entries(errors)) {
		console.error(pc.red(`  ${envId}: ${message}`));
	}
}

/**
 * Registers the "push" subcommand on the CLI program.
 */
export function registerPushCommand(program: Command): void {
	program
		.command("push")
		.description("Push local config changes to the remote repo")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.option("-v, --verbose", "Show detailed file changes", false)
		.option("-n, --dry-run", "Show what would be pushed without making changes", false)
		.option("--env <id>", "Only push a specific environment (e.g., claude or opencode)")
		.option("--skip-discovery", "Skip tool discovery", false)
		.action(
			async (opts: {
				repoPath?: string;
				claudeDir?: string;
				verbose: boolean;
				dryRun: boolean;
				env?: string;
				skipDiscovery: boolean;
			}) => {
				try {
					const result = await handlePush(opts);
					if (result.errors) {
						console.error(pc.red("Errors during push:"));
						printErrors(result.errors);
					}
					if (result.dryRun) {
						if (opts.verbose && result.fileChanges.length > 0) {
							printFileChanges(result.fileChanges);
						}
						console.log(pc.cyan(result.message));
					} else if (result.pushed) {
						if (opts.verbose && result.fileChanges.length > 0) {
							printFileChanges(result.fileChanges);
						}
						console.log(pc.green(result.message));
					} else {
						console.log(pc.yellow("No changes to push -- already up to date"));
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(pc.red(`Push failed: ${message}`));
					process.exitCode = 1;
				}
			},
		);
}
