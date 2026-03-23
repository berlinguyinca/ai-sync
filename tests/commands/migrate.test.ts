import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMigrateCommand } from "../../src/cli/commands/migrate.js";
import { detectRepoVersion, migrateToV2 } from "../../src/core/migration.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

/**
 * Sets up a v1 sync repo: a git repo with allowlisted files at the root level
 * (no .sync-version file, no subdirectories).
 */
async function setupV1SyncRepo(baseDir: string) {
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

	return { bareDir, syncRepoDir };
}

/**
 * Sets up a v2 sync repo (already migrated).
 */
async function setupV2SyncRepo(baseDir: string) {
	const result = await setupV1SyncRepo(baseDir);
	const { syncRepoDir } = result;

	// Write v2 marker
	await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2\n");
	await addFiles(syncRepoDir, [".sync-version"]);
	await commitFiles(syncRepoDir, "mark v2");
	await simpleGit(syncRepoDir).push("origin", "main");

	return result;
}

describe("migrate command (integration)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cmd-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	describe("detectRepoVersion", () => {
		it("returns 1 for a repo with no .sync-version file", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);
			const version = await detectRepoVersion(syncRepoDir);
			expect(version).toBe(1);
		});

		it("returns 2 for a repo with .sync-version containing 2", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
			const version = await detectRepoVersion(syncRepoDir);
			expect(version).toBe(2);
		});

		it("returns 1 for a repo with .sync-version containing other content", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);
			await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "99\n");
			const version = await detectRepoVersion(syncRepoDir);
			expect(version).toBe(1);
		});
	});

	describe("migrateToV2", () => {
		it("migrates a v1 repo with allowlisted files to v2 structure", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);

			// Add allowlisted files at the root (v1 format)
			await fs.writeFile(path.join(syncRepoDir, "CLAUDE.md"), "# Config");
			await fs.writeFile(
				path.join(syncRepoDir, "settings.json"),
				JSON.stringify({ key: "value" }),
			);
			await addFiles(syncRepoDir, ["CLAUDE.md", "settings.json"]);
			await commitFiles(syncRepoDir, "add config files");
			await simpleGit(syncRepoDir).push("origin", "main");

			// Migrate
			const result = await migrateToV2(syncRepoDir);

			expect(result.movedFiles.length).toBeGreaterThan(0);
			expect(result.message).toContain("Migrated");

			// Verify files were moved to claude/ subdirectory
			const claudeMd = await fs.readFile(
				path.join(syncRepoDir, "claude", "CLAUDE.md"),
				"utf-8",
			);
			expect(claudeMd).toBe("# Config");

			const settings = await fs.readFile(
				path.join(syncRepoDir, "claude", "settings.json"),
				"utf-8",
			);
			expect(settings).toContain("value");

			// Verify .sync-version was created
			const version = await detectRepoVersion(syncRepoDir);
			expect(version).toBe(2);
		});

		it("returns no-op for a repo already at v2", async () => {
			const { syncRepoDir } = await setupV2SyncRepo(tmpDir);

			const result = await migrateToV2(syncRepoDir);

			expect(result.movedFiles).toHaveLength(0);
			expect(result.message).toContain("Already at v2");
		});

		it("throws when repo has uncommitted changes", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);

			// Create an uncommitted file (not allowlisted but staged)
			await fs.writeFile(path.join(syncRepoDir, "CLAUDE.md"), "# Dirty");
			await addFiles(syncRepoDir, ["CLAUDE.md"]);

			await expect(migrateToV2(syncRepoDir)).rejects.toThrow(/uncommitted changes/i);
		});

		it("handles repo with directory targets during migration", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);

			// Add a directory target at root (v1 format)
			await fs.mkdir(path.join(syncRepoDir, "commands"), { recursive: true });
			await fs.writeFile(path.join(syncRepoDir, "commands", "test.md"), "test cmd");
			await addFiles(syncRepoDir, ["commands/test.md"]);
			await commitFiles(syncRepoDir, "add commands");
			await simpleGit(syncRepoDir).push("origin", "main");

			const result = await migrateToV2(syncRepoDir);

			expect(result.movedFiles).toContain("commands/test.md");

			// Verify moved
			const content = await fs.readFile(
				path.join(syncRepoDir, "claude", "commands", "test.md"),
				"utf-8",
			);
			expect(content).toBe("test cmd");
		});

		it("commits the migration and pushes to remote", async () => {
			const { syncRepoDir } = await setupV1SyncRepo(tmpDir);

			await fs.writeFile(path.join(syncRepoDir, "CLAUDE.md"), "# Config");
			await addFiles(syncRepoDir, ["CLAUDE.md"]);
			await commitFiles(syncRepoDir, "add file");
			await simpleGit(syncRepoDir).push("origin", "main");

			await migrateToV2(syncRepoDir);

			// Verify the repo is clean after migration
			const git = simpleGit(syncRepoDir);
			const status = await git.status();
			expect(status.isClean()).toBe(true);

			// Verify migration commit exists
			const log = await git.log({ maxCount: 1 });
			expect(log.latest?.message).toContain("migrate to v2");
		});
	});
});

describe("migrate CLI action (integration)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-test-"));
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
		registerMigrateCommand(program);
		return program;
	}

	it("prints already-at-v2 message for v2 repo", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const program = createProgram();

		await program.parseAsync(["node", "test", "migrate", "--repo-path", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("already at v2");
	});

	it("prints success message after migrating v1 repo", async () => {
		const { syncRepoDir } = await setupV1SyncRepo(tmpDir);

		await fs.writeFile(path.join(syncRepoDir, "CLAUDE.md"), "# Config");
		await addFiles(syncRepoDir, ["CLAUDE.md"]);
		await commitFiles(syncRepoDir, "add file");
		await simpleGit(syncRepoDir).push("origin", "main");

		const program = createProgram();
		await program.parseAsync(["node", "test", "migrate", "--repo-path", syncRepoDir]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Migrat");
	});

	it("sets exitCode on migration error", async () => {
		const program = createProgram();

		await program.parseAsync(["node", "test", "migrate", "--repo-path", "/nonexistent/path"]);

		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Migration failed");
		expect(process.exitCode).toBe(1);
	});
});
