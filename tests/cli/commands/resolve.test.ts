import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleResolveAccept,
	handleResolveDiff,
	handleResolveList,
	handleResolveReject,
} from "../../../src/cli/commands/resolve.js";
import { stage } from "../../../src/core/merge/staging.js";

let baseDir: string;
let syncRepoDir: string;
let homeDir: string;
let claudeDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let originalHome: string | undefined;

beforeEach(async () => {
	baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-resolve-test-"));
	syncRepoDir = path.join(baseDir, "sync-repo");
	homeDir = path.join(baseDir, "home");
	claudeDir = path.join(homeDir, ".claude");
	await fs.mkdir(syncRepoDir, { recursive: true });
	await fs.mkdir(claudeDir, { recursive: true });
	originalHome = process.env.HOME;
	process.env.HOME = homeDir;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = 0;
});

afterEach(async () => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	await fs.rm(baseDir, { recursive: true, force: true });
	process.exitCode = 0;
});

function logged(): string {
	return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}
function erred(): string {
	return errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("handleResolveList", () => {
	it("prints 'No staged merges.' when manifest is empty", async () => {
		await handleResolveList({ repoPath: syncRepoDir });
		expect(logged()).toMatch(/No staged merges/);
	});

	it("renders a row for each manifest entry", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged a",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "agents/foo.md",
			mergedContent: "merged b",
			resolver: "claude",
		});
		await handleResolveList({ repoPath: syncRepoDir });
		const out = logged();
		expect(out).toContain("CLAUDE.md");
		expect(out).toContain("agents/foo.md");
		expect(out).toContain("claude");
	});
});

describe("handleResolveDiff", () => {
	it("prints a diff between live file and staged content", async () => {
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "alpha\nshared\n", "utf-8");
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "beta\nshared\n",
			resolver: "claude",
		});
		await handleResolveDiff("CLAUDE.md", { repoPath: syncRepoDir });
		const out = logged();
		expect(out).toContain("-alpha");
		expect(out).toContain("+beta");
		expect(out).toContain(" shared");
	});

	it("defaults to the sole entry when relpath is omitted", async () => {
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "old", "utf-8");
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "new",
			resolver: "claude",
		});
		await handleResolveDiff(undefined, { repoPath: syncRepoDir });
		expect(logged()).toContain("CLAUDE.md");
		expect(process.exitCode).toBe(0);
	});

	it("errors with exit code 1 when relpath is ambiguous", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "b.md",
			mergedContent: "B",
			resolver: "claude",
		});
		await handleResolveDiff(undefined, { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
		expect(erred()).toMatch(/multiple staged merges/i);
	});

	it("errors with exit code 1 when relpath is unknown", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await handleResolveDiff("nope.md", { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
		expect(erred()).toMatch(/no staged merge for/i);
	});
});

describe("handleResolveAccept", () => {
	it("copies staged file into live target and removes manifest entry", async () => {
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "old", "utf-8");
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged!",
			resolver: "claude",
		});
		await handleResolveAccept("CLAUDE.md", { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(0);
		const live = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
		expect(live).toBe("merged!");
		const manifestRaw = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "manifest.json"),
			"utf-8",
		);
		expect(JSON.parse(manifestRaw).entries).toHaveLength(0);
		const staged = path.join(syncRepoDir, ".ai-sync", "pending", "claude", "CLAUDE.md");
		await expect(fs.access(staged)).rejects.toThrow();
	});

	it("creates target subdir when relpath includes a directory", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "agents/foo.md",
			mergedContent: "agent merged",
			resolver: "claude",
		});
		await handleResolveAccept("agents/foo.md", { repoPath: syncRepoDir });
		const live = await fs.readFile(path.join(claudeDir, "agents", "foo.md"), "utf-8");
		expect(live).toBe("agent merged");
	});

	it("--all accepts every staged entry", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "b.md",
			mergedContent: "B",
			resolver: "claude",
		});
		await handleResolveAccept(undefined, { repoPath: syncRepoDir, all: true });
		expect(await fs.readFile(path.join(claudeDir, "a.md"), "utf-8")).toBe("A");
		expect(await fs.readFile(path.join(claudeDir, "b.md"), "utf-8")).toBe("B");
		const manifestRaw = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "manifest.json"),
			"utf-8",
		);
		expect(JSON.parse(manifestRaw).entries).toHaveLength(0);
	});

	it("errors with exit code 1 when relpath is missing", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await handleResolveAccept(undefined, { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
		expect(erred()).toMatch(/required/i);
	});

	it("errors with exit code 1 for unknown relpath", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await handleResolveAccept("nope.md", { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
	});

	it("prints empty message when manifest has no entries", async () => {
		await handleResolveAccept("anything", { repoPath: syncRepoDir });
		expect(logged()).toMatch(/No staged merges/);
	});
});

describe("handleResolveReject", () => {
	it("deletes staged file and removes manifest entry; live file untouched", async () => {
		await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "untouched", "utf-8");
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "rejected merge",
			resolver: "claude",
		});
		await handleResolveReject("CLAUDE.md", { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(0);
		const live = await fs.readFile(path.join(claudeDir, "CLAUDE.md"), "utf-8");
		expect(live).toBe("untouched");
		const staged = path.join(syncRepoDir, ".ai-sync", "pending", "claude", "CLAUDE.md");
		await expect(fs.access(staged)).rejects.toThrow();
		const manifestRaw = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "manifest.json"),
			"utf-8",
		);
		expect(JSON.parse(manifestRaw).entries).toHaveLength(0);
	});

	it("--all rejects every staged entry", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "b.md",
			mergedContent: "B",
			resolver: "claude",
		});
		await handleResolveReject(undefined, { repoPath: syncRepoDir, all: true });
		const manifestRaw = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "manifest.json"),
			"utf-8",
		);
		expect(JSON.parse(manifestRaw).entries).toHaveLength(0);
	});

	it("errors with exit code 1 when relpath is missing", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await handleResolveReject(undefined, { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
	});

	it("errors for unknown relpath", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await handleResolveReject("nope.md", { repoPath: syncRepoDir });
		expect(process.exitCode).toBe(1);
	});
});
