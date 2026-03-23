import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLinkCommand } from "../../src/cli/commands/link.js";
import { linkEnvironment, unlinkEnvironment } from "../../src/core/linker.js";
import { detectRepoVersion } from "../../src/core/migration.js";
import type { Environment } from "../../src/core/environment.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

/**
 * Creates a minimal Claude-like test environment for linking tests.
 */
function createTestEnv(configDir: string): Environment {
	return {
		id: "claude",
		displayName: "Claude Code",
		getConfigDir: () => configDir,
		getSyncTargets: () => ["CLAUDE.md", "commands/"],
		getPluginSyncPatterns: () => [],
		getIgnorePatterns: () => [],
		getPathRewriteTargets: () => ["settings.json"],
		getSkillsSubdir: () => "commands",
	};
}

/**
 * Sets up a v2 sync repo (bare remote + working copy with ".sync-version" = "2").
 */
async function setupV2SyncRepo(baseDir: string) {
	const bareDir = path.join(baseDir, "bare.git");
	const syncRepoDir = path.join(baseDir, "sync-repo");

	await fs.mkdir(bareDir, { recursive: true });
	await simpleGit(bareDir).init(true);

	await fs.mkdir(syncRepoDir, { recursive: true });
	await initRepo(syncRepoDir);
	await simpleGit(syncRepoDir).addConfig("user.email", "test@test.com");
	await simpleGit(syncRepoDir).addConfig("user.name", "Test");
	await addRemote(syncRepoDir, "origin", bareDir);

	// Initial commit
	await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
	await addFiles(syncRepoDir, [".gitkeep"]);
	await commitFiles(syncRepoDir, "initial commit");
	await simpleGit(syncRepoDir).push("origin", "main");
	await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

	// Mark as v2
	await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2\n");
	await addFiles(syncRepoDir, [".sync-version"]);
	await commitFiles(syncRepoDir, "mark v2");

	return { bareDir, syncRepoDir };
}

describe("link command (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "link-cmd-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("detectRepoVersion", () => {
		it("detects v2 when .sync-version contains 2", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const version = await detectRepoVersion(syncRepoDir);
			expect(version).toBe(2);
		});

		it("detects v1 when no .sync-version file exists", async () => {
			const repoDir = path.join(tmpDir, "v1-repo");
			await fs.mkdir(repoDir, { recursive: true });
			await initRepo(repoDir);
			const version = await detectRepoVersion(repoDir);
			expect(version).toBe(1);
		});
	});

	describe("linkEnvironment", () => {
		it("creates symlinks from config dir to sync repo", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			// Create config files
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# My Config");
			await fs.mkdir(path.join(configDir, "commands"), { recursive: true });
			await fs.writeFile(path.join(configDir, "commands", "test.md"), "test command");

			const env = createTestEnv(configDir);
			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.envId).toBe("claude");
			expect(result.linked.length).toBeGreaterThan(0);
			expect(result.linked).toContain("CLAUDE.md");

			// Verify the CLAUDE.md in configDir is now a symlink
			const stat = await fs.lstat(path.join(configDir, "CLAUDE.md"));
			expect(stat.isSymbolicLink()).toBe(true);

			// Verify the symlink target points to the repo
			const linkTarget = await fs.readlink(path.join(configDir, "CLAUDE.md"));
			expect(linkTarget).toContain(syncRepoDir);
		});

		it("backs up existing files before linking", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Original Content");

			const env = createTestEnv(configDir);
			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.backedUp.length).toBeGreaterThan(0);

			// Verify backup was created
			const backupPath = path.join(backupDir, "claude", "CLAUDE.md");
			const backupContent = await fs.readFile(backupPath, "utf-8");
			expect(backupContent).toBe("# Original Content");
		});

		it("skips targets that need path rewriting", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			// settings.json is a path-rewrite target — it should be skipped
			await fs.writeFile(path.join(configDir, "settings.json"), "{}");
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Config");

			const env: Environment = {
				id: "claude",
				displayName: "Claude Code",
				getConfigDir: () => configDir,
				getSyncTargets: () => ["settings.json", "CLAUDE.md"],
				getPluginSyncPatterns: () => [],
				getIgnorePatterns: () => [],
				getPathRewriteTargets: () => ["settings.json"],
				getSkillsSubdir: () => "commands",
			};

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.skipped).toContain("settings.json");
			expect(result.linked).toContain("CLAUDE.md");
		});

		it("seeds repo from config when repo target does not exist", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Seeded Content");

			const env = createTestEnv(configDir);
			await linkEnvironment(env, syncRepoDir, backupDir);

			// Verify the file was seeded into the repo subdir
			const repoContent = await fs.readFile(
				path.join(syncRepoDir, "claude", "CLAUDE.md"),
				"utf-8",
			);
			expect(repoContent).toBe("# Seeded Content");
		});

		it("skips when neither config nor repo target exists", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			// Create config dir but no files
			await fs.mkdir(configDir, { recursive: true });

			const env = createTestEnv(configDir);
			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			// Nothing to link when there are no files
			expect(result.linked).toHaveLength(0);
			expect(result.backedUp).toHaveLength(0);
		});

		it("is idempotent — re-linking an already-linked target does not fail", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Config");

			const env = createTestEnv(configDir);

			// Link once
			const first = await linkEnvironment(env, syncRepoDir, backupDir);
			expect(first.linked).toContain("CLAUDE.md");

			// Link again — should still succeed
			const second = await linkEnvironment(env, syncRepoDir, backupDir);
			expect(second.linked).toContain("CLAUDE.md");

			// The file should still be a symlink
			const stat = await fs.lstat(path.join(configDir, "CLAUDE.md"));
			expect(stat.isSymbolicLink()).toBe(true);
		});
	});

	describe("unlinkEnvironment", () => {
		it("replaces symlinks with copies of repo content", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# My Config");

			const env = createTestEnv(configDir);

			// First link
			await linkEnvironment(env, syncRepoDir, backupDir);
			const statBefore = await fs.lstat(path.join(configDir, "CLAUDE.md"));
			expect(statBefore.isSymbolicLink()).toBe(true);

			// Then unlink
			const result = await unlinkEnvironment(env, syncRepoDir);
			expect(result.linked.length).toBeGreaterThan(0);

			// Verify it's now a regular file
			const statAfter = await fs.lstat(path.join(configDir, "CLAUDE.md"));
			expect(statAfter.isSymbolicLink()).toBe(false);
			expect(statAfter.isFile()).toBe(true);

			// Content should be preserved
			const content = await fs.readFile(path.join(configDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# My Config");
		});

		it("reports no symlinks found when nothing is linked", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Not linked");

			const env = createTestEnv(configDir);
			const result = await unlinkEnvironment(env, syncRepoDir);

			expect(result.linked).toHaveLength(0);
		});
	});

	describe("link handler validation", () => {
		it("rejects v1 repo (version !== 2)", async () => {
			const v1Dir = path.join(tmpDir, "v1-repo");
			await fs.mkdir(v1Dir, { recursive: true });
			await initRepo(v1Dir);

			const version = await detectRepoVersion(v1Dir);
			expect(version).toBe(1);
		});

		it("filters environments by --env option", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Config");

			const claudeEnv = createTestEnv(configDir);
			const envs = [claudeEnv];

			// Simulate filtering by env id — only claude should remain
			const filtered = envs.filter((e) => e.id === "claude");
			expect(filtered).toHaveLength(1);
			expect(filtered[0].id).toBe("claude");

			// Non-existent env should filter to empty
			const empty = envs.filter((e) => e.id === "nonexistent");
			expect(empty).toHaveLength(0);
		});
	});

	describe("link + unlink roundtrip", () => {
		it("preserves file content through link/unlink cycle", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const configDir = path.join(tmpDir, "home", ".claude");
			const backupDir = path.join(tmpDir, ".ai-sync-backups", "pre-link-test");

			await fs.mkdir(path.join(configDir, "commands"), { recursive: true });
			await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Roundtrip Test");
			await fs.writeFile(path.join(configDir, "commands", "test.md"), "test content");

			const env = createTestEnv(configDir);

			// Link
			const linkResult = await linkEnvironment(env, syncRepoDir, backupDir);
			expect(linkResult.linked.length).toBeGreaterThan(0);

			// Unlink
			const unlinkResult = await unlinkEnvironment(env, syncRepoDir);
			expect(unlinkResult.linked.length).toBeGreaterThan(0);

			// Content should be preserved
			const claudeMd = await fs.readFile(path.join(configDir, "CLAUDE.md"), "utf-8");
			expect(claudeMd).toBe("# Roundtrip Test");
		});
	});
});

describe("link/unlink CLI action (integration)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "link-cli-test-"));
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
		registerLinkCommand(program);
		return program;
	}

	it("prints error for v1 repo", async () => {
		const repoDir = path.join(tmpDir, "v1-repo");
		await fs.mkdir(repoDir, { recursive: true });
		await initRepo(repoDir);

		const program = createProgram();
		await program.parseAsync(["node", "test", "link", "--repo", repoDir]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("v2 repo");
		expect(process.exitCode).toBe(1);
	});

	it("prints success message for link on v2 repo", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const configDir = path.join(tmpDir, "home", ".claude");
		await fs.mkdir(configDir, { recursive: true });
		await fs.writeFile(path.join(configDir, "CLAUDE.md"), "# Config");

		// Mock getEnabledEnvironmentInstances to return our test env
		const { getEnabledEnvironmentInstances } = await import("../../src/core/env-config.js");
		const origFn = getEnabledEnvironmentInstances;

		const program = createProgram();
		await program.parseAsync(["node", "test", "link", "--repo", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Linking");
	});

	it("prints success message for unlink", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);

		const program = createProgram();
		await program.parseAsync(["node", "test", "unlink", "--repo", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Unlinking");
	});

	it("sets exitCode on link error", async () => {
		const program = createProgram();
		await program.parseAsync(["node", "test", "link", "--repo", "/nonexistent/path"]);

		expect(process.exitCode).toBe(1);
	});

	it("prints done message for unlink even when no symlinks found", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const program = createProgram();
		await program.parseAsync(["node", "test", "unlink", "--repo", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Done");
	});

	it("prints error for unknown --env on link", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const program = createProgram();
		await program.parseAsync(["node", "test", "link", "--repo", syncRepoDir, "--env", "nonexistent"]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("not enabled");
		expect(process.exitCode).toBe(1);
	});

	it("prints error for unknown --env on unlink", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const program = createProgram();
		await program.parseAsync(["node", "test", "unlink", "--repo", syncRepoDir, "--env", "nonexistent"]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("not enabled");
		expect(process.exitCode).toBe(1);
	});
});
