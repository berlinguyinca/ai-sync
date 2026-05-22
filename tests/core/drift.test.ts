import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDrift, classifyDriftForEnv } from "../../src/core/drift.js";
import type { Environment } from "../../src/core/environment.js";
import { stage } from "../../src/core/merge/staging.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

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

interface V2Fixture {
	baseDir: string;
	bareDir: string;
	syncRepoDir: string;
	homeDir: string;
	claudeConfigDir: string;
	claudeEnv: Environment;
	opencodeEnv: Environment;
	opencodeConfigDir: string;
}

async function makeV2Fixture(): Promise<V2Fixture> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-drift-"));
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

	// Seed claude env with a CLAUDE.md and a commands/foo.md committed at HEAD
	await fs.mkdir(path.join(syncRepoDir, "claude", "commands"), { recursive: true });
	await fs.writeFile(path.join(syncRepoDir, "claude", "CLAUDE.md"), "base claude\n");
	await fs.writeFile(path.join(syncRepoDir, "claude", "commands", "foo.md"), "base foo\n");

	// Seed opencode env with a settings.json
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

	// Mirror committed content into local config dirs so the baseline is clean.
	await fs.mkdir(path.join(claudeConfigDir, "commands"), { recursive: true });
	await fs.writeFile(path.join(claudeConfigDir, "CLAUDE.md"), "base claude\n");
	await fs.writeFile(path.join(claudeConfigDir, "commands", "foo.md"), "base foo\n");
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

/**
 * Simulates a remote-side change by committing into a clone and pushing,
 * then fetching back into syncRepoDir (without merging).
 */
async function pushRemoteChange(
	fx: V2Fixture,
	relPathInRepo: string,
	newContent: string,
): Promise<void> {
	const cloneDir = path.join(
		fx.baseDir,
		`clone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	await simpleGit().clone(fx.bareDir, cloneDir);
	await simpleGit(cloneDir).addConfig("user.email", "remote@test.com");
	await simpleGit(cloneDir).addConfig("user.name", "Remote");
	const target = path.join(cloneDir, relPathInRepo);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, newContent);
	await addFiles(cloneDir, [relPathInRepo]);
	await commitFiles(cloneDir, `remote: change ${relPathInRepo}`);
	await simpleGit(cloneDir).push("origin", "main");
	await simpleGit(fx.syncRepoDir).fetch("origin");
}

let fx: V2Fixture;

beforeEach(async () => {
	fx = await makeV2Fixture();
});

afterEach(async () => {
	await fs.rm(fx.baseDir, { recursive: true, force: true });
});

describe("classifyDriftForEnv", () => {
	it("reports zero drift when local and remote match HEAD", async () => {
		const report = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(report.localOnly).toEqual([]);
		expect(report.remoteOnly).toEqual([]);
		expect(report.bothChanged).toEqual([]);
		expect(report.stagedPending).toEqual([]);
	});

	it("counts a local-only modification", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "CLAUDE.md"), "local change\n");
		const report = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(report.localOnly).toEqual(["CLAUDE.md"]);
		expect(report.remoteOnly).toEqual([]);
		expect(report.bothChanged).toEqual([]);
	});

	it("counts a local-only addition", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "commands", "new.md"), "fresh");
		const report = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(report.localOnly).toEqual(["commands/new.md"]);
	});

	it("counts a remote-only modification", async () => {
		await pushRemoteChange(fx, "claude/CLAUDE.md", "remote change\n");
		const report = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(report.remoteOnly).toEqual(["CLAUDE.md"]);
		expect(report.localOnly).toEqual([]);
		expect(report.bothChanged).toEqual([]);
	});

	it("counts a both-changed conflict", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "CLAUDE.md"), "local change\n");
		await pushRemoteChange(fx, "claude/CLAUDE.md", "remote change\n");
		const report = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(report.bothChanged).toEqual(["CLAUDE.md"]);
		expect(report.localOnly).toEqual([]);
		expect(report.remoteOnly).toEqual([]);
	});

	it("counts staged-pending entries scoped to env", async () => {
		await stage(fx.syncRepoDir, {
			envName: "claude",
			relativePath: "CLAUDE.md",
			mergedContent: "merged",
			resolver: "stub",
		});
		await stage(fx.syncRepoDir, {
			envName: "opencode",
			relativePath: "settings.json",
			mergedContent: "merged2",
			resolver: "stub",
		});
		const claudeReport = await classifyDriftForEnv(fx.claudeEnv, fx.syncRepoDir, fx.homeDir);
		expect(claudeReport.stagedPending).toEqual(["CLAUDE.md"]);
		const openReport = await classifyDriftForEnv(fx.opencodeEnv, fx.syncRepoDir, fx.homeDir);
		expect(openReport.stagedPending).toEqual(["settings.json"]);
	});
});

describe("classifyDrift (multi-env)", () => {
	it("returns one report per environment", async () => {
		await fs.writeFile(path.join(fx.claudeConfigDir, "CLAUDE.md"), "local!\n");
		await pushRemoteChange(fx, "opencode/settings.json", '{"theme":"remote"}');
		const reports = await classifyDrift([fx.claudeEnv, fx.opencodeEnv], fx.syncRepoDir, fx.homeDir);
		expect(reports.map((r) => r.envName)).toEqual(["claude", "opencode"]);
		const claude = reports.find((r) => r.envName === "claude");
		const opencode = reports.find((r) => r.envName === "opencode");
		expect(claude?.localOnly).toEqual(["CLAUDE.md"]);
		expect(opencode?.remoteOnly).toEqual(["settings.json"]);
	});
});
