import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInit, registerInitCommand } from "../../src/cli/commands/init.js";
import { isGitRepo } from "../../src/git/repo.js";

/**
 * Creates a mock ~/.claude directory structure in a temp location.
 * Includes both allowlisted and non-allowlisted files.
 */
async function createMockClaudeDir(baseDir: string): Promise<string> {
	const claudeDir = path.join(baseDir, ".claude");
	await fs.mkdir(claudeDir, { recursive: true });

	// Allowlisted files
	await fs.writeFile(
		path.join(claudeDir, "settings.json"),
		JSON.stringify({
			theme: "dark",
			hookPath: `${baseDir}/.claude/hooks/test.js`,
			configDir: `${baseDir}/.claude/agents`,
		}),
	);

	await fs.writeFile(
		path.join(claudeDir, "CLAUDE.md"),
		"# My Claude Config\nSome instructions here.\n",
	);

	// agents/ directory
	await fs.mkdir(path.join(claudeDir, "agents"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "agents", "default.md"), "Default agent config");

	// commands/ directory
	await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "commands", "review.md"), "Review command template");

	// hooks/ directory
	await fs.mkdir(path.join(claudeDir, "hooks"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "hooks", "pre-commit.js"), 'console.log("hook");');

	// Non-allowlisted directories (ephemeral data -- should NOT be synced)
	await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "projects", "project1.json"), '{"id": "p1"}');

	await fs.mkdir(path.join(claudeDir, "debug"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "debug", "session.log"), "debug log data");

	await fs.mkdir(path.join(claudeDir, "telemetry"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "telemetry", "events.json"), '{"events": []}');

	return claudeDir;
}

describe("init command (integration)", () => {
	let tmpDir: string;
	let claudeDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-test-"));
		claudeDir = await createMockClaudeDir(tmpDir);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("creates a valid git repo at sync repo path", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		const result = await isGitRepo(syncRepoDir);
		expect(result).toBe(true);
	});

	it("first commit is .gitattributes with LF config", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		const git = simpleGit(syncRepoDir);
		const log = await git.log();

		// The log lists commits newest-first; the first commit is the last in the array
		const commits = log.all;
		expect(commits.length).toBeGreaterThanOrEqual(2);

		const firstCommit = commits[commits.length - 1];
		expect(firstCommit.message).toBe("chore: initialize sync repo with line ending config");

		// Verify .gitattributes content
		const gitattributes = await fs.readFile(path.join(syncRepoDir, ".gitattributes"), "utf-8");
		expect(gitattributes).toContain("* text=auto eol=lf");
	});

	it("syncs only allowlisted files", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		// Should be present
		await expect(fs.access(path.join(syncRepoDir, "settings.json"))).resolves.toBeUndefined();
		await expect(fs.access(path.join(syncRepoDir, "CLAUDE.md"))).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(syncRepoDir, "agents", "default.md")),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(syncRepoDir, "commands", "review.md")),
		).resolves.toBeUndefined();
		await expect(
			fs.access(path.join(syncRepoDir, "hooks", "pre-commit.js")),
		).resolves.toBeUndefined();

		// Should NOT be present
		await expect(fs.access(path.join(syncRepoDir, "projects"))).rejects.toThrow();
		await expect(fs.access(path.join(syncRepoDir, "debug"))).rejects.toThrow();
		await expect(fs.access(path.join(syncRepoDir, "telemetry"))).rejects.toThrow();
	});

	it("rewrites absolute paths in settings.json", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		const content = await fs.readFile(path.join(syncRepoDir, "settings.json"), "utf-8");

		// Should contain {{HOME}} tokens
		expect(content).toContain("{{HOME}}");

		// Should NOT contain the actual test temp directory path
		expect(content).not.toContain(tmpDir);
	});

	it("errors on duplicate init without --force", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");

		// First init succeeds
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		// Second init without --force should throw
		await expect(handleInit({ repoPath: syncRepoDir, claudeDir })).rejects.toThrow(
			"Sync repo already exists",
		);
	});

	it("re-initializes with --force", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");

		// First init
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		// Second init with --force should succeed
		const result = await handleInit({
			repoPath: syncRepoDir,
			claudeDir,
			force: true,
		});

		expect(result.syncRepoDir).toBe(syncRepoDir);
		expect(result.filesSynced).toBeGreaterThan(0);

		// Should still be a valid repo
		const isRepo = await isGitRepo(syncRepoDir);
		expect(isRepo).toBe(true);
	});

	it("errors when source directory missing", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		const fakeClaude = path.join(tmpDir, "nonexistent-claude");

		await expect(handleInit({ repoPath: syncRepoDir, claudeDir: fakeClaude })).rejects.toThrow(
			"No ~/.claude directory found",
		);
	});

	it("second commit contains allowlisted files from source", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		const git = simpleGit(syncRepoDir);
		const log = await git.log();
		const commits = log.all;

		// Second commit (newest = index 0 since we have 2 commits)
		const secondCommit = commits[0];
		expect(secondCommit.message).toBe("feat: initial sync of claude config");
	});

	it("reports summary of synced files count", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		const result = await handleInit({ repoPath: syncRepoDir, claudeDir });

		// We created 5 allowlisted files: settings.json, CLAUDE.md, agents/default.md, commands/review.md, hooks/pre-commit.js
		expect(result.filesSynced).toBe(5);
		expect(result.filesExcluded).toBeGreaterThan(0);
	});
});

describe("init CLI action (integration)", () => {
	let tmpDir: string;
	let claudeDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-cli-test-"));
		claudeDir = await createMockClaudeDir(tmpDir);
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = savedExitCode;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function createProgram(): Command {
		const program = new Command();
		program.exitOverride();
		registerInitCommand(program);
		return program;
	}

	it("prints success message with file counts", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		const program = createProgram();

		await program.parseAsync(["node", "test", "init", "--repo-path", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Sync repo initialized");
		expect(output).toContain("Files synced:");
		expect(output).toContain("Files excluded:");
	});

	it("prints error and sets exitCode on duplicate init", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		// Init first via handler
		await handleInit({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync(["node", "test", "init", "--repo-path", syncRepoDir]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("already exists");
		expect(process.exitCode).toBe(1);
	});
});
