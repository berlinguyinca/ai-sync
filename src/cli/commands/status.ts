import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { classifyDrift, type DriftReport } from "../../core/drift.js";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import type { Environment } from "../../core/environment.js";
import { createAdapter } from "../../core/merge/adapters/index.js";
import { loadMergeConfig } from "../../core/merge/config.js";
import { buildSummaryPrompt, type SummaryDiffData } from "../../core/merge/prompts.js";
import { summarizeWithResolver } from "../../core/merge/summarize.js";
import { verifyTool } from "../../core/provisioner.js";
import type { SyncStatusResult } from "../../core/sync-engine.js";
import { syncStatus } from "../../core/sync-engine.js";
import { ToolManifestSchema } from "../../core/tool-manifest.js";
import { fetchRemote, hasRemote } from "../../git/repo.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";
import { printFileChanges } from "../format.js";

/** Maximum number of lines of file-path payload to ship to the resolver per env. */
const SUMMARIZE_LINE_CAP = 200;

/**
 * Options for the status command handler.
 */
export interface StatusOptions {
	repoPath?: string;
	claudeDir?: string;
	env?: string;
	verbose?: boolean;
	/** Opt-in: ask the configured resolver to produce a drift summary. */
	summarize?: boolean;
	/** Override the environment list (testing). */
	environments?: Environment[];
	/** Override the home dir used for path-rewrite normalization (testing). */
	homeDir?: string;
	/** Test seam: override the availability probe (`adapter.available()`). */
	availableFn?: (resolverName: string) => Promise<boolean>;
	/** Test seam: override the resolver invocation used for summarize. */
	summarizeFn?: (resolverName: string, prompt: string) => Promise<string>;
}

/**
 * Aggregated outcome of `ai-sync status --summarize` per env. Exported for
 * tests that want to assert resolver invocation count without parsing
 * stdout.
 */
export interface SummarizeResult {
	envName: string;
	/** "ok" — resolver returned a summary; text is in `summary`. */
	/** "skipped-no-drift" — env had zero drift, resolver not invoked. */
	/** "unavailable" — adapter.available() returned false. */
	/** "error" — resolver call rejected; message captured. */
	status: "ok" | "skipped-no-drift" | "unavailable" | "error";
	summary?: string;
	error?: string;
}

/**
 * Core status logic extracted for testability.
 * Delegates to syncStatus from the sync engine.
 */
export async function handleStatus(options: StatusOptions): Promise<SyncStatusResult> {
	const environments = options.environments ?? getEnabledEnvironmentInstances();
	return syncStatus({
		claudeDir: options.claudeDir ?? getClaudeDir(),
		syncRepoDir: options.repoPath ?? getSyncRepoDir(),
		environments,
		filterEnv: options.env,
		verbose: options.verbose,
	});
}

/**
 * Computes the drift report for every enabled environment.
 *
 * Fetches the remote (when configured) so the report reflects up-to-date
 * remote state without modifying the working tree.
 */
export async function handleStatusDrift(options: StatusOptions): Promise<DriftReport[]> {
	const syncRepoDir = options.repoPath ?? getSyncRepoDir();
	const homeDir = options.homeDir ?? os.homedir();
	let environments: Environment[];
	if (options.environments) {
		environments = options.environments;
	} else if (options.claudeDir) {
		// Legacy v1 single-env mode: build a synthetic claude env pointed at
		// the explicit --claude-dir so the drift report doesn't accidentally
		// scan the operator's real home directory during tests.
		environments = [makeSyntheticClaudeEnv(options.claudeDir)];
	} else {
		environments = getEnabledEnvironmentInstances();
	}
	if (options.env) {
		environments = environments.filter((e) => e.id === options.env);
	}
	try {
		if (await hasRemote(syncRepoDir)) {
			await fetchRemote(syncRepoDir);
		}
	} catch {
		// Network or no-remote — drift will use HEAD as remote fallback.
	}
	return classifyDrift(environments, syncRepoDir, homeDir);
}

/**
 * Builds an Environment that points at an explicit claudeDir. Used when the
 * CLI is invoked with `--claude-dir` (legacy v1 mode) so drift classification
 * stays scoped to the directory the operator named.
 */
function makeSyntheticClaudeEnv(claudeDir: string): Environment {
	return {
		id: "claude",
		displayName: "Claude Code",
		getConfigDir: () => claudeDir,
		getSyncTargets: () => [
			"settings.json",
			"CLAUDE.md",
			"agents/",
			"commands/",
			"hooks/",
			"get-shit-done/",
			"package.json",
			"gsd-file-manifest.json",
			"skills/",
			"rules/",
			"keybindings.json",
		],
		getPluginSyncPatterns: () => [],
		getIgnorePatterns: () => [],
		getPathRewriteTargets: () => ["settings.json"],
		getSkillsSubdir: () => "commands",
	};
}

/**
 * Renders the drift report to stdout using picocolors. When `verbose` is true
 * the filenames in each non-empty bucket are listed beneath the counts.
 */
export function printDriftReport(reports: DriftReport[], verbose: boolean): void {
	if (reports.length === 0) {
		console.log(pc.dim("No environments enabled."));
		return;
	}
	for (const r of reports) {
		const lo = r.localOnly.length;
		const ro = r.remoteOnly.length;
		const bc = r.bothChanged.length;
		const sp = r.stagedPending.length;
		console.log(
			pc.cyan(`Env ${r.envName}:`) +
				` local-only=${lo} remote-only=${ro} both-changed=${bc} staged-pending=${sp}`,
		);
		if (verbose) {
			if (lo > 0) {
				console.log(pc.dim("  local-only:"));
				for (const f of r.localOnly) console.log(pc.dim(`    ${f}`));
			}
			if (ro > 0) {
				console.log(pc.dim("  remote-only:"));
				for (const f of r.remoteOnly) console.log(pc.dim(`    ${f}`));
			}
			if (bc > 0) {
				console.log(pc.yellow("  both-changed:"));
				for (const f of r.bothChanged) console.log(pc.yellow(`    ${f}`));
			}
			if (sp > 0) {
				console.log(pc.dim("  staged-pending:"));
				for (const f of r.stagedPending) console.log(pc.dim(`    ${f}`));
			}
		}
	}
}

/**
 * Translates a drift report into the SummaryDiffData payload, capping the
 * combined entry count so we never ship an unbounded prompt to the
 * resolver.
 */
function buildDiffDataFromReport(r: DriftReport, lineCap: number): SummaryDiffData {
	const data: SummaryDiffData = { localOnly: [], remoteOnly: [], bothChanged: [] };
	let remaining = lineCap;
	const push = (
		bucket: "localOnly" | "remoteOnly" | "bothChanged",
		files: string[],
		side: "local" | "remote" | "both",
	): void => {
		for (const relativePath of files) {
			if (remaining <= 0) return;
			data[bucket].push({ relativePath, side });
			remaining--;
		}
	};
	push("bothChanged", r.bothChanged, "both");
	push("localOnly", r.localOnly, "local");
	push("remoteOnly", r.remoteOnly, "remote");
	return data;
}

/**
 * Default availability probe — instantiates the configured adapter and
 * delegates to `adapter.available()`.
 */
async function defaultAvailable(resolverName: string): Promise<boolean> {
	const adapter = createAdapter(resolverName as "claude" | "codex" | "opencode");
	return adapter.available();
}

/**
 * Runs the resolver in "summarize differences" mode for every env that
 * has any drift. Returns one entry per env in the input order so callers
 * can render output in a deterministic layout. Never throws — resolver
 * failures are captured per-env.
 */
export async function handleStatusSummarize(
	reports: DriftReport[],
	resolverName: "claude" | "codex" | "opencode",
	options: {
		availableFn?: (name: string) => Promise<boolean>;
		summarizeFn?: (name: string, prompt: string) => Promise<string>;
		timeoutMs?: number;
	} = {},
): Promise<SummarizeResult[]> {
	const availableFn = options.availableFn ?? defaultAvailable;
	const summarizeFn =
		options.summarizeFn ??
		((name, prompt) =>
			summarizeWithResolver(name as "claude" | "codex" | "opencode", prompt, {
				timeoutMs: options.timeoutMs,
			}));

	// Probe availability once — the same resolver is used for every env.
	let isAvailable = false;
	try {
		isAvailable = await availableFn(resolverName);
	} catch {
		isAvailable = false;
	}

	const results: SummarizeResult[] = [];
	for (const r of reports) {
		const hasDrift = r.localOnly.length + r.remoteOnly.length + r.bothChanged.length > 0;
		if (!hasDrift) {
			results.push({ envName: r.envName, status: "skipped-no-drift" });
			continue;
		}
		if (!isAvailable) {
			results.push({ envName: r.envName, status: "unavailable" });
			continue;
		}
		const diffData = buildDiffDataFromReport(r, SUMMARIZE_LINE_CAP);
		const prompt = buildSummaryPrompt(r.envName, diffData);
		try {
			const summary = await summarizeFn(resolverName, prompt);
			results.push({ envName: r.envName, status: "ok", summary: summary.trim() });
		} catch (err) {
			results.push({
				envName: r.envName,
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return results;
}

/**
 * Renders summarize results under each env header. Mirrors
 * {@link printDriftReport} formatting conventions.
 */
export function printSummarizeResults(results: SummarizeResult[], resolverName: string): void {
	for (const r of results) {
		if (r.status === "ok") {
			console.log(pc.cyan(`  Summary (via ${resolverName}):`));
			for (const line of (r.summary ?? "").split("\n")) {
				console.log(`    ${line}`);
			}
		} else if (r.status === "unavailable") {
			console.log(
				pc.yellow(
					`  Resolver '${resolverName}' not available — install or change tools/merge-config.json`,
				),
			);
		} else if (r.status === "error") {
			console.log(pc.yellow(`  Summary skipped for ${r.envName}: ${r.error ?? "unknown error"}`));
		}
		// skipped-no-drift: silent — counts already showed 0s.
	}
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
		.option(
			"--summarize",
			"Invoke the configured AI resolver to produce a natural-language drift summary",
			false,
		)
		.action(async (opts) => {
			try {
				const result = await handleStatus(opts);

				if (!result.hasRemote) {
					console.log(pc.yellow("No remote configured"));
				}

				// Drift report (per env) — runs before legacy sections so the
				// new structured output is the headline.
				try {
					const drift = await handleStatusDrift(opts);
					printDriftReport(drift, !!opts.verbose);
					if (opts.summarize) {
						try {
							const mergeConfig = await loadMergeConfig(opts.repoPath ?? getSyncRepoDir());
							const results = await handleStatusSummarize(drift, mergeConfig.resolver, {
								availableFn: opts.availableFn,
								summarizeFn: opts.summarizeFn,
								timeoutMs: mergeConfig.timeoutSeconds * 1000,
							});
							printSummarizeResults(results, mergeConfig.resolver);
						} catch (summaryErr) {
							console.log(
								pc.yellow(
									`Summary skipped: ${
										summaryErr instanceof Error ? summaryErr.message : String(summaryErr)
									}`,
								),
							);
						}
					}
				} catch (driftErr) {
					if (opts.verbose) {
						console.error(
							pc.yellow(
								`  [verbose] drift report skipped: ${
									driftErr instanceof Error ? driftErr.message : String(driftErr)
								}`,
							),
						);
					}
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
