import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { createBackup } from "../../core/backup.js";
import {
	generateIndex,
	hasConflictMarkers,
	parseIndex,
	splitMarkdownIntoFragments,
} from "../../core/fragmenter.js";
import { detectRepoVersion, migrateToV3 } from "../../core/migration.js";
import { getClaudeDir, getSyncRepoDir } from "../../platform/paths.js";

export interface FragmentSplitOptions {
	repoPath?: string;
	claudeDir?: string;
}

export interface FragmentStatusOptions {
	repoPath?: string;
}

export interface FragmentAddRemoveOptions {
	repoPath?: string;
}

/**
 * Slugifies a heading for use as a filename.
 * e.g. "## My Section" → "my-section"
 */
function slugify(heading: string): string {
	return heading
		.replace(/^#+\s*/, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * The known section → fragment-path mapping used for splitting CLAUDE.md.
 */
const KNOWN_SECTION_MAP = new Map<string, string>([
	["## TDD & Testing", "shared/standards/tdd.md"],
	["## Stack", "shared/standards/stack.md"],
	["## Architecture", "shared/standards/architecture.md"],
	["## Code Quality", "shared/standards/code-quality.md"],
	["## Database Safety", "shared/standards/database-safety.md"],
	["## AWS", "shared/standards/aws.md"],
	["## Dev Server", "shared/standards/dev-server.md"],
	["## Workflow", "shared/standards/workflow.md"],
	["## Worktrees", "shared/standards/worktrees.md"],
	["## Context", "shared/context/context.md"],
	["## Planning", "shared/context/planning.md"],
]);

/**
 * Registers the "fragment" subcommand group on the CLI program.
 */
export function registerFragmentCommand(program: Command): void {
	const fragment = program
		.command("fragment")
		.description("Manage fragment-based configuration files");

	fragment
		.command("split")
		.description("Split CLAUDE.md into modular fragments")
		.option("--repo-path <path>", "Custom sync repo path")
		.option("--claude-dir <path>", "Custom Claude config directory")
		.action(async (options: FragmentSplitOptions) => {
			await handleFragmentSplit(options);
		});

	fragment
		.command("status")
		.description("Show fragment index and reference status")
		.option("--repo-path <path>", "Custom sync repo path")
		.action(async (options: FragmentStatusOptions) => {
			await handleFragmentStatus(options);
		});

	fragment
		.command("add <path>")
		.description("Add an @-reference to the index")
		.option("--repo-path <path>", "Custom sync repo path")
		.action(async (refPath: string, options: FragmentAddRemoveOptions) => {
			await handleFragmentAdd(refPath, options);
		});

	fragment
		.command("remove <path>")
		.description("Remove an @-reference from the index")
		.option("--repo-path <path>", "Custom sync repo path")
		.action(async (refPath: string, options: FragmentAddRemoveOptions) => {
			await handleFragmentRemove(refPath, options);
		});
}

/**
 * Splits a monolithic CLAUDE.md into fragment files in the sync repo.
 *
 * 1. Reads claudeDir/CLAUDE.md
 * 2. Skips if already a symlink (already migrated)
 * 3. Splits using splitMarkdownIntoFragments with the known section map,
 *    routing unrecognised ## sections to claude/orchestration/<slug>.md
 * 4. Writes fragment files into syncRepoDir
 * 5. Writes the index to syncRepoDir/claude/CLAUDE.md
 * 6. Backs up the original CLAUDE.md
 * 7. Creates a symlink: claudeDir/CLAUDE.md → syncRepoDir/claude/CLAUDE.md
 * 8. Upgrades the repo to v3 if needed
 */
export async function handleFragmentSplit(options: FragmentSplitOptions): Promise<void> {
	try {
		const claudeDir = options.claudeDir ?? getClaudeDir();
		const syncRepoDir = getSyncRepoDir(options.repoPath);
		const claudeMdPath = path.join(claudeDir, "CLAUDE.md");

		// Read source file
		let content: string;
		try {
			content = await fs.readFile(claudeMdPath, "utf-8");
		} catch {
			console.error(pc.red(`Could not read ${claudeMdPath}`));
			process.exitCode = 1;
			return;
		}

		// Check whether it is already a symlink
		try {
			const stat = await fs.lstat(claudeMdPath);
			if (stat.isSymbolicLink()) {
				console.log(pc.yellow(`${claudeMdPath} is already a symlink — already migrated, skipping`));
				return;
			}
		} catch {
			// lstat failed — file doesn't exist
			console.error(pc.red(`Could not stat ${claudeMdPath}`));
			process.exitCode = 1;
			return;
		}

		// Build the full section map, routing unknown ## sections to orchestration
		const lines = content.split("\n");
		const sectionMap = new Map<string, string>(KNOWN_SECTION_MAP);
		for (const line of lines) {
			if (line.startsWith("## ") && !sectionMap.has(line)) {
				const slug = slugify(line);
				sectionMap.set(line, `claude/orchestration/${slug}.md`);
			}
		}

		// Split content into fragments
		const result = splitMarkdownIntoFragments(content, sectionMap);

		// Create required directories in sync repo
		const dirs = [
			path.join(syncRepoDir, "shared/standards"),
			path.join(syncRepoDir, "shared/context"),
			path.join(syncRepoDir, "claude/orchestration"),
		];
		for (const dir of dirs) {
			await fs.mkdir(dir, { recursive: true });
		}

		// Write fragment files
		for (const fragment of result.fragments) {
			const fragmentAbsPath = path.join(syncRepoDir, fragment.path);
			await fs.mkdir(path.dirname(fragmentAbsPath), { recursive: true });
			await fs.writeFile(fragmentAbsPath, `${fragment.content}\n`);
			console.log(pc.dim(`  wrote ${fragment.path}`));
		}

		// Write index file
		const indexPath = path.join(syncRepoDir, "claude", "CLAUDE.md");
		await fs.mkdir(path.dirname(indexPath), { recursive: true });
		await fs.writeFile(indexPath, `${result.indexContent}\n`);
		console.log(pc.dim(`  wrote claude/CLAUDE.md (index)`));

		// Back up original
		const backupBaseDir = path.join(path.dirname(syncRepoDir), ".ai-sync-backups");
		await createBackup(claudeDir, backupBaseDir, (rel) => rel === "CLAUDE.md");
		console.log(pc.dim(`  backed up original CLAUDE.md`));

		// Replace original with symlink
		await fs.rm(claudeMdPath);
		await fs.symlink(indexPath, claudeMdPath);

		// Upgrade to v3 if needed
		const version = await detectRepoVersion(syncRepoDir);
		if (version < 3) {
			if (version === 1) {
				console.log(
					pc.yellow("Repo is at v1. Please run 'ai-sync migrate' to upgrade to v2 first."),
				);
			} else {
				await migrateToV3(syncRepoDir);
				console.log(pc.dim("  auto-upgraded sync repo to v3"));
			}
		}

		console.log(pc.green(`\nSplit complete: ${result.fragments.length} fragments created`));
		console.log(pc.dim(`  index: ${indexPath}`));
		console.log(pc.dim(`  symlink: ${claudeMdPath} → ${indexPath}`));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(pc.red(`Fragment split failed: ${message}`));
		process.exitCode = 1;
	}
}

/**
 * Reads the fragment index from the sync repo and reports the status of each @-reference.
 */
export async function handleFragmentStatus(options: FragmentStatusOptions): Promise<void> {
	try {
		const syncRepoDir = getSyncRepoDir(options.repoPath);
		const indexPath = path.join(syncRepoDir, "claude", "CLAUDE.md");

		let indexContent: string;
		try {
			indexContent = await fs.readFile(indexPath, "utf-8");
		} catch {
			console.error(pc.red(`Could not read index at ${indexPath}`));
			process.exitCode = 1;
			return;
		}

		const index = parseIndex(indexContent);

		if (index.references.length === 0) {
			console.log(pc.yellow("No @-references found in the index"));
			return;
		}

		console.log(pc.cyan(`Fragment index: ${indexPath}`));
		console.log(pc.cyan(`References (${index.references.length}):`));

		for (const ref of index.references) {
			const absPath = path.join(syncRepoDir, ref);
			let status: string;
			let hasConflicts = false;

			try {
				const fileContent = await fs.readFile(absPath, "utf-8");
				hasConflicts = hasConflictMarkers(fileContent);
				status = hasConflicts ? pc.red("conflict") : pc.green("ok");
			} catch {
				status = pc.red("missing");
			}

			const conflictSuffix = hasConflicts ? pc.red(" [has conflict markers]") : "";
			console.log(`  ${status}  @${ref}${conflictSuffix}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(pc.red(`Fragment status failed: ${message}`));
		process.exitCode = 1;
	}
}

/**
 * Adds an @-reference to the fragment index.
 */
export async function handleFragmentAdd(
	refPath: string,
	options: FragmentAddRemoveOptions,
): Promise<void> {
	try {
		const syncRepoDir = getSyncRepoDir(options.repoPath);
		const indexPath = path.join(syncRepoDir, "claude", "CLAUDE.md");

		let indexContent: string;
		try {
			indexContent = await fs.readFile(indexPath, "utf-8");
		} catch {
			console.error(pc.red(`Could not read index at ${indexPath}`));
			process.exitCode = 1;
			return;
		}

		const index = parseIndex(indexContent);

		// Normalise the ref (strip leading @)
		const normalised = refPath.startsWith("@") ? refPath.slice(1) : refPath;

		if (index.references.includes(normalised)) {
			console.log(pc.yellow(`@${normalised} is already in the index`));
			return;
		}

		index.references.push(normalised);
		const newContent = generateIndex(index.preamble, index.references);
		await fs.writeFile(indexPath, `${newContent}\n`);

		console.log(pc.green(`Added @${normalised} to the index`));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(pc.red(`Fragment add failed: ${message}`));
		process.exitCode = 1;
	}
}

/**
 * Removes an @-reference from the fragment index.
 */
export async function handleFragmentRemove(
	refPath: string,
	options: FragmentAddRemoveOptions,
): Promise<void> {
	try {
		const syncRepoDir = getSyncRepoDir(options.repoPath);
		const indexPath = path.join(syncRepoDir, "claude", "CLAUDE.md");

		let indexContent: string;
		try {
			indexContent = await fs.readFile(indexPath, "utf-8");
		} catch {
			console.error(pc.red(`Could not read index at ${indexPath}`));
			process.exitCode = 1;
			return;
		}

		const index = parseIndex(indexContent);

		const normalised = refPath.startsWith("@") ? refPath.slice(1) : refPath;
		const before = index.references.length;
		index.references = index.references.filter((r) => r !== normalised);

		if (index.references.length === before) {
			console.log(pc.yellow(`@${normalised} was not found in the index`));
			return;
		}

		const newContent = generateIndex(index.preamble, index.references);
		await fs.writeFile(indexPath, `${newContent}\n`);

		console.log(pc.green(`Removed @${normalised} from the index`));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(pc.red(`Fragment remove failed: ${message}`));
		process.exitCode = 1;
	}
}
