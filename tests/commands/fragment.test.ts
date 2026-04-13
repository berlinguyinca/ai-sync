import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleFragmentAdd,
	handleFragmentRemove,
	handleFragmentSplit,
	handleFragmentStatus,
	registerFragmentCommand,
} from "../../src/cli/commands/fragment.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

/**
 * Sets up a minimal v2 sync repo (bare remote + working copy) with .sync-version = "2"
 * and a claude/ subdirectory containing a CLAUDE.md index.
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

/** Creates a fake claudeDir with a CLAUDE.md file containing some sections. */
async function createClaudeDir(baseDir: string, content: string) {
	const claudeDir = path.join(baseDir, "claude-config");
	await fs.mkdir(claudeDir, { recursive: true });
	await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), content);
	return claudeDir;
}

const SAMPLE_CLAUDE_MD = `# Global standards

Preamble content here.

## Stack

TypeScript strict, Node 22+.

## TDD & Testing

TDD non-negotiable.
`;

describe("handleFragmentSplit", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragment-split-test-"));
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

	it("creates fragment files in the sync repo", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = await createClaudeDir(tmpDir, SAMPLE_CLAUDE_MD);

		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });

		// Known sections should be written as fragment files
		const stackFrag = await fs.readFile(
			path.join(syncRepoDir, "shared/standards/stack.md"),
			"utf-8",
		);
		expect(stackFrag).toContain("TypeScript strict");

		const tddFrag = await fs.readFile(
			path.join(syncRepoDir, "shared/standards/tdd.md"),
			"utf-8",
		);
		expect(tddFrag).toContain("TDD non-negotiable");
	});

	it("creates the index file at claude/CLAUDE.md in the sync repo", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = await createClaudeDir(tmpDir, SAMPLE_CLAUDE_MD);

		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });

		const indexContent = await fs.readFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"utf-8",
		);

		// Index must contain @-references
		expect(indexContent).toContain("@shared/standards/stack.md");
		expect(indexContent).toContain("@shared/standards/tdd.md");

		// Index must contain preamble content
		expect(indexContent).toContain("Preamble content here");
	});

	it("replaces CLAUDE.md with a symlink pointing at the sync repo index", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = await createClaudeDir(tmpDir, SAMPLE_CLAUDE_MD);
		const claudeMdPath = path.join(claudeDir, "CLAUDE.md");

		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });

		const stat = await fs.lstat(claudeMdPath);
		expect(stat.isSymbolicLink()).toBe(true);

		const target = await fs.readlink(claudeMdPath);
		expect(target).toBe(path.join(syncRepoDir, "claude", "CLAUDE.md"));
	});

	it("is idempotent — skips when CLAUDE.md is already a symlink", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = await createClaudeDir(tmpDir, SAMPLE_CLAUDE_MD);
		const claudeMdPath = path.join(claudeDir, "CLAUDE.md");

		// First run
		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });
		expect((await fs.lstat(claudeMdPath)).isSymbolicLink()).toBe(true);

		// Second run should be a no-op
		const callsBefore = logSpy.mock.calls.length;
		process.exitCode = undefined;
		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });

		const output = logSpy.mock.calls
			.slice(callsBefore)
			.map((c) => c[0])
			.join("\n");
		expect(output).toContain("already");
		expect(process.exitCode).toBeUndefined();
	});

	it("sets exitCode 1 when CLAUDE.md does not exist", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = path.join(tmpDir, "nonexistent");

		await handleFragmentSplit({ repoPath: syncRepoDir, claudeDir });

		expect(process.exitCode).toBe(1);
		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Could not read");
	});
});

describe("handleFragmentStatus", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragment-status-test-"));
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

	async function setupIndexWithFragments(syncRepoDir: string) {
		await fs.mkdir(path.join(syncRepoDir, "claude"), { recursive: true });
		await fs.mkdir(path.join(syncRepoDir, "shared/standards"), { recursive: true });

		await fs.writeFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"# Index\n\n@shared/standards/stack.md\n@shared/standards/tdd.md\n",
		);
		await fs.writeFile(
			path.join(syncRepoDir, "shared/standards/stack.md"),
			"## Stack\n\nTypeScript.\n",
		);
		// tdd.md intentionally missing to test missing status
	}

	it("shows ok status for existing references", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await setupIndexWithFragments(syncRepoDir);

		await handleFragmentStatus({ repoPath: syncRepoDir });

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("shared/standards/stack.md");
	});

	it("shows missing status for references that do not exist", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await setupIndexWithFragments(syncRepoDir);

		await handleFragmentStatus({ repoPath: syncRepoDir });

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("shared/standards/tdd.md");
	});

	it("reports conflict markers when present", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await setupIndexWithFragments(syncRepoDir);

		// Add a conflict marker to stack.md
		await fs.writeFile(
			path.join(syncRepoDir, "shared/standards/stack.md"),
			"<<<<<<< HEAD\n## Stack\nTypeScript.\n=======\n## Stack\nJavaScript.\n>>>>>>> branch\n",
		);

		await handleFragmentStatus({ repoPath: syncRepoDir });

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("conflict");
	});

	it("sets exitCode 1 when the index file does not exist", async () => {
		const syncRepoDir = path.join(tmpDir, "no-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });

		await handleFragmentStatus({ repoPath: syncRepoDir });

		expect(process.exitCode).toBe(1);
		const errOutput = errorSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(errOutput).toContain("Could not read index");
	});
});

describe("handleFragmentAdd", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragment-add-test-"));
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

	async function createIndex(syncRepoDir: string, content: string) {
		await fs.mkdir(path.join(syncRepoDir, "claude"), { recursive: true });
		await fs.writeFile(path.join(syncRepoDir, "claude", "CLAUDE.md"), content);
	}

	it("adds a new @-reference to the index", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(syncRepoDir, "# Index\n\n@shared/standards/stack.md\n");

		await handleFragmentAdd("shared/standards/tdd.md", { repoPath: syncRepoDir });

		const result = await fs.readFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(result).toContain("@shared/standards/stack.md");
		expect(result).toContain("@shared/standards/tdd.md");

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Added");
	});

	it("accepts reference with a leading @ sign", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(syncRepoDir, "# Index\n\n@shared/standards/stack.md\n");

		await handleFragmentAdd("@shared/standards/new.md", { repoPath: syncRepoDir });

		const result = await fs.readFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(result).toContain("@shared/standards/new.md");
	});

	it("is idempotent — skips duplicates", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(syncRepoDir, "# Index\n\n@shared/standards/stack.md\n");

		await handleFragmentAdd("shared/standards/stack.md", { repoPath: syncRepoDir });

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("already");
	});

	it("sets exitCode 1 when the index file does not exist", async () => {
		const syncRepoDir = path.join(tmpDir, "no-index");
		await fs.mkdir(syncRepoDir, { recursive: true });

		await handleFragmentAdd("shared/standards/tdd.md", { repoPath: syncRepoDir });

		expect(process.exitCode).toBe(1);
	});
});

describe("handleFragmentRemove", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragment-remove-test-"));
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

	async function createIndex(syncRepoDir: string, content: string) {
		await fs.mkdir(path.join(syncRepoDir, "claude"), { recursive: true });
		await fs.writeFile(path.join(syncRepoDir, "claude", "CLAUDE.md"), content);
	}

	it("removes an existing @-reference from the index", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(
			syncRepoDir,
			"# Index\n\n@shared/standards/stack.md\n@shared/standards/tdd.md\n",
		);

		await handleFragmentRemove("shared/standards/tdd.md", { repoPath: syncRepoDir });

		const result = await fs.readFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(result).toContain("@shared/standards/stack.md");
		expect(result).not.toContain("@shared/standards/tdd.md");

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Removed");
	});

	it("accepts reference with a leading @ sign", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(
			syncRepoDir,
			"# Index\n\n@shared/standards/stack.md\n@shared/standards/tdd.md\n",
		);

		await handleFragmentRemove("@shared/standards/tdd.md", { repoPath: syncRepoDir });

		const result = await fs.readFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(result).not.toContain("@shared/standards/tdd.md");
	});

	it("warns when reference is not present in the index", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(syncRepoDir, { recursive: true });
		await createIndex(syncRepoDir, "# Index\n\n@shared/standards/stack.md\n");

		await handleFragmentRemove("shared/standards/nonexistent.md", { repoPath: syncRepoDir });

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("was not found");
	});

	it("sets exitCode 1 when the index file does not exist", async () => {
		const syncRepoDir = path.join(tmpDir, "no-index");
		await fs.mkdir(syncRepoDir, { recursive: true });

		await handleFragmentRemove("shared/standards/tdd.md", { repoPath: syncRepoDir });

		expect(process.exitCode).toBe(1);
	});
});

describe("registerFragmentCommand (CLI)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragment-cli-test-"));
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
		registerFragmentCommand(program);
		return program;
	}

	it("fragment split command is registered and reachable", async () => {
		const { syncRepoDir } = await setupV2SyncRepo(tmpDir);
		const claudeDir = path.join(tmpDir, "claude-config");
		await fs.mkdir(claudeDir, { recursive: true });
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), SAMPLE_CLAUDE_MD);

		const program = createProgram();
		await program.parseAsync([
			"node",
			"test",
			"fragment",
			"split",
			"--repo-path",
			syncRepoDir,
			"--claude-dir",
			claudeDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("Split complete");
	});

	it("fragment status command is registered and reachable", async () => {
		const syncRepoDir = path.join(tmpDir, "sync-repo");
		await fs.mkdir(path.join(syncRepoDir, "claude"), { recursive: true });
		await fs.mkdir(path.join(syncRepoDir, "shared/standards"), { recursive: true });
		await fs.writeFile(
			path.join(syncRepoDir, "claude", "CLAUDE.md"),
			"@shared/standards/stack.md\n",
		);
		await fs.writeFile(
			path.join(syncRepoDir, "shared/standards/stack.md"),
			"## Stack\n\nTypeScript.\n",
		);

		const program = createProgram();
		await program.parseAsync([
			"node",
			"test",
			"fragment",
			"status",
			"--repo-path",
			syncRepoDir,
		]);

		const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
		expect(output).toContain("shared/standards/stack.md");
	});
});
