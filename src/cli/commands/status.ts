import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import { verifyTool } from "../../core/provisioner.js";
import type { SyncStatusResult } from "../../core/sync-engine.js";
import { syncStatus } from "../../core/sync-engine.js";
import { ToolManifestSchema } from "../../core/tool-manifest.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";
import { printFileChanges } from "../format.js";

/**
 * Options for the status command handler.
 */
export interface StatusOptions {
	repoPath?: string;
	claudeDir?: string;
	env?: string;
	verbose?: boolean;
}

/**
 * Core status logic extracted for testability.
 * Delegates to syncStatus from the sync engine.
 */
export async function handleStatus(options: StatusOptions): Promise<SyncStatusResult> {
	const environments = getEnabledEnvironmentInstances();
	return syncStatus({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
		environments,
		filterEnv: options.env,
		verbose: options.verbose,
	});
}

/**
 * Registers the "status" subcommand on the CLI program.
 */
export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show sync status between local config and remote")
		.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.option("-v, --verbose", "Show detailed sync info", false)
		.option("--env <id>", "Show status for a specific environment only")
		.action(async (opts) => {
			try {
				const result = await handleStatus(opts);

				if (!result.hasRemote) {
					console.log(pc.yellow("No remote configured"));
				}

				if (opts.verbose) {
					if (result.branch) {
						console.log(pc.dim(`Branch: ${result.branch}`));
					}
					if (result.tracking) {
						console.log(pc.dim(`Tracking: ${result.tracking}`));
					}
				}

				if (result.isClean) {
					console.log(pc.green("Everything is in sync"));
				} else {
					// Local modifications
					if (result.localModifications.length > 0) {
						console.log("Local changes:");
						printFileChanges(result.localModifications);
					}

					// Remote drift
					if (result.remoteDrift.behind > 0) {
						console.log(
							pc.yellow(
								`Remote is ${result.remoteDrift.behind} commit(s) ahead -- run 'ai-sync pull'`,
							),
						);
					}
					if (result.remoteDrift.ahead > 0) {
						console.log(
							`Local is ${result.remoteDrift.ahead} commit(s) ahead -- run 'ai-sync push'`,
						);
					}
				}

				if (opts.verbose) {
					console.log(pc.dim(`Synced: ${result.syncedCount} files`));
				}
				console.log(pc.dim(`Excluded: ${result.excludedCount} files (not in sync manifest)`));

				// Tool status from manifest
				const syncRepoDir = opts.repoPath ?? getSyncRepoDir();
				const manifestPath = path.join(syncRepoDir, "tools", "manifest.json");
				try {
					const manifestContent = await fs.readFile(manifestPath, "utf-8");
					const manifest = ToolManifestSchema.parse(JSON.parse(manifestContent));
					if (manifest.tools.length > 0) {
						console.log(pc.dim(`\nTools (${manifest.tools.length}):`));
						for (const tool of manifest.tools) {
							const installed = await verifyTool(tool);
							const status = installed ? pc.green("installed") : pc.yellow("missing");
							console.log(`  ${tool.name} (${tool.type}): ${status}`);
						}
					}
				} catch {
					// No manifest — silently skip
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Status failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
