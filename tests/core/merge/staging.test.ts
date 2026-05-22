import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitignoreEntry, listStaged, stage } from "../../../src/core/merge/staging.js";

let syncRepoDir: string;

beforeEach(async () => {
	syncRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-staging-test-"));
});

afterEach(async () => {
	await fs.rm(syncRepoDir, { recursive: true, force: true });
});

describe("stage()", () => {
	it("writes merged content under .ai-sync/pending/<env>/<rel>", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged body",
			resolver: "claude",
		});
		const out = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(out).toBe("merged body");
	});

	it("creates nested directories for relative paths with subdirs", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "agents/foo.md",
			mergedContent: "agent body",
			resolver: "claude",
		});
		const out = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "claude", "agents", "foo.md"),
			"utf-8",
		);
		expect(out).toBe("agent body");
	});

	it("writes a manifest entry that round-trips via listStaged()", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged",
			resolver: "claude",
			notes: "rationale here",
		});
		const entries = await listStaged(syncRepoDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			envName: "claude",
			relativePath: "CLAUDE.md",
			resolver: "claude",
			notes: "rationale here",
		});
		expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("is idempotent on (envName, relativePath) — overwrites file and updates entry", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "first",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "second",
			resolver: "claude",
		});
		const entries = await listStaged(syncRepoDir);
		expect(entries).toHaveLength(1);
		const file = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(file).toBe("second");
	});

	it("appends two distinct (env, path) tuples as separate entries", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "a.md",
			mergedContent: "A",
			resolver: "claude",
		});
		await stage(syncRepoDir, {
			envName: "opencode",
			relativePath: "a.md",
			mergedContent: "B",
			resolver: "claude",
		});
		const entries = await listStaged(syncRepoDir);
		expect(entries).toHaveLength(2);
	});

	it("listStaged returns [] when manifest is absent", async () => {
		const entries = await listStaged(syncRepoDir);
		expect(entries).toEqual([]);
	});
});

describe("ensureGitignoreEntry()", () => {
	it("creates .gitignore if absent", async () => {
		await ensureGitignoreEntry(syncRepoDir);
		const contents = await fs.readFile(path.join(syncRepoDir, ".gitignore"), "utf-8");
		expect(contents).toContain(".ai-sync/pending/");
	});

	it("appends without duplicate when .gitignore exists", async () => {
		await fs.writeFile(path.join(syncRepoDir, ".gitignore"), "node_modules\n", "utf-8");
		await ensureGitignoreEntry(syncRepoDir);
		await ensureGitignoreEntry(syncRepoDir);
		const contents = await fs.readFile(path.join(syncRepoDir, ".gitignore"), "utf-8");
		const matches = contents.match(/\.ai-sync\/pending/g);
		expect(matches).toHaveLength(1);
		expect(contents).toContain("node_modules");
	});

	it("treats `.ai-sync/pending` (no trailing slash) as already present", async () => {
		await fs.writeFile(path.join(syncRepoDir, ".gitignore"), ".ai-sync/pending\n", "utf-8");
		await ensureGitignoreEntry(syncRepoDir);
		const contents = await fs.readFile(path.join(syncRepoDir, ".gitignore"), "utf-8");
		const matches = contents.match(/\.ai-sync\/pending/g);
		expect(matches).toHaveLength(1);
	});

	it("is invoked by stage() (one call ensures the gitignore)", async () => {
		await stage(syncRepoDir, {
			envName: "claude",
			relativePath: "x.md",
			mergedContent: "m",
			resolver: "claude",
		});
		const contents = await fs.readFile(path.join(syncRepoDir, ".gitignore"), "utf-8");
		expect(contents).toContain(".ai-sync/pending/");
	});
});
