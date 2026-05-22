import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleStatusDrift,
	handleStatusSummarize,
	printDriftReport,
	printSummarizeResults,
} from "../../../src/cli/commands/status.js";
import type { DriftReport } from "../../../src/core/drift.js";
import type { Environment } from "../../../src/core/environment.js";
import { stage } from "../../../src/core/merge/staging.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../../src/git/repo.js";

function mockEnv(id: string, configDir: string): Environment {
	return {
		id,
		displayName: id,
		getConfigDir: () => configDir,
		getSyncTargets: () => ["CLAUDE.md", "settings.json", "agents/", "commands/"],
		getPluginSyncPatterns: () => [],
		getIgnorePatterns: () => [],
		getPathRewriteTargets: () => ["settings.json"],
		getSkillsSubdir: () => "commands",
	};
}

interface Fixture {
	baseDir: string;
	bareDir: string;
	syncRepoDir: string;
	homeDir: string;
	claudeConfigDir: string;
	opencodeConfigDir: string;
	claudeEnv: Environment;
	opencodeEnv: Environment;
}

async function makeFixture(): Promise<Fixture> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-status-cli-"));
	const bareDir = path.join(baseDir, "bare.git");
	const syncRepoDir = path.join(baseDir, "sync-repo");
	const homeDir = path.join(baseDir, "home");
	const claudeConfigDir = path.join(homeDir, ".claude");
	const opencodeConfigDir = path.join(homeDir, ".config", "opencode");

	await fs.mkdir(bareDir, { recursive: true });
	await simpleGit(bareDir).init(true);

	await fs.mkdir(syncRepoDir, { recursive: true });
	await initRepo(syncRepoDir);
	await simpleGit(syncRepoDir).addConfig("user.email", "test@test.com");
	await simpleGit(syncRepoDir).addConfig("user.name", "Test");
	await addRemote(syncRepoDir, "origin", bareDir);
	await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2");
	await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");

	await fs.mkdir(path.join(syncRepoDir, "claude", "commands"), { recursive: true });
	await fs.writeFile(path.join(syncRepoDir, "claude", "CLAUDE.md"), "base claude\n");
	await fs.writeFile(path.join(syncRepoDir, "claude", "commands", "foo.md"), "foo\n");
	await fs.mkdir(path.join(syncRepoDir, "opencode"), { recursive: true });
	await fs.writeFile(path.join(syncRepoDir, "opencode", "settings.json"), '{"theme":"base"}');

	await addFiles(syncRepoDir, [
		".gitkeep",
		".sync-version",
		"claude/CLAUDE.md",
		"claude/commands/foo.md",
		"opencode/settings.json",
	]);
	await commitFiles(syncRepoDir, "initial");
	await simpleGit(syncRepoDir).push("origin", "main");
	await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

	await fs.mkdir(path.join(claudeConfigDir, "commands"), { recursive: true });
	await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "base claude\n");
	await fs.writeFile(path.join(claudeConfigDir, "commands", "foo.md"), "foo\n");
	await fs.mkdir(opencodeConfigDir, { recursive: true });
	await fs.writeFile(path.join(opencodeConfigDir, "settings.json"), '{"theme":"base"}');

	return {
		baseDir,
		bareDir,
		syncRepoDir,
		homeDir,
		claudeConfigDir,
		opencodeConfigDir,
		claudeEnv: mockEnv("claude", claudeConfigDir),
		opencodeEnv: mockEnv("opencode", opencodeConfigDir),
	};
}

async function pushRemote(fx: Fixture, relPath: string, content: string): Promise<void> {
	const cloneDir = path.join(fx.baseDir, `clone-${Math.random().toString(36).slice(2, 8)}`);
	await simpleGit().clone(fx.bareDir, cloneDir);
	await simpleGit(cloneDir).addConfig("user.email", "r@t.com");
	await simpleGit(cloneDir).addConfig("user.name", "R");
	const t = path.join(cloneDir, relPath);
	await fs.mkdir(path.dirname(t), { recursive: true });
	await fs.writeFile(t, content);
	await addFiles(cloneDir, [relPath]);
	await commitFiles(cloneDir, "remote");
	await simpleGit(cloneDir).push("origin", "main");
}

let fx: Fixture;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	fx = await makeFixture();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
	logSpy.mockRestore();
	await fs.rm(fx.baseDir, { recursive: true, force: true });
});

function logged(): string {
	return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("handleStatusDrift", () => {
	it("reports all zero counts in a clean state", async () => {
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv, fx.opencodeEnv],
		});
		expect(reports).toHaveLength(2);
		for (const r of reports) {
			expect(r.localOnly).toEqual([]);
			expect(r.remoteOnly).toEqual([]);
			expect(r.bothChanged).toEqual([]);
			expect(r.stagedPending).toEqual([]);
		}
	});

	it("identifies a local-only change", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "CLAUDE.md"), "local!\n");
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv],
		});
		expect(reports[0].localOnly).toEqual(["CLAUDE.md"]);
	});

	it("identifies a remote-only change after fetch", async () => {
		await pushRemote(fx, "claude/CLAUDE.md", "remote!\n");
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv],
		});
		expect(reports[0].remoteOnly).toEqual(["CLAUDE.md"]);
	});

	it("identifies a both-changed conflict", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "CLAUDE.md"), "local!\n");
		await pushRemote(fx, "claude/CLAUDE.md", "remote!\n");
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv],
		});
		expect(reports[0].bothChanged).toEqual(["CLAUDE.md"]);
	});

	it("counts staged-pending merges per env", async () => {
		await stage(fx.syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged",
			resolver: "stub",
		});
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv, fx.opencodeEnv],
		});
		const claude = reports.find((r) => r.envName === "claude");
		const open = reports.find((r) => r.envName === "opencode");
		expect(claude?.stagedPending).toEqual(["CLAUDE.md"]);
		expect(open?.stagedPending).toEqual([]);
	});

	it("filters with --env option", async () => {
		const reports = await handleStatusDrift({
			repoPath: fx.syncRepoDir,
			homeDir: fx.homeDir,
			environments: [fx.claudeEnv, fx.opencodeEnv],
			env: "opencode",
		});
		expect(reports.map((r) => r.envName)).toEqual(["opencode"]);
	});
});

describe("printDriftReport", () => {
	it("prints per-env counts on a single line", () => {
		printDriftReport(
			[
				{
					envName: "claude",
					localOnly: ["a.md"],
					remoteOnly: [],
					bothChanged: [],
					stagedPending: [],
				},
			],
			false,
		);
		const out = logged();
		expect(out).toContain("claude");
		expect(out).toContain("local-only=1");
		expect(out).toContain("remote-only=0");
		expect(out).toContain("both-changed=0");
		expect(out).toContain("staged-pending=0");
		// Filenames should NOT appear without --verbose
		expect(out).not.toContain("a.md");
	});

	it("lists filenames under each bucket when verbose", () => {
		printDriftReport(
			[
				{
					envName: "claude",
					localOnly: ["a.md"],
					remoteOnly: ["b.md"],
					bothChanged: ["c.md"],
					stagedPending: ["d.md"],
				},
			],
			true,
		);
		const out = logged();
		expect(out).toContain("a.md");
		expect(out).toContain("b.md");
		expect(out).toContain("c.md");
		expect(out).toContain("d.md");
		expect(out).toMatch(/local-only:/);
		expect(out).toMatch(/remote-only:/);
		expect(out).toMatch(/both-changed:/);
		expect(out).toMatch(/staged-pending:/);
	});

	it("prints one header line per environment", () => {
		printDriftReport(
			[
				{
					envName: "claude",
					localOnly: [],
					remoteOnly: [],
					bothChanged: [],
					stagedPending: [],
				},
				{
					envName: "opencode",
					localOnly: [],
					remoteOnly: [],
					bothChanged: [],
					stagedPending: [],
				},
			],
			false,
		);
		const out = logged();
		expect(out).toMatch(/Env claude:/);
		expect(out).toMatch(/Env opencode:/);
	});

	it("prints a dim placeholder when no envs are passed", () => {
		printDriftReport([], false);
		expect(logged()).toMatch(/No environments enabled/);
	});
});

function makeReport(envName: string, overrides: Partial<DriftReport> = {}): DriftReport {
	return {
		envName,
		localOnly: [],
		remoteOnly: [],
		bothChanged: [],
		stagedPending: [],
		...overrides,
	};
}

describe("handleStatusSummarize", () => {
	it("does NOT invoke the resolver when every env is clean", async () => {
		const available = vi.fn().mockResolvedValue(true);
		const summarize = vi.fn().mockResolvedValue("never called");
		const results = await handleStatusSummarize(
			[makeReport("claude"), makeReport("opencode")],
			"claude",
			{ availableFn: available, summarizeFn: summarize },
		);
		expect(summarize).not.toHaveBeenCalled();
		expect(results.every((r) => r.status === "skipped-no-drift")).toBe(true);
	});

	it("invokes the resolver exactly once per env-with-drift and returns summaries", async () => {
		const available = vi.fn().mockResolvedValue(true);
		const summarize = vi
			.fn()
			.mockImplementation(async (_name: string, prompt: string) =>
				prompt.includes("claude") ? "claude moved CLAUDE.md" : "opencode tweaked theme",
			);
		const reports = [
			makeReport("claude", { localOnly: ["CLAUDE.md"] }),
			makeReport("opencode", { remoteOnly: ["settings.json"] }),
		];
		const results = await handleStatusSummarize(reports, "claude", {
			availableFn: available,
			summarizeFn: summarize,
		});
		expect(summarize).toHaveBeenCalledTimes(2);
		expect(results.find((r) => r.envName === "claude")?.status).toBe("ok");
		expect(results.find((r) => r.envName === "claude")?.summary).toMatch(/claude moved/);
		expect(results.find((r) => r.envName === "opencode")?.summary).toMatch(/opencode tweaked/);
	});

	it("does not call the resolver per-file — a single env-with-drift yields one call", async () => {
		const available = vi.fn().mockResolvedValue(true);
		const summarize = vi.fn().mockResolvedValue("ok");
		await handleStatusSummarize(
			[
				makeReport("claude", {
					localOnly: ["a.md", "b.md", "c.md"],
					remoteOnly: ["d.md"],
					bothChanged: ["e.md"],
				}),
			],
			"claude",
			{ availableFn: available, summarizeFn: summarize },
		);
		expect(summarize).toHaveBeenCalledTimes(1);
	});

	it("marks env as unavailable when adapter.available() returns false and never invokes resolver", async () => {
		const available = vi.fn().mockResolvedValue(false);
		const summarize = vi.fn().mockResolvedValue("never");
		const results = await handleStatusSummarize(
			[makeReport("claude", { localOnly: ["CLAUDE.md"] })],
			"claude",
			{ availableFn: available, summarizeFn: summarize },
		);
		expect(summarize).not.toHaveBeenCalled();
		expect(results[0].status).toBe("unavailable");
	});

	it("captures resolver errors per-env without aborting the report", async () => {
		const available = vi.fn().mockResolvedValue(true);
		const summarize = vi
			.fn()
			.mockImplementationOnce(async () => {
				throw new Error("boom");
			})
			.mockImplementationOnce(async () => "fine");
		const results = await handleStatusSummarize(
			[
				makeReport("claude", { localOnly: ["a.md"] }),
				makeReport("opencode", { localOnly: ["b.md"] }),
			],
			"claude",
			{ availableFn: available, summarizeFn: summarize },
		);
		expect(results[0].status).toBe("error");
		expect(results[0].error).toMatch(/boom/);
		expect(results[1].status).toBe("ok");
		expect(results[1].summary).toBe("fine");
	});

	it("treats availableFn rejection as unavailable", async () => {
		const available = vi.fn().mockRejectedValue(new Error("probe failed"));
		const summarize = vi.fn().mockResolvedValue("never");
		const results = await handleStatusSummarize(
			[makeReport("claude", { localOnly: ["a.md"] })],
			"claude",
			{ availableFn: available, summarizeFn: summarize },
		);
		expect(summarize).not.toHaveBeenCalled();
		expect(results[0].status).toBe("unavailable");
	});
});

describe("printSummarizeResults", () => {
	it("prints the summary text under the env header for ok results", () => {
		printSummarizeResults(
			[{ envName: "claude", status: "ok", summary: "two-line\nsummary" }],
			"claude",
		);
		const out = logged();
		expect(out).toMatch(/Summary \(via claude\):/);
		expect(out).toContain("two-line");
		expect(out).toContain("summary");
	});

	it("prints a yellow warning when the resolver is unavailable", () => {
		printSummarizeResults([{ envName: "claude", status: "unavailable" }], "claude");
		expect(logged()).toMatch(/not available/);
	});

	it("prints a per-env warning on error", () => {
		printSummarizeResults([{ envName: "claude", status: "error", error: "boom" }], "claude");
		const out = logged();
		expect(out).toMatch(/Summary skipped for claude/);
		expect(out).toContain("boom");
	});

	it("emits nothing for skipped-no-drift entries", () => {
		printSummarizeResults([{ envName: "claude", status: "skipped-no-drift" }], "claude");
		expect(logSpy.mock.calls.length).toBe(0);
	});
});
