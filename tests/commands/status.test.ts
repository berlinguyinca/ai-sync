import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePush } from "../../src/cli/commands/push.js";
import { handleStatus, registerStatusCommand } from "../../src/cli/commands/status.js";
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

describe("status command (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-cmd-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("returns isClean: true when everything matches", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Push to establish baseline
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const result = await handleStatus({ repoPath: syncRepoDir, claudeDir });

		expect(result.isClean).toBe(true);
		expect(result.localModifications).toHaveLength(0);
	});

	it("detects modified files", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Push to establish baseline
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Modify a file locally
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Modified content");

		const result = await handleStatus({ repoPath: syncRepoDir, claudeDir });

		expect(result.isClean).toBe(false);
		const modifiedPaths = result.localModifications.map((c) => c.path);
		expect(modifiedPaths).toContain("CLAUDE.md");
		const change = result.localModifications.find((c) => c.path === "CLAUDE.md");
		expect(change?.type).toBe("modified");
	});

	it("detects added files", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Push to establish baseline
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Add a new allowlisted file
		await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });
		await fs.writeFile(path.join(claudeDir, "commands", "custom.md"), "custom");

		const result = await handleStatus({ repoPath: syncRepoDir, claudeDir });

		const addedPaths = result.localModifications.map((c) => c.path);
		expect(addedPaths).toContain("commands/custom.md");
		const change = result.localModifications.find((c) => c.path === "commands/custom.md");
		expect(change?.type).toBe("added");
	});

	it("reports excluded file count", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);

		// Add non-allowlisted files
		await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });
		await fs.writeFile(path.join(claudeDir, "projects", "data.json"), "{}");

		// Push to establish baseline
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const result = await handleStatus({ repoPath: syncRepoDir, claudeDir });

		expect(result.excludedCount).toBeGreaterThan(0);
	});

	it("returns hasRemote: false when no remote configured", async () => {
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

		const result = await handleStatus({ repoPath: noRemoteDir, claudeDir });

		expect(result.hasRemote).toBe(false);
		expect(result.remoteDrift.ahead).toBe(0);
		expect(result.remoteDrift.behind).toBe(0);
	});
});

describe("status CLI action (integration)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-cli-test-"));
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
		registerStatusCommand(program);
		return program;
	}

	it("prints green 'Everything is in sync' when clean", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Everything is in sync");
	});

	it("prints local changes listing when files are modified", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Modify a local file
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Modified content");

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Local changes:");
		expect(output).toContain("CLAUDE.md");
	});

	it("prints excluded file count", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Excluded:");
		expect(output).toContain("files (not in sync manifest)");
	});

	it("prints yellow 'No remote configured' when no remote", async () => {
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
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			noRemoteDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("No remote configured");
	});

	it("prints verbose branch and tracking info with --verbose", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
			"--verbose",
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Branch:");
		expect(output).toContain("main");
		expect(output).toContain("Tracking:");
		expect(output).toContain("Synced:");
		expect(output).toContain("files");
	});

	it("prints remote drift behind message when remote is ahead", async () => {
		const { bareDir, syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Simulate a remote change by cloning, committing, and pushing
		const cloneDir = path.join(tmpDir, "clone-drift");
		await fs.mkdir(cloneDir, { recursive: true });
		await simpleGit(cloneDir).clone(bareDir, ".");
		await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
		await simpleGit(cloneDir).addConfig("user.name", "Test");
		await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Remote change");
		await simpleGit(cloneDir).add("CLAUDE.md");
		await simpleGit(cloneDir).commit("remote drift");
		await simpleGit(cloneDir).push("origin", "main");

		// Fetch so the sync repo knows about the remote change
		await simpleGit(syncRepoDir).fetch();

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Remote is");
		expect(output).toContain("commit(s) ahead");
		expect(output).toContain("ai-sync pull");
	});

	it("prints local-ahead message when local has unpushed commits", async () => {
		const { syncRepoDir, claudeDir } = await createTestEnv(tmpDir);
		await handlePush({ repoPath: syncRepoDir, claudeDir });

		// Create a local commit that is not pushed to remote
		await fs.writeFile(path.join(syncRepoDir, "extra-file.txt"), "local only");
		await addFiles(syncRepoDir, ["extra-file.txt"]);
		await commitFiles(syncRepoDir, "local-only commit");

		const program = createProgram();
		logSpy.mockClear();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Local is");
		expect(output).toContain("commit(s) ahead");
		expect(output).toContain("ai-sync push");
	});

	it("prints error and sets exitCode on failure", async () => {
		// Use a non-existent repo path to trigger an error
		const bogusRepoDir = path.join(tmpDir, "does-not-exist");

		const program = createProgram();

		await program.parseAsync([
			"node",
			"test",
			"status",
			"--repo-path",
			bogusRepoDir,
			"--claude-dir",
			path.join(tmpDir, "also-missing"),
		]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Status failed:");
		expect(process.exitCode).toBe(1);
	});
});
