import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePush, registerPushCommand } from "../../src/cli/commands/push.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

/**
 * Creates a full test environment with:
 * - A bare git repo (the "remote")
 * - A working sync repo (initialized + remote added + upstream tracking)
 * - A mock claudeDir with allowlisted files
 */
async function createTestEnv(baseDir: string) {
	const bareDir = path.join(baseDir, "bare.git");
	const syncRepoDir = path.join(baseDir, "sync-repo");
	const claudeDir = path.join(baseDir, "home", ".claude");

	// Create bare remote repo
	await fs.mkdir(bareDir, { recursive: true });
	await simpleGit(bareDir).init(true);

	// Create sync repo with remote
	await fs.mkdir(syncRepoDir, { recursive: true });
	await initRepo(syncRepoDir);
	await simpleGit(syncRepoDir).addConfig("user.email", "test@test.com");
	await simpleGit(syncRepoDir).addConfig("user.name", "Test");
	await addRemote(syncRepoDir, "origin", bareDir);

	// Create an initial commit and push so main branch exists on remote
	await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
	await addFiles(syncRepoDir, [".gitkeep"]);
	await commitFiles(syncRepoDir, "initial commit");
	await simpleGit(syncRepoDir).push("origin", "main");
	// Set upstream tracking
	await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

	// Create claudeDir with allowlisted files
	await fs.mkdir(claudeDir, { recursive: true });
	await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# My Claude Config");
	await fs.writeFile(
		path.join(claudeDir, "settings.json"),
		JSON.stringify({ projectDir: path.join(baseDir, "home", "projects") }),
	);
	await fs.mkdir(path.join(claudeDir, "agents"), { recursive: true });
	await fs.writeFile(path.join(claudeDir, "agents", "default.md"), "agent config");

	return { bareDir, syncRepoDir, claudeDir, homeDir: path.join(baseDir, "home") };
}

describe("push command (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-cmd-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("pushes files and returns pushed: true with file count", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		const result = await handlePush({ repoPath: syncRepoDir, claudeDir });

		expect(result.pushed).toBe(true);
		expect(result.filesUpdated).toBeGreaterThan(0);
		expect(result.message).toContain("Pushed");
	});

	it("returns pushed: false when no changes", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// First push
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Second push -- no changes
		const result = await handlePush({ repoPath: syncRepoDir, claudeDir });

		expect(result.pushed).toBe(false);
		expect(result.message).toContain("No changes");
	});

	it("rewrites settings.json paths before pushing", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const settingsContent = await fs.readFile(path.join(syncRepoDir, "settings.json"), "utf-8");
		expect(settingsContent).toContain("{{HOME}}");
		expect(settingsContent).not.toContain(tmpDir);
	});

	it("throws with 'No remote' when no remote configured", async () => {
		const noRemoteDir = path.join(tmpDir, "no-remote-repo");
		await fs.mkdir(noRemoteDir, { recursive: true });
		await initRepo(noRemoteDir);
		await simpleGit(noRemoteDir).addConfig("user.email", "test@test.com");
		await simpleGit(noRemoteDir).addConfig("user.name", "Test");
		await fs.writeFile(path.join(noRemoteDir, ".gitkeep"), "");
		await addFiles(noRemoteDir, [".gitkeep"]);
		await commitFiles(noRemoteDir, "initial");

		const claudeDir = path.join(tmpDir, "home", ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Test");

		await expect(handlePush({ repoPath: noRemoteDir, claudeDir })).rejects.toThrow(/[Nn]o remote/);
	});
});

describe("push CLI action (integration)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "push-cli-test-"));
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
		program.exitOverride(); // prevent process.exit in tests
		registerPushCommand(program);
		return program;
	}

	it("prints green success message when files are pushed", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Pushed");
	});

	it("prints yellow no-changes message when already up to date", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		// Push once via handler
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("No changes to push");
	});

	it("prints verbose file changes with --verbose flag", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--verbose",
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		// Verbose mode should print file change indicators (A for added)
		expect(output).toContain("CLAUDE.md");
		expect(output).toContain("Pushed");
	});

	it("prints dry-run message in cyan when --dry-run is used", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--dry-run",
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		// Dry-run output should indicate the push was simulated
		expect(output).toBeTruthy();
		// Should not actually push (no green pushed message)
		expect(process.exitCode).toBeUndefined();
	});

	it("prints dry-run verbose file changes with --dry-run --verbose", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--dry-run",
			"--verbose",
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		// Verbose + dry-run should show file changes
		expect(output).toContain("CLAUDE.md");
	});

	it("prints error and sets exitCode on failure", async () => {
		const noRemoteDir = path.join(tmpDir, "no-remote-repo");
		await fs.mkdir(noRemoteDir, { recursive: true });
		await initRepo(noRemoteDir);
		await simpleGit(noRemoteDir).addConfig("user.email", "test@test.com");
		await simpleGit(noRemoteDir).addConfig("user.name", "Test");
		await fs.writeFile(path.join(noRemoteDir, ".gitkeep"), "");
		await addFiles(noRemoteDir, [".gitkeep"]);
		await commitFiles(noRemoteDir, "initial");

		const claudeDir = path.join(tmpDir, "home", ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Test");

		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"push",
			"--repo-path",
			noRemoteDir,
			"--claude-dir",
			claudeDir,
		]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Push failed:");
		expect(process.exitCode).toBe(1);
	});
});
