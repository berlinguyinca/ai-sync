import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../src/core/environment.js";
import type { SyncOptions } from "../../src/core/sync-engine.js";
import { syncPull, syncPush, syncStatus } from "../../src/core/sync-engine.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

/**
 * Creates a full test environment with:
 * - A bare git repo (the "remote")
 * - A working sync repo (initialized + remote added)
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

	const homeDir = path.join(baseDir, "home");

	const options: SyncOptions = {
		claudeDir,
		syncRepoDir,
		homeDir,
	};

	return { bareDir, syncRepoDir, claudeDir, homeDir, options };
}

/**
 * Creates a mock Environment object for v2 multi-environment tests.
 */
function createMockEnvironment(
	id: string,
	displayName: string,
	configDir: string,
): Environment {
	return {
		id,
		displayName,
		getConfigDir: () => configDir,
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
 * Creates a v2 test environment with:
 * - A bare git repo (the "remote")
 * - A working sync repo with .sync-version=2
 * - Two mock environment config directories (claude and opencode)
 */
async function createV2TestEnv(baseDir: string) {
	const bareDir = path.join(baseDir, "bare.git");
	const syncRepoDir = path.join(baseDir, "sync-repo");
	const homeDir = path.join(baseDir, "home");
	const claudeConfigDir = path.join(homeDir, ".claude");
	const opencodeConfigDir = path.join(homeDir, ".config", "opencode");

	// Create bare remote repo
	await fs.mkdir(bareDir, { recursive: true });
	await simpleGit(bareDir).init(true);

	// Create sync repo with remote
	await fs.mkdir(syncRepoDir, { recursive: true });
	await initRepo(syncRepoDir);
	await simpleGit(syncRepoDir).addConfig("user.email", "test@test.com");
	await simpleGit(syncRepoDir).addConfig("user.name", "Test");
	await addRemote(syncRepoDir, "origin", bareDir);

	// Write .sync-version = 2
	await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2");

	// Initial commit and push
	await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
	await addFiles(syncRepoDir, [".gitkeep", ".sync-version"]);
	await commitFiles(syncRepoDir, "initial commit");
	await simpleGit(syncRepoDir).push("origin", "main");
	await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

	// Create claude config dir with files
	await fs.mkdir(claudeConfigDir, { recursive: true });
	await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Claude Config");
	await fs.writeFile(
		path.join(claudeConfigDir, "settings.json"),
		JSON.stringify({ projectDir: path.join(homeDir, "projects") }),
	);
	await fs.mkdir(path.join(claudeConfigDir, "commands"), { recursive: true });
	await fs.writeFile(path.join(claudeConfigDir, "commands", "test.md"), "test command");

	// Create opencode config dir with files
	await fs.mkdir(opencodeConfigDir, { recursive: true });
	await fs.writeFile(
		path.join(opencodeConfigDir, "settings.json"),
		JSON.stringify({ theme: "dark" }),
	);
	await fs.mkdir(path.join(opencodeConfigDir, "agents"), { recursive: true });
	await fs.writeFile(path.join(opencodeConfigDir, "agents", "default.md"), "opencode agent");

	const claudeEnv = createMockEnvironment("claude", "Claude Code", claudeConfigDir);
	const opencodeEnv = createMockEnvironment("opencode", "OpenCode", opencodeConfigDir);

	const options: SyncOptions = {
		syncRepoDir,
		homeDir,
		environments: [claudeEnv, opencodeEnv],
	};

	return {
		bareDir,
		syncRepoDir,
		homeDir,
		claudeConfigDir,
		opencodeConfigDir,
		claudeEnv,
		opencodeEnv,
		options,
	};
}

describe("core/sync-engine", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-engine-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("syncPush", () => {
		it("copies allowlisted files from claudeDir to syncRepoDir and pushes", async () => {
			const { syncRepoDir, options } = await createTestEnv(tmpDir);

			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			expect(result.filesUpdated).toBeGreaterThan(0);
			expect(result.message).toContain("Pushed");

			// Verify files exist in sync repo
			const claudeMd = await fs.readFile(path.join(syncRepoDir, "CLAUDE.md"), "utf-8");
			expect(claudeMd).toBe("# My Claude Config");

			const agentFile = await fs.readFile(path.join(syncRepoDir, "agents", "default.md"), "utf-8");
			expect(agentFile).toBe("agent config");
		});

		it("rewrites settings.json paths with {{HOME}} tokens", async () => {
			const { syncRepoDir, homeDir, options } = await createTestEnv(tmpDir);

			await syncPush(options);

			const settingsContent = await fs.readFile(path.join(syncRepoDir, "settings.json"), "utf-8");
			expect(settingsContent).toContain("{{HOME}}");
			expect(settingsContent).not.toContain(homeDir);
		});

		it("detects and removes deleted files from repo", async () => {
			const { syncRepoDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Delete a file from claudeDir
			await fs.rm(path.join(claudeDir, "agents", "default.md"));

			// Push again
			const result = await syncPush(options);

			// File should be removed from repo
			await expect(fs.access(path.join(syncRepoDir, "agents", "default.md"))).rejects.toThrow();
			expect(result.pushed).toBe(true);
		});

		it("returns pushed: false when no changes", async () => {
			const { options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Push again with no changes
			const result = await syncPush(options);

			expect(result.pushed).toBe(false);
			expect(result.message).toContain("No changes");
			expect(result.fileChanges).toHaveLength(0);
			expect(result.filesUpdated).toBe(0);
		});

		it("returns fileChanges with correct types on first push", async () => {
			const { options } = await createTestEnv(tmpDir);

			const result = await syncPush(options);

			expect(result.fileChanges.length).toBeGreaterThan(0);
			// All files are new on first push
			for (const change of result.fileChanges) {
				expect(change.type).toBe("added");
				expect(change.path).toBeTruthy();
			}
			expect(result.filesUpdated).toBe(result.fileChanges.length);
		});

		it("returns fileChanges with modified type when file content changes", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Modify a file
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Updated content");

			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			const modifiedChange = result.fileChanges.find((c) => c.path === "CLAUDE.md");
			expect(modifiedChange).toBeDefined();
			expect(modifiedChange?.type).toBe("modified");
		});

		it("returns fileChanges with deleted type when file removed", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			await syncPush(options);

			// Delete a file
			await fs.rm(path.join(claudeDir, "agents", "default.md"));

			const result = await syncPush(options);

			const deletedChange = result.fileChanges.find((c) => c.path === "agents/default.md");
			expect(deletedChange).toBeDefined();
			expect(deletedChange?.type).toBe("deleted");
		});

		it("pushes previously committed but unpushed changes", async () => {
			const { claudeDir, syncRepoDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Simulate a failed push: modify local + sync repo identically, commit sync repo only
			const newContent = "# Updated everywhere";
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), newContent);
			await fs.writeFile(path.join(syncRepoDir, "CLAUDE.md"), newContent);
			await simpleGit(syncRepoDir).add("CLAUDE.md");
			await simpleGit(syncRepoDir).commit("direct commit");

			// syncPush copies local files (same content), isClean() is true, but ahead > 0
			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			expect(result.message).toContain("previously committed");
			expect(result.fileChanges).toHaveLength(0);
		});

		it("throws with clear message when no remote configured", async () => {
			const noRemoteDir = path.join(tmpDir, "no-remote-repo");
			await fs.mkdir(noRemoteDir, { recursive: true });
			await initRepo(noRemoteDir);
			await simpleGit(noRemoteDir).addConfig("user.email", "test@test.com");
			await simpleGit(noRemoteDir).addConfig("user.name", "Test");
			// Initial commit so repo is valid
			await fs.writeFile(path.join(noRemoteDir, ".gitkeep"), "");
			await addFiles(noRemoteDir, [".gitkeep"]);
			await commitFiles(noRemoteDir, "initial");

			const { claudeDir, homeDir } = await createTestEnv(tmpDir);

			await expect(
				syncPush({
					claudeDir,
					syncRepoDir: noRemoteDir,
					homeDir,
				}),
			).rejects.toThrow(/[Nn]o remote/);
		});

		it("throws with clear message when remote is ahead", async () => {
			const { bareDir, syncRepoDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Clone, modify, and push from another location
			const cloneDir = path.join(tmpDir, "clone-for-ahead");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "extra.md"), "extra");
			await simpleGit(cloneDir).add("extra.md");
			await simpleGit(cloneDir).commit("add extra from clone");
			await simpleGit(cloneDir).push("origin", "main");

			// Now syncPush should detect remote is ahead and throw
			// Need to add a local change so push is attempted
			await fs.writeFile(path.join(options.claudeDir, "CLAUDE.md"), "# Modified");

			await expect(syncPush(options)).rejects.toThrow(/pull/i);
		});
	});

	describe("syncPull", () => {
		it("creates backup before applying changes", async () => {
			const { options } = await createTestEnv(tmpDir);

			// Push first so there's something to pull
			await syncPush(options);

			const result = await syncPull(options);

			expect(result.backupDir).toBeDefined();
			expect(typeof result.backupDir).toBe("string");

			// Backup should exist
			const stat = await fs.stat(result.backupDir);
			expect(stat.isDirectory()).toBe(true);
		});

		it("copies repo files to claudeDir with {{HOME}} expansion", async () => {
			const env = await createTestEnv(tmpDir);

			// Push first (this rewrites settings.json with {{HOME}})
			await syncPush(env.options);

			// Create a second claudeDir to pull into
			const newClaudeDir = path.join(tmpDir, "new-home", ".claude");
			await fs.mkdir(newClaudeDir, { recursive: true });
			// Create a dummy file so backup has something to back up
			await fs.writeFile(path.join(newClaudeDir, "CLAUDE.md"), "old");

			const newHomeDir = path.join(tmpDir, "new-home");
			const pullOptions: SyncOptions = {
				claudeDir: newClaudeDir,
				syncRepoDir: env.syncRepoDir,
				homeDir: newHomeDir,
			};

			const result = await syncPull(pullOptions);

			// settings.json should have expanded paths for new home
			const settingsContent = await fs.readFile(path.join(newClaudeDir, "settings.json"), "utf-8");
			expect(settingsContent).toContain(newHomeDir);
			expect(settingsContent).not.toContain("{{HOME}}");
			expect(result.filesApplied).toBeGreaterThan(0);
		});

		it("backup contains original files", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push first
			await syncPush(options);

			// Modify local file
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Modified before pull");

			const result = await syncPull(options);

			// Backup should contain the modified version (pre-pull state)
			const backedUpContent = await fs.readFile(path.join(result.backupDir, "CLAUDE.md"), "utf-8");
			expect(backedUpContent).toBe("# Modified before pull");
		});

		it("throws if claudeDir does not exist (backup fails)", async () => {
			const { syncRepoDir } = await createTestEnv(tmpDir);

			await expect(
				syncPull({
					claudeDir: path.join(tmpDir, "nonexistent"),
					syncRepoDir,
					homeDir: tmpDir,
				}),
			).rejects.toThrow();
		});

		it("removes local files that were deleted from the repo", async () => {
			const { bareDir, claudeDir, syncRepoDir, options } = await createTestEnv(tmpDir);

			// Push initial files (includes agents/default.md)
			await syncPush(options);

			// Simulate deletion on another machine: clone, delete, push
			const cloneDir = path.join(tmpDir, "clone-for-delete");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.rm(path.join(cloneDir, "agents", "default.md"));
			await simpleGit(cloneDir).add("agents/default.md");
			await simpleGit(cloneDir).commit("delete agent config");
			await simpleGit(cloneDir).push("origin", "main");

			// Pull should remove the deleted file locally
			const result = await syncPull(options);

			// agents/default.md should no longer exist in claudeDir
			await expect(fs.access(path.join(claudeDir, "agents", "default.md"))).rejects.toThrow();

			// fileChanges should include the deletion
			const deletedChange = result.fileChanges.find((c) => c.path === "agents/default.md");
			expect(deletedChange).toBeDefined();
			expect(deletedChange?.type).toBe("deleted");
		});

		it("returns fileChanges with added type for new files", async () => {
			const env = await createTestEnv(tmpDir);

			await syncPush(env.options);

			// Pull into a fresh claudeDir
			const newClaudeDir = path.join(tmpDir, "fresh-home", ".claude");
			await fs.mkdir(newClaudeDir, { recursive: true });

			const result = await syncPull({
				claudeDir: newClaudeDir,
				syncRepoDir: env.syncRepoDir,
				homeDir: path.join(tmpDir, "fresh-home"),
			});

			// All files should be "added" since claudeDir was empty
			expect(result.fileChanges.length).toBeGreaterThan(0);
			for (const change of result.fileChanges) {
				expect(change.type).toBe("added");
			}
		});

		it("returns fileChanges with modified type for changed files", async () => {
			const { bareDir, claudeDir, syncRepoDir, options } = await createTestEnv(tmpDir);

			await syncPush(options);

			// Simulate a change on another machine
			const cloneDir = path.join(tmpDir, "clone-for-modify");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Modified remotely");
			await simpleGit(cloneDir).add("CLAUDE.md");
			await simpleGit(cloneDir).commit("modify CLAUDE.md");
			await simpleGit(cloneDir).push("origin", "main");

			const result = await syncPull(options);

			const modifiedChange = result.fileChanges.find((c) => c.path === "CLAUDE.md");
			expect(modifiedChange).toBeDefined();
			expect(modifiedChange?.type).toBe("modified");

			// Content should be updated
			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Modified remotely");
		});

		it("returns empty fileChanges when nothing changed", async () => {
			const { options } = await createTestEnv(tmpDir);

			await syncPush(options);

			// Pull when everything is already in sync
			const result = await syncPull(options);

			expect(result.fileChanges).toHaveLength(0);
		});

		it("preserves locally modified files when remote also changed", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Simulate remote change: clone, modify, push
			const cloneDir = path.join(tmpDir, "clone-for-merge");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Remote version");
			await addFiles(cloneDir, ["CLAUDE.md"]);
			await commitFiles(cloneDir, "remote change");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify the same file locally
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Local version");

			// Pull — should keep local version and report conflict
			const result = await syncPull(options);

			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Local version");
			expect(result.conflicts).toBeDefined();
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts![0].path).toBe("CLAUDE.md");
		});

		it("applies remote changes when file has no local modifications", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Simulate remote change
			const cloneDir = path.join(tmpDir, "clone-for-apply");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Updated remotely");
			await addFiles(cloneDir, ["CLAUDE.md"]);
			await commitFiles(cloneDir, "remote update");
			await simpleGit(cloneDir).push("origin", "main");

			// Pull without local modifications — should apply remote
			const result = await syncPull(options);

			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Updated remotely");
			expect(result.fileChanges.some((c) => c.path === "CLAUDE.md")).toBe(true);
			expect(result.conflicts).toBeUndefined();
		});

		it("keeps local-only changes when remote did not modify the file", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Modify locally but don't push (remote unchanged)
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# My local edit");

			// Pull — remote hasn't changed CLAUDE.md, so local should be kept
			const result = await syncPull(options);

			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# My local edit");
			expect(result.conflicts).toBeUndefined();
		});

		it("overwrites local changes when --force is used", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Simulate remote change
			const cloneDir = path.join(tmpDir, "clone-for-force");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Force remote");
			await addFiles(cloneDir, ["CLAUDE.md"]);
			await commitFiles(cloneDir, "force change");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify locally
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# My local edit");

			// Pull with --force — should overwrite local
			const result = await syncPull({ ...options, force: true });

			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Force remote");
			expect(result.conflicts).toBeUndefined();
		});
	});

	describe("syncStatus", () => {
		it("shows modified files when local differs from repo", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Modify a local file
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Modified content");

			const status = await syncStatus(options);

			const modifiedPaths = status.localModifications.map((c) => c.path);
			expect(modifiedPaths).toContain("CLAUDE.md");
			const claudeChange = status.localModifications.find((c) => c.path === "CLAUDE.md");
			expect(claudeChange?.type).toBe("modified");
		});

		it("shows added files when local has file not in repo", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Add a new allowlisted file locally
			await fs.mkdir(path.join(claudeDir, "commands"), {
				recursive: true,
			});
			await fs.writeFile(path.join(claudeDir, "commands", "custom.md"), "custom command");

			const status = await syncStatus(options);

			const addedPaths = status.localModifications.map((c) => c.path);
			expect(addedPaths).toContain("commands/custom.md");
			const addedChange = status.localModifications.find((c) => c.path === "commands/custom.md");
			expect(addedChange?.type).toBe("added");
		});

		it("shows deleted files when repo has file not in local", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Delete a local file
			await fs.rm(path.join(claudeDir, "agents", "default.md"));

			const status = await syncStatus(options);

			const deletedPaths = status.localModifications.map((c) => c.path);
			expect(deletedPaths).toContain("agents/default.md");
			const deletedChange = status.localModifications.find((c) => c.path === "agents/default.md");
			expect(deletedChange?.type).toBe("deleted");
		});

		it("reports ahead/behind counts from git status", async () => {
			const { bareDir, options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// Push from a clone to create "behind" state
			const cloneDir = path.join(tmpDir, "clone-for-status");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "extra.md"), "extra");
			await simpleGit(cloneDir).add("extra.md");
			await simpleGit(cloneDir).commit("add extra");
			await simpleGit(cloneDir).push("origin", "main");

			const status = await syncStatus(options);

			expect(status.remoteDrift.behind).toBeGreaterThan(0);
			expect(status.hasRemote).toBe(true);
		});

		it("reports excluded file count", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Add non-allowlisted files
			await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });
			await fs.writeFile(path.join(claudeDir, "projects", "data.json"), "{}");
			await fs.writeFile(path.join(claudeDir, "randomfile.txt"), "random");

			// Push first to establish repo state
			await syncPush(options);

			const status = await syncStatus(options);

			// There should be excluded files (the non-allowlisted ones)
			expect(status.excludedCount).toBeGreaterThan(0);
		});

		it("handles no remote gracefully", async () => {
			const noRemoteDir = path.join(tmpDir, "no-remote-status");
			await fs.mkdir(noRemoteDir, { recursive: true });
			await initRepo(noRemoteDir);
			await simpleGit(noRemoteDir).addConfig("user.email", "test@test.com");
			await simpleGit(noRemoteDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(noRemoteDir, ".gitkeep"), "");
			await addFiles(noRemoteDir, [".gitkeep"]);
			await commitFiles(noRemoteDir, "initial");

			const { claudeDir, homeDir } = await createTestEnv(tmpDir);

			const status = await syncStatus({
				claudeDir,
				syncRepoDir: noRemoteDir,
				homeDir,
			});

			expect(status.hasRemote).toBe(false);
			expect(status.remoteDrift.ahead).toBe(0);
			expect(status.remoteDrift.behind).toBe(0);
		});

		it("normalizes settings.json comparison", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial files (settings.json gets {{HOME}} rewrite in repo)
			await syncPush(options);

			// settings.json hasn't changed locally, just has absolute paths
			// Status should NOT show it as modified (paths are normalized)
			const status = await syncStatus(options);

			const modifiedPaths = status.localModifications.map((c) => c.path);
			expect(modifiedPaths).not.toContain("settings.json");
		});

		it("reports syncedCount", async () => {
			const { options } = await createTestEnv(tmpDir);

			await syncPush(options);

			const status = await syncStatus(options);

			// Should count the allowlisted files in claudeDir
			expect(status.syncedCount).toBeGreaterThan(0);
		});

		it("reports isClean correctly", async () => {
			const { options } = await createTestEnv(tmpDir);

			// Push initial files
			await syncPush(options);

			// No changes -- should be clean
			const status = await syncStatus(options);
			expect(status.isClean).toBe(true);
		});

		it("reports isClean false when local modifications exist", async () => {
			const { claudeDir, options } = await createTestEnv(tmpDir);

			await syncPush(options);

			// Modify a file
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Changed");

			const status = await syncStatus(options);
			expect(status.isClean).toBe(false);
		});
	});

	describe("syncPush — verbose logging", () => {
		it("logs verbose messages when verbose=true", async () => {
			const { options } = await createTestEnv(tmpDir);
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncPush({ ...options, verbose: true });

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("[verbose]"),
				);
				expect(verboseCalls.length).toBeGreaterThan(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});

		it("does not log verbose messages when verbose is not set", async () => {
			const { options } = await createTestEnv(tmpDir);
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncPush(options);

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("[verbose]"),
				);
				expect(verboseCalls.length).toBe(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});
	});

	describe("syncPush — dry-run", () => {
		it("reports changes without actually pushing", async () => {
			const { options } = await createTestEnv(tmpDir);

			const result = await syncPush({ ...options, dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.pushed).toBe(false);
			expect(result.message).toContain("Dry run");
			expect(result.fileChanges.length).toBeGreaterThan(0);
		});

		it("reverts working tree after dry-run", async () => {
			const { syncRepoDir, options } = await createTestEnv(tmpDir);

			await syncPush({ ...options, dryRun: true });

			// The sync repo should be clean after dry-run reverts
			const git = simpleGit(syncRepoDir);
			const status = await git.status();
			expect(status.isClean()).toBe(true);
		});

		it("returns no changes on second dry-run without local modifications", async () => {
			const { options } = await createTestEnv(tmpDir);

			// First real push
			await syncPush(options);

			// Dry-run with no changes
			const result = await syncPush({ ...options, dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.pushed).toBe(false);
			expect(result.message).toContain("Dry run: no changes detected");
			expect(result.fileChanges).toHaveLength(0);
		});
	});

	describe("syncPull — dry-run", () => {
		it("v2 dry-run does not apply file changes", async () => {
			const { bareDir, claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Simulate remote change
			const cloneDir = path.join(tmpDir, "clone-for-dry-pull");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "claude", "CLAUDE.md"), "# Remote dry-run change");
			await addFiles(cloneDir, ["claude/CLAUDE.md"]);
			await commitFiles(cloneDir, "remote dry-run change");
			await simpleGit(cloneDir).push("origin", "main");

			// Save current local content
			const localBefore = await fs.readFile(path.join(claudeConfigDir, "CLAUDE.md"), "utf-8");

			// Pull with dry-run
			const result = await syncPull({ ...options, dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.message).toContain("Dry run");

			// Local file should NOT have changed (v2 path respects dryRun)
			const localAfter = await fs.readFile(path.join(claudeConfigDir, "CLAUDE.md"), "utf-8");
			expect(localAfter).toBe(localBefore);
		});
	});

	describe("syncPull — verbose logging", () => {
		it("logs verbose messages during pull when verbose=true", async () => {
			const { options } = await createTestEnv(tmpDir);

			await syncPush(options);

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncPull({ ...options, verbose: true });

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("[verbose]"),
				);
				expect(verboseCalls.length).toBeGreaterThan(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});
	});

	describe("syncPull — no remote", () => {
		it("throws when no remote configured", async () => {
			const noRemoteDir = path.join(tmpDir, "no-remote-pull");
			await fs.mkdir(noRemoteDir, { recursive: true });
			await initRepo(noRemoteDir);
			await simpleGit(noRemoteDir).addConfig("user.email", "test@test.com");
			await simpleGit(noRemoteDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(noRemoteDir, ".gitkeep"), "");
			await addFiles(noRemoteDir, [".gitkeep"]);
			await commitFiles(noRemoteDir, "initial");

			const { claudeDir, homeDir } = await createTestEnv(tmpDir);

			await expect(
				syncPull({
					claudeDir,
					syncRepoDir: noRemoteDir,
					homeDir,
				}),
			).rejects.toThrow(/[Nn]o remote/);
		});
	});

	describe("syncStatus — verbose logging", () => {
		it("logs verbose messages during status when verbose=true", async () => {
			const { options } = await createTestEnv(tmpDir);

			await syncPush(options);

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncStatus({ ...options, verbose: true });

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("[verbose]"),
				);
				expect(verboseCalls.length).toBeGreaterThan(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});
	});

	describe("v2 multi-environment — syncPush", () => {
		it("pushes files from multiple environments into subdirectories", async () => {
			const { syncRepoDir, options } = await createV2TestEnv(tmpDir);

			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			expect(result.filesUpdated).toBeGreaterThan(0);
			expect(result.perEnvironment).toBeDefined();
			expect(result.perEnvironment?.claude).toBeDefined();
			expect(result.perEnvironment?.opencode).toBeDefined();

			// Verify files are in subdirectories
			const claudeMd = await fs.readFile(
				path.join(syncRepoDir, "claude", "CLAUDE.md"),
				"utf-8",
			);
			expect(claudeMd).toBe("# Claude Config");

			const agentMd = await fs.readFile(
				path.join(syncRepoDir, "opencode", "agents", "default.md"),
				"utf-8",
			);
			expect(agentMd).toBe("opencode agent");
		});

		it("rewrites settings.json paths in v2 mode", async () => {
			const { syncRepoDir, homeDir, options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			const settingsContent = await fs.readFile(
				path.join(syncRepoDir, "claude", "settings.json"),
				"utf-8",
			);
			expect(settingsContent).toContain("{{HOME}}");
			expect(settingsContent).not.toContain(homeDir);
		});

		it("handles filterEnv to limit push to one environment", async () => {
			const { syncRepoDir, options } = await createV2TestEnv(tmpDir);

			const result = await syncPush({ ...options, filterEnv: "claude" });

			expect(result.pushed).toBe(true);
			expect(result.perEnvironment).toBeDefined();
			expect(result.perEnvironment?.claude).toBeDefined();
			expect(result.perEnvironment?.opencode).toBeUndefined();

			// Claude files should exist
			const claudeMd = await fs.readFile(
				path.join(syncRepoDir, "claude", "CLAUDE.md"),
				"utf-8",
			);
			expect(claudeMd).toBe("# Claude Config");

			// Opencode subdir should NOT exist
			await expect(
				fs.access(path.join(syncRepoDir, "opencode")),
			).rejects.toThrow();
		});

		it("skips environments whose config dir does not exist", async () => {
			const { syncRepoDir, options, opencodeConfigDir } = await createV2TestEnv(tmpDir);

			// Remove the opencode config dir
			await fs.rm(opencodeConfigDir, { recursive: true, force: true });

			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			expect(result.perEnvironment?.opencode).toBeDefined();
			expect(result.perEnvironment?.opencode?.filesUpdated).toBe(0);
		});

		it("returns no changes in v2 when nothing changed", async () => {
			const { options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			const result = await syncPush(options);

			expect(result.pushed).toBe(false);
			expect(result.message).toContain("No changes");
		});

		it("detects deleted files in v2 per-environment push", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Delete a file from claude config
			await fs.rm(path.join(claudeConfigDir, "commands", "test.md"));

			// Push again
			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			const deletedChange = result.fileChanges.find((c) => c.path.includes("commands/test.md"));
			expect(deletedChange).toBeDefined();
			expect(deletedChange?.type).toBe("deleted");
		});

		it("tracks per-environment stats for file changes in v2", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Modify only a claude file
			await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Updated Claude");

			const result = await syncPush(options);

			expect(result.pushed).toBe(true);
			expect(result.perEnvironment?.claude?.filesUpdated).toBeGreaterThan(0);
			expect(result.perEnvironment?.claude?.fileChanges.length).toBeGreaterThan(0);
		});

		it("dry-run in v2 does not push and sets dryRun flag", async () => {
			const { options } = await createV2TestEnv(tmpDir);

			const result = await syncPush({ ...options, dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.pushed).toBe(false);
			expect(result.message).toContain("Dry run");
			// In v2, dry-run skips file writing, so git status is clean and no file changes are detected
			expect(result.perEnvironment).toBeDefined();
		});

		it("verbose in v2 logs environment processing messages", async () => {
			const { options } = await createV2TestEnv(tmpDir);
			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncPush({ ...options, verbose: true });

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) => typeof call[0] === "string" && call[0].includes("[verbose]"),
				);
				// Should include "Processing environment:" messages
				const envMessages = verboseCalls.filter(
					(call) => call[0].includes("Processing environment"),
				);
				expect(envMessages.length).toBeGreaterThan(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});
	});

	describe("v2 multi-environment — syncPull", () => {
		it("pulls files from v2 repo into per-environment config dirs", async () => {
			const { claudeConfigDir, opencodeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push first
			await syncPush(options);

			// Clear local config dirs to simulate pull on a new machine
			await fs.rm(claudeConfigDir, { recursive: true, force: true });
			await fs.mkdir(claudeConfigDir, { recursive: true });
			await fs.rm(opencodeConfigDir, { recursive: true, force: true });
			await fs.mkdir(opencodeConfigDir, { recursive: true });

			const result = await syncPull(options);

			expect(result.filesApplied).toBeGreaterThan(0);
			expect(result.perEnvironment).toBeDefined();
			expect(result.perEnvironment?.claude).toBeDefined();
			expect(result.perEnvironment?.opencode).toBeDefined();

			// Verify files were restored
			const claudeMd = await fs.readFile(
				path.join(claudeConfigDir, "CLAUDE.md"),
				"utf-8",
			);
			expect(claudeMd).toBe("# Claude Config");

			const agentMd = await fs.readFile(
				path.join(opencodeConfigDir, "agents", "default.md"),
				"utf-8",
			);
			expect(agentMd).toBe("opencode agent");
		});

		it("expands {{HOME}} paths in v2 pull", async () => {
			const { claudeConfigDir, homeDir, options } = await createV2TestEnv(tmpDir);

			// Push (rewrites paths)
			await syncPush(options);

			// Clear and pull into a new home
			const newHomeDir = path.join(tmpDir, "new-home");
			const newClaudeDir = path.join(newHomeDir, ".claude");
			const newOpencodeDir = path.join(newHomeDir, ".config", "opencode");
			await fs.mkdir(newClaudeDir, { recursive: true });
			await fs.mkdir(newOpencodeDir, { recursive: true });

			const newClaudeEnv = createMockEnvironment("claude", "Claude Code", newClaudeDir);
			const newOpencodeEnv = createMockEnvironment("opencode", "OpenCode", newOpencodeDir);

			const pullResult = await syncPull({
				...options,
				homeDir: newHomeDir,
				environments: [newClaudeEnv, newOpencodeEnv],
			});

			expect(pullResult.filesApplied).toBeGreaterThan(0);

			// settings.json should have expanded paths for the new home
			const settings = await fs.readFile(
				path.join(newClaudeDir, "settings.json"),
				"utf-8",
			);
			expect(settings).toContain(newHomeDir);
			expect(settings).not.toContain("{{HOME}}");
		});

		it("creates backup of all environments before pull in v2", async () => {
			const { options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			const result = await syncPull(options);

			expect(result.backupDir).toBeDefined();
			expect(result.backupDir.length).toBeGreaterThan(0);
			const stat = await fs.stat(result.backupDir);
			expect(stat.isDirectory()).toBe(true);
		});

		it("detects 3-way merge conflict in v2 and keeps local", async () => {
			const { bareDir, syncRepoDir, claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Simulate remote change: clone, modify claude/CLAUDE.md, push
			const cloneDir = path.join(tmpDir, "clone-v2-conflict");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "claude", "CLAUDE.md"), "# Remote V2 version");
			await addFiles(cloneDir, ["claude/CLAUDE.md"]);
			await commitFiles(cloneDir, "remote v2 change");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify the same file locally
			await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Local V2 version");

			const result = await syncPull(options);

			// Local should be preserved
			const content = await fs.readFile(path.join(claudeConfigDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Local V2 version");
			expect(result.conflicts).toBeDefined();
			expect(result.conflicts!.length).toBeGreaterThan(0);
			expect(result.perEnvironment?.claude?.conflicts).toBeDefined();
		});

		it("force overrides conflicts in v2 pull", async () => {
			const { bareDir, claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Simulate remote change
			const cloneDir = path.join(tmpDir, "clone-v2-force");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "claude", "CLAUDE.md"), "# Force Remote V2");
			await addFiles(cloneDir, ["claude/CLAUDE.md"]);
			await commitFiles(cloneDir, "force remote v2 change");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify locally
			await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Local stays?");

			// Pull with force
			const result = await syncPull({ ...options, force: true });

			const content = await fs.readFile(path.join(claudeConfigDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Force Remote V2");
			expect(result.conflicts).toBeUndefined();
		});

		it("handles deletion from remote in v2 pull", async () => {
			const { bareDir, claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Simulate remote deletion
			const cloneDir = path.join(tmpDir, "clone-v2-delete");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.rm(path.join(cloneDir, "claude", "commands", "test.md"));
			await simpleGit(cloneDir).add("claude/commands/test.md");
			await simpleGit(cloneDir).commit("delete command");
			await simpleGit(cloneDir).push("origin", "main");

			const result = await syncPull(options);

			// Local file should be deleted
			await expect(
				fs.access(path.join(claudeConfigDir, "commands", "test.md")),
			).rejects.toThrow();

			const deletedChange = result.fileChanges.find((c) =>
				c.path.includes("commands/test.md"),
			);
			expect(deletedChange).toBeDefined();
			expect(deletedChange?.type).toBe("deleted");
		});

		it("dry-run in v2 pull does not apply changes", async () => {
			const { bareDir, claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Simulate remote change
			const cloneDir = path.join(tmpDir, "clone-v2-dryrun");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "claude", "CLAUDE.md"), "# Dry run remote");
			await addFiles(cloneDir, ["claude/CLAUDE.md"]);
			await commitFiles(cloneDir, "dry run remote change");
			await simpleGit(cloneDir).push("origin", "main");

			const localBefore = await fs.readFile(
				path.join(claudeConfigDir, "CLAUDE.md"),
				"utf-8",
			);

			const result = await syncPull({ ...options, dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.message).toContain("Dry run");

			// Local file should NOT have changed
			const localAfter = await fs.readFile(
				path.join(claudeConfigDir, "CLAUDE.md"),
				"utf-8",
			);
			expect(localAfter).toBe(localBefore);
		});

		it("handles environments with no files in repo subdir", async () => {
			const { options } = await createV2TestEnv(tmpDir);

			// Push only claude environment
			const result = await syncPush({ ...options, filterEnv: "claude" });
			expect(result.pushed).toBe(true);

			// Pull for opencode which has no repo subdir yet
			const pullResult = await syncPull({ ...options, filterEnv: "opencode" });

			expect(pullResult.perEnvironment?.opencode).toBeDefined();
			expect(pullResult.perEnvironment?.opencode?.filesApplied).toBe(0);
		});
	});

	describe("v2 multi-environment — syncStatus", () => {
		it("reports per-environment modifications", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			// Modify a file in claude
			await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Modified");

			const status = await syncStatus(options);

			expect(status.perEnvironment).toBeDefined();
			expect(status.perEnvironment?.claude).toBeDefined();
			expect(status.perEnvironment?.opencode).toBeDefined();

			const claudeMods = status.perEnvironment?.claude?.localModifications;
			expect(claudeMods?.some((m) => m.path === "CLAUDE.md")).toBe(true);
		});

		it("reports per-environment synced and excluded counts", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			// Add a non-allowlisted file
			await fs.writeFile(path.join(claudeConfigDir, "randomfile.txt"), "random");

			await syncPush(options);

			const status = await syncStatus(options);

			expect(status.syncedCount).toBeGreaterThan(0);
			expect(status.perEnvironment?.claude?.syncedCount).toBeGreaterThan(0);
		});

		it("reports added/deleted files in v2 status", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			// Add a new file locally
			await fs.writeFile(path.join(claudeConfigDir, "commands", "new.md"), "new command");

			// Delete a file locally
			await fs.rm(path.join(claudeConfigDir, "commands", "test.md"));

			const status = await syncStatus(options);

			const addedPaths = status.localModifications.filter((m) => m.type === "added");
			const deletedPaths = status.localModifications.filter((m) => m.type === "deleted");

			expect(addedPaths.some((m) => m.path.includes("commands/new.md"))).toBe(true);
			expect(deletedPaths.some((m) => m.path.includes("commands/test.md"))).toBe(true);
		});

		it("uses filterEnv to limit status check", async () => {
			const { claudeConfigDir, options } = await createV2TestEnv(tmpDir);

			await syncPush(options);

			// Modify claude file
			await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "# Modified");

			const status = await syncStatus({ ...options, filterEnv: "claude" });

			expect(status.perEnvironment?.claude).toBeDefined();
			expect(status.perEnvironment?.opencode).toBeUndefined();
		});
	});

	describe("v1 pull — conflict scenarios", () => {
		it("keeps local when both sides modified, reports conflict without force", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial state
			await syncPush(options);

			// Remote change
			const cloneDir = path.join(tmpDir, "clone-conflict-both");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Remote conflict version");
			await addFiles(cloneDir, ["CLAUDE.md"]);
			await commitFiles(cloneDir, "remote conflict change");
			await simpleGit(cloneDir).push("origin", "main");

			// Local change
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Local conflict version");

			const result = await syncPull(options);

			// Local should be kept
			const content = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Local conflict version");

			// Should report conflict
			expect(result.conflicts).toBeDefined();
			expect(result.conflicts!.length).toBe(1);
			expect(result.conflicts![0].path).toBe("CLAUDE.md");
			expect(result.conflicts![0].type).toBe("modified");

			// Message should mention conflicts
			expect(result.message).toContain("conflict");
		});

		it("handles remote-deleted file with local modification as conflict", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Remote deletion
			const cloneDir = path.join(tmpDir, "clone-del-conflict");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.rm(path.join(cloneDir, "agents", "default.md"));
			await simpleGit(cloneDir).add("agents/default.md");
			await simpleGit(cloneDir).commit("delete agent");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify the same file locally
			await fs.writeFile(path.join(claudeDir, "agents", "default.md"), "modified locally");

			const result = await syncPull(options);

			// File should still exist locally (conflict)
			const content = await fs.readFile(path.join(claudeDir, "agents", "default.md"), "utf-8");
			expect(content).toBe("modified locally");

			// Should have a conflict of type deleted
			expect(result.conflicts).toBeDefined();
			const delConflict = result.conflicts!.find((c) => c.path === "agents/default.md");
			expect(delConflict).toBeDefined();
			expect(delConflict?.type).toBe("deleted");
		});

		it("force-deletes locally modified file when remote deleted and force=true", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			// Push initial
			await syncPush(options);

			// Remote deletion
			const cloneDir = path.join(tmpDir, "clone-force-del");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.rm(path.join(cloneDir, "agents", "default.md"));
			await simpleGit(cloneDir).add("agents/default.md");
			await simpleGit(cloneDir).commit("delete agent force");
			await simpleGit(cloneDir).push("origin", "main");

			// Modify locally
			await fs.writeFile(path.join(claudeDir, "agents", "default.md"), "modified");

			const result = await syncPull({ ...options, force: true });

			// File should be deleted
			await expect(
				fs.access(path.join(claudeDir, "agents", "default.md")),
			).rejects.toThrow();
			expect(result.conflicts).toBeUndefined();
		});

		it("verbose logging for conflict keeps local message", async () => {
			const { bareDir, claudeDir, options } = await createTestEnv(tmpDir);

			await syncPush(options);

			// Remote change
			const cloneDir = path.join(tmpDir, "clone-verbose-conflict");
			await fs.mkdir(cloneDir, { recursive: true });
			await simpleGit(cloneDir).clone(bareDir, ".");
			await simpleGit(cloneDir).addConfig("user.email", "test@test.com");
			await simpleGit(cloneDir).addConfig("user.name", "Test");
			await fs.writeFile(path.join(cloneDir, "CLAUDE.md"), "# Remote verbose conflict");
			await addFiles(cloneDir, ["CLAUDE.md"]);
			await commitFiles(cloneDir, "verbose conflict change");
			await simpleGit(cloneDir).push("origin", "main");

			// Local change
			await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "# Local verbose conflict");

			const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await syncPull({ ...options, verbose: true });

				const verboseCalls = consoleSpy.mock.calls.filter(
					(call) =>
						typeof call[0] === "string" && call[0].includes("Conflict (keeping local)"),
				);
				expect(verboseCalls.length).toBeGreaterThan(0);
			} finally {
				consoleSpy.mockRestore();
			}
		});
	});
});
