import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDriftForEnv } from "../../src/core/drift.js";
import { makeAllowlistFn, makeDefaultAllowlistFn } from "../../src/core/env-helpers.js";
import { ClaudeEnvironment } from "../../src/core/environment.js";
import { getLinkableTargets, linkEnvironment } from "../../src/core/linker.js";
import { defaultSyncConfig, loadSyncConfig } from "../../src/core/sync-config.js";
import { syncPull, syncPush, syncStatus } from "../../src/core/sync-engine.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

class TestClaudeEnvironment extends ClaudeEnvironment {
	constructor(private readonly dir: string) {
		super();
	}
	override getConfigDir(): string {
		return this.dir;
	}
}

let baseDir: string;

beforeEach(async () => {
	baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-sync-config-"));
});

afterEach(async () => {
	await fs.rm(baseDir, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function writeSyncConfig(repoDir: string, content: string): Promise<void> {
	await write(path.join(repoDir, "tools", "sync-config.json"), content);
}

describe("loadSyncConfig()", () => {
	it("returns plugins=true when the file is absent", async () => {
		expect(await loadSyncConfig(baseDir)).toEqual({ plugins: true, verify: false });
		expect(defaultSyncConfig()).toEqual({ plugins: true, verify: false });
	});

	it("defaults plugins to true for an empty object", async () => {
		await writeSyncConfig(baseDir, "{}");
		expect(await loadSyncConfig(baseDir)).toEqual({ plugins: true, verify: false });
	});

	it("reads plugins=false", async () => {
		await writeSyncConfig(baseDir, '{"plugins": false}');
		expect(await loadSyncConfig(baseDir)).toEqual({ plugins: false, verify: false });
	});

	it("rejects unknown keys naming the key", async () => {
		await writeSyncConfig(baseDir, '{"plugins": false, "plugin": true}');
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(/unknown key\(s\) "plugin"/);
	});

	it("fails on malformed JSON with a fix hint instead of defaulting", async () => {
		await writeSyncConfig(baseDir, '{"plugins": false,');
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(/Invalid JSON.*Fix the file/s);
	});

	it("rejects a non-boolean plugins value", async () => {
		await writeSyncConfig(baseDir, '{"plugins": "no"}');
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(/plugins/);
	});
});

describe("allowlists", () => {
	const env = new ClaudeEnvironment();

	it("keeps plugin patterns by default and drops them when plugins=false", () => {
		expect(makeAllowlistFn(env)("plugins/cache/a.json")).toBe(true);
		expect(makeAllowlistFn(env, { plugins: true })("plugins/cache/a.json")).toBe(true);
		const off = makeAllowlistFn(env, { plugins: false });
		expect(off("plugins/cache/a.json")).toBe(false);
		expect(off("plugins/installed_plugins.json")).toBe(false);
		expect(off("CLAUDE.md")).toBe(true);
	});

	it("applies the same rule to the v1 default allowlist", () => {
		expect(makeDefaultAllowlistFn()("plugins/data/a.json")).toBe(true);
		expect(makeDefaultAllowlistFn({ plugins: false })("plugins/data/a.json")).toBe(false);
		expect(makeDefaultAllowlistFn({ plugins: false })("settings.json")).toBe(true);
	});

	it("drops plugin link targets when plugins=false", () => {
		expect(getLinkableTargets(env)).toContain("plugins/cache/");
		expect(getLinkableTargets(env, { plugins: false })).not.toContain("plugins/cache/");
	});
});

interface Fixture {
	bareDir: string;
	repoDir: string;
	homeDir: string;
	configDir: string;
	env: ClaudeEnvironment;
}

/** Real bare remote + sync repo (v2 or v1) + a claude config dir. */
async function makeFixture(version: 1 | 2): Promise<Fixture> {
	const bareDir = path.join(baseDir, "bare.git");
	const repoDir = path.join(baseDir, "sync-repo");
	const homeDir = path.join(baseDir, "home");
	const configDir = path.join(homeDir, ".claude");
	await fs.mkdir(bareDir, { recursive: true });
	await simpleGit(bareDir).init(true);
	await fs.mkdir(repoDir, { recursive: true });
	await initRepo(repoDir);
	await simpleGit(repoDir).addConfig("user.email", "t@t.com");
	await simpleGit(repoDir).addConfig("user.name", "T");
	await addRemote(repoDir, "origin", bareDir);
	const files = [".gitkeep"];
	await write(path.join(repoDir, ".gitkeep"), "");
	if (version === 2) {
		await write(path.join(repoDir, ".sync-version"), "2");
		files.push(".sync-version");
	}
	await addFiles(repoDir, files);
	await commitFiles(repoDir, "initial");
	await simpleGit(repoDir).push("origin", "main");
	await simpleGit(repoDir).branch(["--set-upstream-to=origin/main", "main"]);
	return { bareDir, repoDir, homeDir, configDir, env: new TestClaudeEnvironment(configDir) };
}

/** Commits files into the remote through a throwaway second clone. */
async function pushFromOtherMachine(
	fx: Fixture,
	changes: { write?: Record<string, string>; remove?: string[] },
): Promise<void> {
	const other = path.join(baseDir, "other-clone");
	await fs.rm(other, { recursive: true, force: true });
	await simpleGit().clone(fx.bareDir, other);
	const git = simpleGit(other);
	await git.addConfig("user.email", "o@o.com");
	await git.addConfig("user.name", "O");
	for (const [rel, content] of Object.entries(changes.write ?? {})) {
		await write(path.join(other, rel), content);
	}
	for (const rel of changes.remove ?? []) {
		await fs.rm(path.join(other, rel), { recursive: true, force: true });
	}
	await git.add(["-A"]);
	await git.commit("other machine");
	await git.push("origin", "main");
}

const LOCAL_PLUGINS: Record<string, string> = {
	"plugins/cache/mkt/p/1.0.0/index.js": "local cache",
	"plugins/marketplaces/m.json": "local marketplace",
	"plugins/installed_plugins.json": '{"local": true}',
	"plugins/data/d.json": "local data",
};

async function seedLocalPlugins(configDir: string): Promise<void> {
	for (const [rel, content] of Object.entries(LOCAL_PLUGINS)) {
		await write(path.join(configDir, rel), content);
	}
}

async function expectLocalPluginsUntouched(configDir: string): Promise<void> {
	for (const [rel, content] of Object.entries(LOCAL_PLUGINS)) {
		expect(await fs.readFile(path.join(configDir, rel), "utf-8")).toBe(content);
	}
}

describe("plugins=false (v2)", () => {
	it("pull leaves a real local plugins/ tree untouched when the repo has no plugins/", async () => {
		const fx = await makeFixture(2);
		await seedLocalPlugins(fx.configDir);
		await write(path.join(fx.configDir, "CLAUDE.md"), "local");
		// Repo once tracked plugins, then the other machine removed them and disabled sync.
		await pushFromOtherMachine(fx, {
			write: {
				"claude/CLAUDE.md": "remote",
				"claude/plugins/cache/mkt/p/1.0.0/index.js": "local cache",
				"claude/plugins/installed_plugins.json": '{"local": true}',
			},
		});
		await syncPull({ syncRepoDir: fx.repoDir, homeDir: fx.homeDir, environments: [fx.env] });
		await pushFromOtherMachine(fx, {
			write: { "tools/sync-config.json": '{"plugins": false}' },
			remove: ["claude/plugins"],
		});
		await seedLocalPlugins(fx.configDir);

		await syncPull({ syncRepoDir: fx.repoDir, homeDir: fx.homeDir, environments: [fx.env] });

		await expectLocalPluginsUntouched(fx.configDir);
		expect(await fs.readFile(path.join(fx.configDir, "CLAUDE.md"), "utf-8")).toBe("remote");
	});

	it("pull does not overwrite local plugin files when the repo still has plugins/", async () => {
		const fx = await makeFixture(2);
		await seedLocalPlugins(fx.configDir);
		await pushFromOtherMachine(fx, {
			write: {
				"tools/sync-config.json": '{"plugins": false}',
				"claude/CLAUDE.md": "remote",
				"claude/plugins/cache/mkt/p/1.0.0/index.js": "stale remote cache",
				"claude/plugins/installed_plugins.json": '{"remote": true}',
			},
		});
		await syncPull({ syncRepoDir: fx.repoDir, homeDir: fx.homeDir, environments: [fx.env] });
		await expectLocalPluginsUntouched(fx.configDir);
	});

	it("control: with the default config pull still deletes plugin files removed from the repo", async () => {
		const fx = await makeFixture(2);
		await pushFromOtherMachine(fx, {
			write: { "claude/plugins/data/d.json": "local data", "claude/CLAUDE.md": "x" },
		});
		await syncPull({ syncRepoDir: fx.repoDir, homeDir: fx.homeDir, environments: [fx.env] });
		expect(await exists(path.join(fx.configDir, "plugins/data/d.json"))).toBe(true);
		await pushFromOtherMachine(fx, { remove: ["claude/plugins"] });
		await syncPull({ syncRepoDir: fx.repoDir, homeDir: fx.homeDir, environments: [fx.env] });
		expect(await exists(path.join(fx.configDir, "plugins/data/d.json"))).toBe(false);
	});

	it("pull creates no plugin backup entries", async () => {
		const fx = await makeFixture(2);
		await writeSyncConfig(fx.repoDir, '{"plugins": false}');
		await seedLocalPlugins(fx.configDir);
		await write(path.join(fx.configDir, "CLAUDE.md"), "local");
		await pushFromOtherMachine(fx, { write: { "claude/CLAUDE.md": "remote" } });
		const result = await syncPull({
			syncRepoDir: fx.repoDir,
			homeDir: fx.homeDir,
			environments: [fx.env],
		});
		expect(await exists(path.join(result.backupDir, "claude", "plugins"))).toBe(false);
		expect(await exists(path.join(result.backupDir, "claude", "CLAUDE.md"))).toBe(true);
	});

	it("push does not add plugin files, and default push does", async () => {
		const fx = await makeFixture(2);
		await seedLocalPlugins(fx.configDir);
		await write(path.join(fx.configDir, "CLAUDE.md"), "local");
		await writeSyncConfig(fx.repoDir, '{"plugins": false}');
		await syncPush({
			syncRepoDir: fx.repoDir,
			homeDir: fx.homeDir,
			environments: [fx.env],
			skipDiscovery: true,
		});
		expect(await exists(path.join(fx.repoDir, "claude", "CLAUDE.md"))).toBe(true);
		expect(await exists(path.join(fx.repoDir, "claude", "plugins"))).toBe(false);

		await fs.rm(path.join(fx.repoDir, "tools", "sync-config.json"));
		await syncPush({
			syncRepoDir: fx.repoDir,
			homeDir: fx.homeDir,
			environments: [fx.env],
			skipDiscovery: true,
		});
		expect(await exists(path.join(fx.repoDir, "claude", "plugins", "data", "d.json"))).toBe(true);
	});

	it("status and drift ignore plugin files", async () => {
		const fx = await makeFixture(2);
		await writeSyncConfig(fx.repoDir, '{"plugins": false}');
		await seedLocalPlugins(fx.configDir);
		const status = await syncStatus({
			syncRepoDir: fx.repoDir,
			homeDir: fx.homeDir,
			environments: [fx.env],
		});
		expect(status.localModifications.some((m) => m.path.startsWith("plugins/"))).toBe(false);
		const drift = await classifyDriftForEnv(fx.env, fx.repoDir, fx.homeDir);
		expect([...drift.localOnly, ...drift.remoteOnly, ...drift.bothChanged]).not.toContain(
			"plugins/data/d.json",
		);

		await fs.rm(path.join(fx.repoDir, "tools", "sync-config.json"));
		const driftDefault = await classifyDriftForEnv(fx.env, fx.repoDir, fx.homeDir);
		expect(driftDefault.localOnly).toContain("plugins/data/d.json");
	});

	it("push fails with a fix message on malformed sync-config.json", async () => {
		const fx = await makeFixture(2);
		await writeSyncConfig(fx.repoDir, "{nope");
		await expect(
			syncPush({
				syncRepoDir: fx.repoDir,
				homeDir: fx.homeDir,
				environments: [fx.env],
				skipDiscovery: true,
			}),
		).rejects.toThrow(/sync-config\.json.*Fix the file/s);
	});

	it("link skips plugin targets", async () => {
		const fx = await makeFixture(2);
		await writeSyncConfig(fx.repoDir, '{"plugins": false}');
		await seedLocalPlugins(fx.configDir);
		const result = await linkEnvironment(fx.env, fx.repoDir, path.join(baseDir, "bk"));
		expect(result.linked.some((t) => t.startsWith("plugins/"))).toBe(false);
		const stat = await fs.lstat(path.join(fx.configDir, "plugins/cache"));
		expect(stat.isSymbolicLink()).toBe(false);
	});
});

describe("plugins=false (v1)", () => {
	it("pull leaves local plugins/ untouched and push does not add them", async () => {
		const fx = await makeFixture(1);
		await seedLocalPlugins(fx.configDir);
		await write(path.join(fx.configDir, "CLAUDE.md"), "local");
		await pushFromOtherMachine(fx, {
			write: {
				"tools/sync-config.json": '{"plugins": false}',
				"CLAUDE.md": "remote",
				"plugins/cache/mkt/p/1.0.0/index.js": "stale remote cache",
			},
		});
		await syncPull({ syncRepoDir: fx.repoDir, claudeDir: fx.configDir, homeDir: fx.homeDir });
		await expectLocalPluginsUntouched(fx.configDir);
		expect(await fs.readFile(path.join(fx.configDir, "CLAUDE.md"), "utf-8")).toBe("remote");

		await write(path.join(fx.configDir, "plugins/data/new.json"), "n");
		await syncPush({ syncRepoDir: fx.repoDir, claudeDir: fx.configDir, homeDir: fx.homeDir });
		expect(await exists(path.join(fx.repoDir, "plugins/data/new.json"))).toBe(false);
	});
});

describe("ai-sync status output", () => {
	async function runStatus(repoDir: string, claudeDir: string): Promise<string> {
		const { Command } = await import("commander");
		const { registerStatusCommand } = await import("../../src/cli/commands/status.js");
		const lines: string[] = [];
		const orig = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.join(" "));
		};
		try {
			const program = new Command();
			registerStatusCommand(program);
			await program.parseAsync(["status", "--repo-path", repoDir, "--claude-dir", claudeDir], {
				from: "user",
			});
		} finally {
			console.log = orig;
		}
		return lines.join("\n");
	}

	it("prints a plugins line only when plugin sync is disabled", async () => {
		const fx = await makeFixture(1);
		await fs.mkdir(fx.configDir, { recursive: true });
		expect(await runStatus(fx.repoDir, fx.configDir)).not.toContain("plugins: not synced");
		await writeSyncConfig(fx.repoDir, '{"plugins": false}');
		expect(await runStatus(fx.repoDir, fx.configDir)).toContain(
			"plugins: not synced (tools/sync-config.json)",
		);
	});
});

describe("verify option", () => {
	it("defaults to false and accepts true", async () => {
		expect(defaultSyncConfig().verify).toBe(false);
		await fs.mkdir(path.join(baseDir, "tools"), { recursive: true });
		await fs.writeFile(path.join(baseDir, "tools", "sync-config.json"), '{"verify": true}');
		expect((await loadSyncConfig(baseDir)).verify).toBe(true);
	});

	it("rejects a non-boolean verify", async () => {
		await fs.mkdir(path.join(baseDir, "tools"), { recursive: true });
		await fs.writeFile(path.join(baseDir, "tools", "sync-config.json"), '{"verify": "yes"}');
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(/verify/);
	});
});
