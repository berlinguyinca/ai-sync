import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import {
	getEnabledEnvironments,
	isAutoDetecting,
	resetEnvironmentConfig,
	setEnabledEnvironments,
} from "../../core/env-config.js";
import { getEnvironmentById } from "../../core/environment.js";
import {
	type FabricHost,
	type FabricSharedConfig,
	fetchFabricConfig,
	fetchFabricHosts,
} from "../../core/fabric/client.js";
import { loadFabricConfig } from "../../core/fabric/config.js";
import { getRemotes, isGitRepo } from "../../git/repo.js";
import { getSyncRepoDir } from "../../platform/paths.js";
import { handleBootstrap } from "./bootstrap.js";

const NOT_CONFIGURED = "fabric not configured; set AI_SYNC_FABRIC_URL";
const STALE_MS = 60 * 60 * 1000;

function formatAge(ts: string | null, now: number): { text: string; stale: boolean } {
	if (!ts) return { text: "never", stale: true };
	const t = Date.parse(ts);
	if (Number.isNaN(t)) return { text: "unknown", stale: true };
	const sec = Math.max(0, Math.floor((now - t) / 1000));
	const text =
		sec < 60
			? `${sec}s`
			: sec < 3600
				? `${Math.floor(sec / 60)}m`
				: sec < 86400
					? `${Math.floor(sec / 3600)}h`
					: `${Math.floor(sec / 86400)}d`;
	return { text: `${text} ago`, stale: now - t > STALE_MS };
}

/** Strips control characters so remote-supplied text cannot inject terminal escapes. */
function clean(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitising
	return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

const num = (n: number | null): string => (n === null ? "-" : String(n));

/** Renders the host table. Pure; `now` is injectable for tests. */
export function renderFabricStatus(hosts: FabricHost[], now: number = Date.now()): string {
	if (hosts.length === 0) return "No hosts reported by the fabric.";
	const rows = hosts.map((h) => {
		const age = formatAge(h.last_sync_ts, now);
		return {
			cells: [
				clean(h.host_id),
				clean(h.ai_sync_version ?? "-"),
				clean(h.envs_enabled.join(",") || "-"),
				age.text,
				`${num(h.ahead)}/${num(h.behind)}`,
				num(h.drifted_files_count),
				clean(h.last_error ?? ""),
			],
			stale: age.stale,
			error: h.last_error !== null,
		};
	});
	const header = ["HOST", "VERSION", "ENVS", "LAST SYNC", "AHEAD/BEHIND", "DRIFT", "ERROR"];
	const widths = header.map((hd, i) => Math.max(hd.length, ...rows.map((r) => r.cells[i].length)));
	const pad = (cells: string[]) =>
		cells
			.map((c, i) => c.padEnd(widths[i]))
			.join("  ")
			.trimEnd();
	const lines = [pc.bold(pad(header))];
	for (const r of rows) {
		const line = pad(r.cells);
		lines.push(r.error ? pc.red(line) : r.stale ? pc.yellow(line) : line);
	}
	return lines.join("\n");
}

export interface FabricStatusOptions {
	json?: boolean;
	env?: NodeJS.ProcessEnv;
	syncRepoDir?: string;
}

export async function handleFabricStatus(options: FabricStatusOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	try {
		const cfg = await loadFabricConfig(options.syncRepoDir, env);
		if (!cfg) {
			console.log(options.json ? JSON.stringify({ configured: false, hosts: [] }) : NOT_CONFIGURED);
			return;
		}
		const hosts = await fetchFabricHosts(cfg.url, env);
		if (options.json) console.log(JSON.stringify({ configured: true, hosts }, null, 2));
		else console.log(renderFabricStatus(hosts));
	} catch (error) {
		console.error(
			pc.red(`Fabric status failed: ${error instanceof Error ? error.message : error}`),
		);
		process.exitCode = 1;
	}
}

/** Accepts https://, ssh:// and scp-style user@host:path git URLs only. */
export function validateRepoUrl(url: string): string | null {
	if (url.startsWith("-")) return "repo_url must not start with '-'";
	if (/[^\x21-\x7e]/.test(url)) return "repo_url must be printable ASCII without spaces";
	if (/^https:\/\/[^/@]+(@[^/@]+)?\/\S+/.test(url)) return null;
	if (/^ssh:\/\/[^/\s]+\/\S+/.test(url)) return null;
	if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/.test(url)) return null;
	return "repo_url must be an https or ssh git URL";
}

function validateBranch(branch: string): string | null {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) {
		return "branch name is invalid";
	}
	return null;
}

function normalizeRemote(url: string): string {
	return url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

export interface FabricJoinOptions {
	yes?: boolean;
	env?: NodeJS.ProcessEnv;
	syncRepoDir?: string;
	/** Override for tests; defaults to the real config dir. */
	claudeDir?: string;
}

export async function handleFabricJoin(options: FabricJoinOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	const syncRepoDir = options.syncRepoDir ?? getSyncRepoDir();
	try {
		const cfg = await loadFabricConfig(syncRepoDir, env);
		if (!cfg) {
			console.log(NOT_CONFIGURED);
			process.exitCode = 1;
			return;
		}
		const shared = await fetchFabricConfig(cfg.url, env);
		if (!shared) {
			console.error(pc.red("The fabric has no shared config to join (404)."));
			process.exitCode = 1;
			return;
		}
		const problem = validateShared(shared);
		if (problem) {
			console.error(pc.red(`Refusing to join: ${problem}`));
			process.exitCode = 1;
			return;
		}

		let cloneNeeded = true;
		if (await isGitRepo(syncRepoDir)) {
			const remotes = await getRemotes(syncRepoDir);
			const origin = remotes.find((r) => r.name === "origin");
			const existing = origin?.refs.fetch ?? "";
			if (normalizeRemote(existing) !== normalizeRemote(shared.repo_url)) {
				console.error(pc.red(`Sync repo at ${syncRepoDir} already has a different remote.`));
				console.error(`  existing: ${clean(existing) || "(none)"}`);
				console.error(`  fabric:   ${clean(shared.repo_url)}`);
				console.error("Nothing was changed.");
				process.exitCode = 1;
				return;
			}
			cloneNeeded = false;
		}

		const mergeConfigPath = path.join(syncRepoDir, "tools", "merge-config.json");
		console.log(pc.cyan(options.yes ? "Joining fabric:" : "Dry run; would do the following:"));
		console.log(
			cloneNeeded
				? `  - bootstrap ${clean(shared.repo_url)}@${shared.branch} into ${syncRepoDir}`
				: `  - sync repo already tracks ${clean(shared.repo_url)}; no clone needed`,
		);
		console.log(`  - enable environments: ${shared.envs.join(", ") || "(none)"}`);
		console.log(`  - write ${mergeConfigPath} with enabled=${shared.merge_enabled}`);
		if (!options.yes) {
			console.log(pc.dim("Re-run with --yes to apply."));
			return;
		}

		const priorEnvs = isAutoDetecting() ? null : getEnabledEnvironments();
		if (shared.envs.length > 0) setEnabledEnvironments(shared.envs);
		if (cloneNeeded) {
			try {
				await handleBootstrap({
					repoUrl: shared.repo_url,
					branch: shared.branch,
					repoPath: syncRepoDir,
					claudeDir: options.claudeDir,
				});
			} catch (error) {
				// Don't leave environment selection changed by a failed join.
				if (priorEnvs) setEnabledEnvironments(priorEnvs);
				else resetEnvironmentConfig();
				throw error;
			}
		}
		await writeMergeEnabled(mergeConfigPath, shared.merge_enabled);
		console.log(pc.green("Joined fabric."));
		console.log(pc.dim("Run 'ai-sync status' to review; tools/merge-config.json is uncommitted."));
	} catch (error) {
		console.error(pc.red(`Fabric join failed: ${error instanceof Error ? error.message : error}`));
		process.exitCode = 1;
	}
}

function validateShared(shared: FabricSharedConfig): string | null {
	const urlProblem = validateRepoUrl(shared.repo_url);
	if (urlProblem) return urlProblem;
	const branchProblem = validateBranch(shared.branch);
	if (branchProblem) return branchProblem;
	for (const id of shared.envs) {
		if (!getEnvironmentById(id)) return `unknown environment "${clean(id)}"`;
	}
	return null;
}

/** Sets `enabled` in merge-config.json, preserving any other keys already present. */
async function writeMergeEnabled(file: string, enabled: boolean): Promise<void> {
	let current: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf-8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			current = parsed as Record<string, unknown>;
		}
	} catch {
		// absent or unreadable: start fresh
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify({ ...current, enabled }, null, 2)}\n`);
}

export function registerFabricCommand(program: Command): void {
	const fabric = program
		.command("fabric")
		.description("Optional: discover other machines via a fabric control plane");

	fabric
		.command("status")
		.description("Show hosts in the fabric")
		.option("--json", "Output JSON", false)
		.action(async (opts: { json: boolean }) => {
			await handleFabricStatus({ json: opts.json });
		});

	fabric
		.command("join")
		.description("Join the fabric's shared sync repo (dry run unless --yes)")
		.option("--yes", "Apply the changes", false)
		.action(async (opts: { yes: boolean }) => {
			await handleFabricJoin({ yes: opts.yes });
		});
}
