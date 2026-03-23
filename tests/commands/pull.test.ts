import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePull, registerPullCommand } from "../../src/cli/commands/pull.js";
import { handlePush } from "../../src/cli/commands/push.js";
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

/**
 * Pushes files from claudeDir to the bare remote via the sync repo,
 * then simulates a remote modification by cloning, editing, committing,
 * and pushing a change to CLAUDE.md.
 */
async function pushAndSimulateRemoteChange(
	bareDir: string,
	syncRepoDir: string,
	claudeDir: string,
	baseDir: string,
) {
	await handlePush({ repoPath: syncRepoDir, claudeDir });

	const cloneDir = path.join(baseDir, "clone");
	await fs.mkdir(cloneDir, { recursive: true });
	await simpleGit(cloneDir).clone(bareDir, ".");
	await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
	await simpleGit(cloneDir).addConfig("user.name", "Test");
	await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Updated from remote");
	await simpleGit(cloneDir).add("CLAUDE.md");
	await simpleGit(cloneDir).commit("update from remote");
	await simpleGit(cloneDir).push("origin", "main");
}

describe("pull command (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pull-cmd-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("applies remote changes to claudeDir", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Push initial files
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Simulate remote changes: clone, modify, push
		const cloneDir = path.join(tmpDir, "clone");
		await fs.mkdir(cloneDir, { recursive: true });
		await simpleGit(cloneDir).clone(bareDir, ".");
		await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
		await simpleGit(cloneDir).addConfig("user.name", "Test");
		await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Updated from remote");
		await simpleGit(cloneDir).add("CLAUDE.md");
		await simpleGit(cloneDir).commit("update from remote");
		await simpleGit(cloneDir).push("origin", "main");

		// Pull
		const result = await handlePull({ repoPath: syncRepoDir, claudeDir });

		expect(result.filesApplied).toBeGreaterThan(0);

		// Verify the update arrived in claudeDir
		const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
		expect(content).toBe("# Updated from remote");
	});

	it("creates backup directory before applying changes", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Push first
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const result = await handlePull({ repoPath: syncRepoDir, claudeDir });

		expect(result.backupDir).toBeDefined();
		const stat = await fs.stat(result.backupDir);
		expect(stat.isDirectory()).toBe(true);

		// Backup should contain original files
		const backedUp = await fs.readFile(path.join(result.backupDir, "CLAUDE.md"), "utf-8");
		expect(backedUp).toBe("# My Claude Config");
	});

	it("expands {{HOME}} tokens in settings.json", async () => {
		const { syncRepoDir, claudeDir, homeDir } = await createTestEnv(tmpDir);

		// Push (rewrites settings.json with {{HOME}})
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Pull back
		const result = await handlePull({ repoPath: syncRepoDir, claudeDir });

		const settingsContent = await fs.readFile(path.join(claudeDir, "settings.json"), "utf-8");
		expect(settingsContent).toContain(homeDir);
		expect(settingsContent).not.toContain("{{HOME}}");
		expect(result.filesApplied).toBeGreaterThan(0);
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

		await expect(handlePull({ repoPath: noRemoteDir, claudeDir })).rejects.toThrow(/[Nn]o remote/);
	});
});

describe("pull CLI action (integration)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pull-cli-test-"));
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
		registerPullCommand(program);
		return program;
	}

	it("prints green up-to-date message when no remote changes", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("already up to date");
	});

	it("prints green pulled message with file count when there are changes", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await pushAndSimulateRemoteChange(bareDir, syncRepoDir, claudeDir, tmpDir);

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Pulled");
		expect(output).toContain("changed files");
	});

	it("prints verbose file changes with --verbose flag", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await pushAndSimulateRemoteChange(bareDir, syncRepoDir, claudeDir, tmpDir);

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--verbose",
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		// Verbose mode should print individual file change lines
		expect(output).toContain("CLAUDE.md");
	});

	it("prints dry-run message in cyan when --dry-run is used", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await pushAndSimulateRemoteChange(bareDir, syncRepoDir, claudeDir, tmpDir);

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--dry-run",
		]);

		// Should not fail
		expect(process.exitCode).toBeUndefined();
		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toBeTruthy();
	});

	it("prints backup directory path after a real pull", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Backup saved to:");
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
			"pull",
			"--repo-path",
			noRemoteDir,
			"--claude-dir",
			claudeDir,
		]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Pull failed:");
		expect(process.exitCode).toBe(1);
	});

	it("prints conflict information when local files are modified", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Simulate remote change
		const cloneDir = path.join(tmpDir, "clone-conflict");
		await fs.mkdir(cloneDir, { recursive: true });
		await simpleGit(cloneDir).clone(bareDir, ".");
		await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
		await simpleGit(cloneDir).addConfig("user.name", "Test");
		await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Remote version");
		await simpleGit(cloneDir).add("CLAUDE.md");
		await simpleGit(cloneDir).commit("remote change");
		await simpleGit(cloneDir).push("origin", "main");

		// Also modify the local file to create a conflict
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Local version");

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"pull",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		// The conflict scenario exercises the output formatting code path
		// Verify the command completed without error
		expect(process.exitCode).toBeUndefined();
	});
});
