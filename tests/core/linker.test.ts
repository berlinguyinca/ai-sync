import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Environment } from "../../src/core/environment.js";
import {
	getLinkableTargets,
	getUnlinkableTargets,
	linkEnvironment,
	linkSharedDirectory,
	unlinkEnvironment,
} from "../../src/core/linker.js";

/** Minimal test environment for link tests. */
function createTestEnv(configDir: string): Environment {
	return {
		id: "testenv",
		displayName: "Test Env",
		getConfigDir: () => configDir,
		getSyncTargets: () => ["settings.json", "CLAUDE.md", "agents/", "commands/"],
		getPluginSyncPatterns: () => ["plugins/blocklist.json", "plugins/cache/"],
		getIgnorePatterns: () => [],
		getPathRewriteTargets: () => ["settings.json"],
		getSkillsSubdir: () => "commands",
	};
}

describe("core/linker", () => {
	let tmpDir: string;
	let configDir: string;
	let syncRepoDir: string;
	let backupDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linker-test-"));
		configDir = path.join(tmpDir, "config");
		syncRepoDir = path.join(tmpDir, "repo");
		backupDir = path.join(tmpDir, "backup");
		fs.mkdirSync(configDir, { recursive: true });
		fs.mkdirSync(syncRepoDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("getLinkableTargets", () => {
		it("excludes files that need path rewriting", () => {
			const env = createTestEnv(configDir);
			const linkable = getLinkableTargets(env);
			expect(linkable).not.toContain("settings.json");
		});

		it("includes files that do not need path rewriting", () => {
			const env = createTestEnv(configDir);
			const linkable = getLinkableTargets(env);
			expect(linkable).toContain("CLAUDE.md");
		});

		it("includes directory targets", () => {
			const env = createTestEnv(configDir);
			const linkable = getLinkableTargets(env);
			expect(linkable).toContain("agents/");
			expect(linkable).toContain("commands/");
		});

		it("includes plugin directory patterns", () => {
			const env = createTestEnv(configDir);
			const linkable = getLinkableTargets(env);
			expect(linkable).toContain("plugins/cache/");
		});

		it("includes plugin file patterns that do not need rewriting", () => {
			const env = createTestEnv(configDir);
			const linkable = getLinkableTargets(env);
			expect(linkable).toContain("plugins/blocklist.json");
		});
	});

	describe("getUnlinkableTargets", () => {
		it("returns files that need path rewriting", () => {
			const env = createTestEnv(configDir);
			const unlinkable = getUnlinkableTargets(env);
			expect(unlinkable).toContain("settings.json");
		});

		it("does not include directories", () => {
			const env = createTestEnv(configDir);
			const unlinkable = getUnlinkableTargets(env);
			expect(unlinkable).not.toContain("agents/");
		});
	});

	describe("linkEnvironment", () => {
		it("creates symlinks from config dir to repo", async () => {
			const env = createTestEnv(configDir);

			// Create a file in config dir
			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# My config");

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.linked).toContain("CLAUDE.md");
			// Config path should be a symlink
			const stat = fs.lstatSync(path.join(configDir, "CLAUDE.md"));
			expect(stat.isSymbolicLink()).toBe(true);
			// Symlink should point to repo
			const target = fs.readlinkSync(path.join(configDir, "CLAUDE.md"));
			expect(target).toBe(path.join(syncRepoDir, "testenv", "CLAUDE.md"));
		});

		it("seeds repo from config when repo target does not exist", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# My config");

			await linkEnvironment(env, syncRepoDir, backupDir);

			// Repo should now have the file
			const repoContent = fs.readFileSync(path.join(syncRepoDir, "testenv", "CLAUDE.md"), "utf-8");
			expect(repoContent).toBe("# My config");
		});

		it("backs up existing files before linking", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# Original");

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.backedUp).toContain("CLAUDE.md");
			const backedUpContent = fs.readFileSync(
				path.join(backupDir, "testenv", "CLAUDE.md"),
				"utf-8",
			);
			expect(backedUpContent).toBe("# Original");
		});

		it("symlinks directories", async () => {
			const env = createTestEnv(configDir);

			const commandsDir = path.join(configDir, "commands");
			fs.mkdirSync(commandsDir, { recursive: true });
			fs.writeFileSync(path.join(commandsDir, "foo.md"), "# foo");

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.linked).toContain("commands/");
			const stat = fs.lstatSync(path.join(configDir, "commands"));
			expect(stat.isSymbolicLink()).toBe(true);
			// Content should be accessible through symlink
			const content = fs.readFileSync(path.join(configDir, "commands", "foo.md"), "utf-8");
			expect(content).toBe("# foo");
		});

		it("skips targets that need path rewriting", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "settings.json"), "{}");

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.skipped).toContain("settings.json");
			// settings.json should NOT be a symlink
			const stat = fs.lstatSync(path.join(configDir, "settings.json"));
			expect(stat.isSymbolicLink()).toBe(false);
		});

		it("skips targets that do not exist anywhere", async () => {
			const env = createTestEnv(configDir);

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			// Nothing linked because no files exist
			expect(result.linked).toHaveLength(0);
		});

		it("is idempotent — does not re-link existing correct symlinks", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# Config");

			await linkEnvironment(env, syncRepoDir, backupDir);
			const result2 = await linkEnvironment(env, syncRepoDir, backupDir);

			// Should still be linked but not backed up again
			expect(result2.linked).toContain("CLAUDE.md");
			expect(result2.backedUp).not.toContain("CLAUDE.md");
		});

		it("links from repo when config does not exist but repo does", async () => {
			const env = createTestEnv(configDir);

			// Put file only in repo
			const repoSubdir = path.join(syncRepoDir, "testenv");
			fs.mkdirSync(repoSubdir, { recursive: true });
			fs.writeFileSync(path.join(repoSubdir, "CLAUDE.md"), "# From repo");

			const result = await linkEnvironment(env, syncRepoDir, backupDir);

			expect(result.linked).toContain("CLAUDE.md");
			const content = fs.readFileSync(path.join(configDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# From repo");
		});
	});

	describe("linkSharedDirectory", () => {
		it("creates symlink when shared/ exists in repo", async () => {
			// Create shared/ in the repo
			const repoSharedDir = path.join(syncRepoDir, "shared");
			fs.mkdirSync(repoSharedDir, { recursive: true });
			fs.writeFileSync(path.join(repoSharedDir, "standards.md"), "# Standards");

			const result = await linkSharedDirectory(syncRepoDir, configDir, backupDir);

			expect(result.linked).toBe(true);
			expect(result.backedUp).toBe(false);
			// configDir/shared should be a symlink pointing to repoSharedDir
			const stat = fs.lstatSync(path.join(configDir, "shared"));
			expect(stat.isSymbolicLink()).toBe(true);
			const target = fs.readlinkSync(path.join(configDir, "shared"));
			expect(target).toBe(repoSharedDir);
		});

		it("returns linked:false when shared/ does not exist in repo", async () => {
			const result = await linkSharedDirectory(syncRepoDir, configDir, backupDir);

			expect(result.linked).toBe(false);
			expect(result.backedUp).toBe(false);
		});

		it("backs up existing real directory before linking", async () => {
			// Create shared/ in the repo
			const repoSharedDir = path.join(syncRepoDir, "shared");
			fs.mkdirSync(repoSharedDir, { recursive: true });
			fs.writeFileSync(path.join(repoSharedDir, "standards.md"), "# Repo standards");

			// Create a real shared/ in the config dir
			const configSharedDir = path.join(configDir, "shared");
			fs.mkdirSync(configSharedDir, { recursive: true });
			fs.writeFileSync(path.join(configSharedDir, "local.md"), "# Local content");

			const result = await linkSharedDirectory(syncRepoDir, configDir, backupDir);

			expect(result.linked).toBe(true);
			expect(result.backedUp).toBe(true);
			// Backup should contain the original file
			const backedUpContent = fs.readFileSync(path.join(backupDir, "shared", "local.md"), "utf-8");
			expect(backedUpContent).toBe("# Local content");
			// configDir/shared should now be a symlink
			const stat = fs.lstatSync(path.join(configDir, "shared"));
			expect(stat.isSymbolicLink()).toBe(true);
		});

		it("replaces existing symlink without backup", async () => {
			// Create shared/ in the repo
			const repoSharedDir = path.join(syncRepoDir, "shared");
			fs.mkdirSync(repoSharedDir, { recursive: true });
			fs.writeFileSync(path.join(repoSharedDir, "standards.md"), "# Standards");

			// Create an old symlink pointing elsewhere
			const otherDir = path.join(tmpDir, "other");
			fs.mkdirSync(otherDir, { recursive: true });
			fs.symlinkSync(otherDir, path.join(configDir, "shared"));

			const result = await linkSharedDirectory(syncRepoDir, configDir, backupDir);

			expect(result.linked).toBe(true);
			expect(result.backedUp).toBe(false);
			// Should now point to the repo shared dir
			const target = fs.readlinkSync(path.join(configDir, "shared"));
			expect(target).toBe(repoSharedDir);
		});
	});

	describe("unlinkEnvironment", () => {
		it("replaces symlinks with copies", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# Config");
			await linkEnvironment(env, syncRepoDir, backupDir);

			// Verify it's a symlink
			expect(fs.lstatSync(path.join(configDir, "CLAUDE.md")).isSymbolicLink()).toBe(true);

			const result = await unlinkEnvironment(env, syncRepoDir);

			expect(result.linked).toContain("CLAUDE.md");
			// Should no longer be a symlink
			const stat = fs.lstatSync(path.join(configDir, "CLAUDE.md"));
			expect(stat.isSymbolicLink()).toBe(false);
			// Content should be preserved
			const content = fs.readFileSync(path.join(configDir, "CLAUDE.md"), "utf-8");
			expect(content).toBe("# Config");
		});

		it("handles directory symlinks", async () => {
			const env = createTestEnv(configDir);

			const commandsDir = path.join(configDir, "commands");
			fs.mkdirSync(commandsDir, { recursive: true });
			fs.writeFileSync(path.join(commandsDir, "foo.md"), "# foo");
			await linkEnvironment(env, syncRepoDir, backupDir);

			const result = await unlinkEnvironment(env, syncRepoDir);

			expect(result.linked).toContain("commands/");
			const stat = fs.lstatSync(path.join(configDir, "commands"));
			expect(stat.isSymbolicLink()).toBe(false);
			expect(stat.isDirectory()).toBe(true);
			const content = fs.readFileSync(path.join(configDir, "commands", "foo.md"), "utf-8");
			expect(content).toBe("# foo");
		});

		it("is a no-op when nothing is symlinked", async () => {
			const env = createTestEnv(configDir);

			fs.writeFileSync(path.join(configDir, "CLAUDE.md"), "# Config");

			const result = await unlinkEnvironment(env, syncRepoDir);

			expect(result.linked).toHaveLength(0);
		});
	});
});
