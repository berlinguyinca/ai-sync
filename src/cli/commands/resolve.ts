import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { getEnvironmentById } from "../../core/environment.js";
import {
	acceptStaged,
	getStagedContent,
	listStaged,
	rejectStaged,
	type StagedEntry,
} from "../../core/merge/staging.js";
import { getSyncRepoDir } from "../../platform/paths.js";

export interface ResolveOptions {
	repoPath?: string;
}

export interface ResolveTargetOptions extends ResolveOptions {
	all?: boolean;
}

/** Resolve the sync repo dir from options or fall back to default. */
function resolveRepoPath(options: ResolveOptions): string {
	return options.repoPath ?? getSyncRepoDir();
}

/** Try to read the live (current on-disk) target file, or null if missing. */
async function readLiveTarget(targetPath: string): Promise<string | null> {
	try {
		return await fs.readFile(targetPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/**
 * Resolves the absolute live target path for an entry:
 * `<env.getConfigDir()>/<entry.relativePath>`. Returns null when the env is
 * unknown.
 */
function resolveTargetPath(entry: StagedEntry): string | null {
	const env = getEnvironmentById(entry.envName);
	if (!env) return null;
	return path.join(env.getConfigDir(), entry.relativePath);
}

/**
 * Render a small textual table of staged entries.
 */
function renderTable(entries: StagedEntry[]): string {
	const header = ["ENV", "PATH", "RESOLVER", "TIMESTAMP"];
	const rows = entries.map((e) => [e.envName, e.relativePath, e.resolver, e.timestamp]);
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
	const lines = [pad(header), pad(widths.map((w) => "-".repeat(w)))];
	for (const r of rows) lines.push(pad(r));
	return lines.join("\n");
}

/**
 * Produce a tiny unified-style diff between two strings.
 * Not a full LCS — adequate to show the contents side-by-side under common
 * "+ / -" markers so users can see what changed.
 */
function unifiedDiff(local: string, merged: string, relPath: string): string {
	const a = local.split("\n");
	const b = merged.split("\n");
	const lines: string[] = [];
	lines.push(`--- a/${relPath} (local)`);
	lines.push(`+++ b/${relPath} (merged)`);
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		const la = a[i];
		const lb = b[i];
		if (la === lb) {
			if (la !== undefined) lines.push(` ${la}`);
		} else {
			if (la !== undefined) lines.push(`-${la}`);
			if (lb !== undefined) lines.push(`+${lb}`);
		}
	}
	return lines.join("\n");
}

/** Find an entry by relativePath. */
function findEntry(entries: StagedEntry[], relPath: string): StagedEntry | undefined {
	return entries.find((e) => e.relativePath === relPath);
}

/** Print "no staged merges" message in yellow. */
function printEmpty(): void {
	console.log(pc.yellow("No staged merges."));
}

/* ---------- handlers ---------- */

export async function handleResolveList(options: ResolveOptions): Promise<void> {
	const syncRepoDir = resolveRepoPath(options);
	const entries = await listStaged(syncRepoDir);
	if (entries.length === 0) {
		printEmpty();
		return;
	}
	console.log(pc.cyan(`${entries.length} staged merge${entries.length === 1 ? "" : "s"}:`));
	console.log(renderTable(entries));
}

export async function handleResolveDiff(
	relpath: string | undefined,
	options: ResolveOptions,
): Promise<void> {
	const syncRepoDir = resolveRepoPath(options);
	const entries = await listStaged(syncRepoDir);
	if (entries.length === 0) {
		printEmpty();
		return;
	}
	let entry: StagedEntry | undefined;
	if (relpath) {
		entry = findEntry(entries, relpath);
		if (!entry) {
			console.error(pc.red(`Error: no staged merge for "${relpath}".`));
			console.error(pc.yellow("Available paths:"));
			for (const e of entries) console.error(pc.yellow(`  ${e.relativePath}`));
			process.exitCode = 1;
			return;
		}
	} else if (entries.length === 1) {
		entry = entries[0];
	} else {
		console.error(pc.red("Error: multiple staged merges. Specify a relpath."));
		for (const e of entries) console.error(pc.yellow(`  ${e.relativePath}`));
		process.exitCode = 1;
		return;
	}
	const targetPath = resolveTargetPath(entry);
	const live = targetPath ? ((await readLiveTarget(targetPath)) ?? "") : "";
	const merged = await getStagedContent(syncRepoDir, entry.envName, entry.relativePath);
	console.log(unifiedDiff(live, merged, entry.relativePath));
}

async function acceptOne(syncRepoDir: string, entry: StagedEntry): Promise<void> {
	const targetPath = resolveTargetPath(entry);
	if (!targetPath) {
		throw new Error(`unknown environment "${entry.envName}" for ${entry.relativePath}`);
	}
	await acceptStaged(syncRepoDir, entry.envName, entry.relativePath, targetPath);
	console.log(pc.green(`Accepted ${entry.envName}/${entry.relativePath} -> ${targetPath}`));
}

export async function handleResolveAccept(
	relpath: string | undefined,
	options: ResolveTargetOptions,
): Promise<void> {
	const syncRepoDir = resolveRepoPath(options);
	const entries = await listStaged(syncRepoDir);
	if (entries.length === 0) {
		printEmpty();
		return;
	}
	if (options.all) {
		for (const e of [...entries]) {
			try {
				await acceptOne(syncRepoDir, e);
			} catch (err) {
				const m = err instanceof Error ? err.message : String(err);
				console.error(pc.red(`Error accepting ${e.relativePath}: ${m}`));
				process.exitCode = 1;
			}
		}
		return;
	}
	if (!relpath) {
		console.error(pc.red("Error: relpath required (or use --all)."));
		process.exitCode = 1;
		return;
	}
	const entry = findEntry(entries, relpath);
	if (!entry) {
		console.error(pc.red(`Error: no staged merge for "${relpath}".`));
		process.exitCode = 1;
		return;
	}
	try {
		await acceptOne(syncRepoDir, entry);
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		console.error(pc.red(`Error: ${m}`));
		process.exitCode = 1;
	}
}

async function rejectOne(syncRepoDir: string, entry: StagedEntry): Promise<void> {
	await rejectStaged(syncRepoDir, entry.envName, entry.relativePath);
	console.log(pc.green(`Rejected ${entry.envName}/${entry.relativePath}`));
}

export async function handleResolveReject(
	relpath: string | undefined,
	options: ResolveTargetOptions,
): Promise<void> {
	const syncRepoDir = resolveRepoPath(options);
	const entries = await listStaged(syncRepoDir);
	if (entries.length === 0) {
		printEmpty();
		return;
	}
	if (options.all) {
		for (const e of [...entries]) {
			try {
				await rejectOne(syncRepoDir, e);
			} catch (err) {
				const m = err instanceof Error ? err.message : String(err);
				console.error(pc.red(`Error rejecting ${e.relativePath}: ${m}`));
				process.exitCode = 1;
			}
		}
		return;
	}
	if (!relpath) {
		console.error(pc.red("Error: relpath required (or use --all)."));
		process.exitCode = 1;
		return;
	}
	const entry = findEntry(entries, relpath);
	if (!entry) {
		console.error(pc.red(`Error: no staged merge for "${relpath}".`));
		process.exitCode = 1;
		return;
	}
	try {
		await rejectOne(syncRepoDir, entry);
	} catch (err) {
		const m = err instanceof Error ? err.message : String(err);
		console.error(pc.red(`Error: ${m}`));
		process.exitCode = 1;
	}
}

/**
 * Registers the "resolve" subcommand group on the CLI program.
 */
export function registerResolveCommand(program: Command): void {
	const resolve = program
		.command("resolve")
		.description("Manage staged AI merges in .ai-sync/pending/");

	const repoOpt = (cmd: Command): Command =>
		cmd.option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir());

	repoOpt(resolve.command("list").description("List pending staged merges")).action(
		async (opts: ResolveOptions) => {
			try {
				await handleResolveList(opts);
			} catch (err) {
				const m = err instanceof Error ? err.message : String(err);
				console.error(pc.red(`Error: ${m}`));
				process.exitCode = 1;
			}
		},
	);

	repoOpt(
		resolve
			.command("diff [relpath]")
			.description("Show unified diff between local and staged merged file"),
	).action(async (relpath: string | undefined, opts: ResolveOptions) => {
		try {
			await handleResolveDiff(relpath, opts);
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			console.error(pc.red(`Error: ${m}`));
			process.exitCode = 1;
		}
	});

	repoOpt(
		resolve
			.command("accept [relpath]")
			.description("Apply a staged merge to the live target")
			.option("--all", "Accept every staged entry", false),
	).action(async (relpath: string | undefined, opts: ResolveTargetOptions) => {
		try {
			await handleResolveAccept(relpath, opts);
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			console.error(pc.red(`Error: ${m}`));
			process.exitCode = 1;
		}
	});

	repoOpt(
		resolve
			.command("reject [relpath]")
			.description("Discard a staged merge")
			.option("--all", "Reject every staged entry", false),
	).action(async (relpath: string | undefined, opts: ResolveTargetOptions) => {
		try {
			await handleResolveReject(relpath, opts);
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			console.error(pc.red(`Error: ${m}`));
			process.exitCode = 1;
		}
	});
}
