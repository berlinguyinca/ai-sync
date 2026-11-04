import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyDriftForEnv } from "../../src/core/drift.js";
import { makeAllowlistFn, makeDefaultAllowlistFn } from "../../src/core/env-helpers.js";
import { ClaudeEnvironment } from "../../src/core/environment.js";
import { getLinkableTargets } from "../../src/core/linker.js";
import { loadSyncConfig, SyncConfigSchema } from "../../src/core/sync-config.js";
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
	baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-exclude-"));
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

const EXCLUDE_AUTOSPEC = '{"exclude": ["skills/autospec*"]}';

describe("exclude schema", () => {
	it("is optional and absent by default", async () => {
		expect(SyncConfigSchema.parse({}).exclude).toBeUndefined();
		expect(await loadSyncConfig(baseDir)).toEqual({ plugins: true, verify: false });
	});

	it("accepts an array of non-empty strings", async () => {
		await writeSyncConfig(baseDir, EXCLUDE_AUTOSPEC);
		expect((await loadSyncConfig(baseDir)).exclude).toEqual(["skills/autospec*"]);
		await writeSyncConfig(baseDir, '{"exclude": []}');
		expect((await loadSyncConfig(baseDir)).exclude).toEqual([]);
	});

	it.each([
		['{"exclude": "skills/x"}', "a string"],
		['{"exclude": [1]}', "a number element"],
		['{"exclude": [""]}', "an empty pattern"],
		['{"exclude": [" "]}', "a blank pattern"],
	])("rejects %s (%s)", async (json) => {
		await writeSyncConfig(baseDir, json);
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(/exclude/);
	});

	it("still rejects unknown keys and lists exclude as allowed", async () => {
		await writeSyncConfig(baseDir, '{"excluded": []}');
		await expect(loadSyncConfig(baseDir)).rejects.toThrow(
			/unknown key\(s\) "excluded" \(allowed: "plugins", "verify", "exclude"\)/,
		);
	});
});

describe("exclude glob matching in allowlists", () => {
	const env = new ClaudeEnvironment();
	const allowed = (exclude: string[], rel: string): boolean =>
		makeAllowlistFn(env, { exclude })(rel);

	it("a file-less pattern excludes the matching directory and everything under it", () => {
		const exclude = ["skills/autospec*"];
		expect(allowed(exclude, "skills/autospec-run/SKILL.md")).toBe(false);
		expect(allowed(exclude, "skills/autospec/deep/nested/file.md")).toBe(false);
		expect(allowed(exclude, "skills/autospec-run")).toBe(false);
	});

	it("leaves non-matching siblings and look-alikes synced", () => {
		const exclude = ["skills/autospec*"];
		expect(allowed(exclude, "skills/my-skill/SKILL.md")).toBe(true);
		expect(allowed(exclude, "skills/notautospec/SKILL.md")).toBe(true);
		expect(allowed(exclude, "commands/autospec-x.md")).toBe(true);
		expect(allowed(exclude, "agents/skills/autospec-run/a.md")).toBe(true);
	});

	it("* does not cross a path separator", () => {
		const exclude = ["skills/*/private.md"];
		expect(allowed(exclude, "skills/a/private.md")).toBe(false);
		expect(allowed(exclude, "skills/a/b/private.md")).toBe(true);
	});

	it("is case-insensitive like the other ignore patterns", () => {
		expect(allowed(["skills/AutoSpec*"], "skills/autospec-run/SKILL.md")).toBe(false);
	});

	it("supports trailing-slash directory patterns and a leading-slash anchor", () => {
		expect(allowed(["skills/autospec*/"], "skills/autospec-run/SKILL.md")).toBe(false);
		expect(allowed(["/skills/autospec*"], "skills/autospec-run/SKILL.md")).toBe(false);
		expect(allowed(["/autospec*"], "skills/autospec-run/SKILL.md")).toBe(true);
	});

	it("a bare name matches at any depth", () => {
		expect(allowed(["secret.json"], "skills/x/secret.json")).toBe(false);
		expect(allowed(["secret.json"], "settings.json")).toBe(true);
	});

	it("regex metacharacters in a pattern are literal", () => {
		expect(allowed(["skills/a+b(1)"], "skills/a+b(1)/f.md")).toBe(false);
		expect(allowed(["skills/a+b(1)"], "skills/aab1/f.md")).toBe(true);
	});

	it("an empty list excludes nothing and keeps built-in ignores", () => {
		expect(allowed([], "skills/autospec-run/SKILL.md")).toBe(true);
		expect(allowed(["skills/zzz*"], "plugins/install-counts-cache.json")).toBe(false);
	});

	it("applies to the isIgnored predicate used to vet symlink targets", () => {
		const fn = makeAllowlistFn(env, { exclude: ["skills/autospec*"] });
		expect(fn.isIgnored?.("skills/autospec-run/x")).toBe(true);
	});

	it("applies to the v1 default allowlist", () => {
		const fn = makeDefaultAllowlistFn({ exclude: ["skills/autospec*"] });
		expect(fn("skills/autospec-run/SKILL.md")).toBe(false);
		expect(fn("skills/mine/SKILL.md")).toBe(true);
	});

	it("does not link a whole directory that contains an excluded path", () => {
		expect(getLinkableTargets(env)).toContain("skills/");
		expect(getLinkableTargets(env, { exclude: ["skills/autospec*"] })).not.toContain("skills/");
		expect(getLinkableTargets(env, { exclude: ["skills/autospec*"] })).toContain("agents/");
	});
});

interface Fixture {
	bareDir: string;
	repoDir: string;
	homeDir: string;
	configDir: string;
	env: ClaudeEnvironment;
}

async function makeFixture(): Promise<Fixture> {
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
	await write(path.join(repoDir, ".gitkeep"), "");
	await write(path.join(repoDir, ".sync-version"), "2");
	await addFiles(repoDir, [".gitkeep", ".sync-version"]);
	await commitFiles(repoDir, "initial");
	await simpleGit(repoDir).push("origin", "main");
	await simpleGit(repoDir).branch(["--set-upstream-to=origin/main", "main"]);
	return { bareDir, repoDir, homeDir, configDir, env: new TestClaudeEnvironment(configDir) };
}

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

const opts = (fx: Fixture) => ({
	syncRepoDir: fx.repoDir,
	homeDir: fx.homeDir,
	environments: [fx.env],
});

describe("exclude end to end (v2 repo)", () => {
	it("push does not collect excluded skill dirs but collects the rest", async () => {
		const fx = await makeFixture();
		await writeSyncConfig(fx.repoDir, EXCLUDE_AUTOSPEC);
		await write(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "owned by autospec");
		await write(path.join(fx.configDir, "skills/autospec/SKILL.md"), "owned by autospec");
		await write(path.join(fx.configDir, "skills/mine/SKILL.md"), "mine");
		await write(path.join(fx.configDir, "CLAUDE.md"), "claude");
		await syncPush({ ...opts(fx), skipDiscovery: true });
		expect(await exists(path.join(fx.repoDir, "claude/skills/mine/SKILL.md"))).toBe(true);
		expect(await exists(path.join(fx.repoDir, "claude/CLAUDE.md"))).toBe(true);
		expect(await exists(path.join(fx.repoDir, "claude/skills/autospec-run"))).toBe(false);
		expect(await exists(path.join(fx.repoDir, "claude/skills/autospec"))).toBe(false);
		const tracked = await simpleGit(fx.repoDir).raw(["ls-files"]);
		expect(tracked).not.toContain("autospec");
	});

	it("pull does not apply excluded files from the repo", async () => {
		const fx = await makeFixture();
		await pushFromOtherMachine(fx, {
			write: {
				"tools/sync-config.json": EXCLUDE_AUTOSPEC,
				"claude/skills/autospec-run/SKILL.md": "stale in repo",
				"claude/skills/mine/SKILL.md": "mine",
			},
		});
		await syncPull(opts(fx));
		expect(await exists(path.join(fx.configDir, "skills/autospec-run"))).toBe(false);
		expect(await fs.readFile(path.join(fx.configDir, "skills/mine/SKILL.md"), "utf-8")).toBe(
			"mine",
		);
	});

	it("pull never overwrites or deletes an installed excluded skill", async () => {
		const fx = await makeFixture();
		await write(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "installed locally");
		await write(path.join(fx.configDir, "skills/autospec-run/extra/a.md"), "local extra");
		await pushFromOtherMachine(fx, {
			write: {
				"tools/sync-config.json": EXCLUDE_AUTOSPEC,
				"claude/skills/autospec-run/SKILL.md": "different in repo",
				"claude/CLAUDE.md": "remote",
			},
		});
		await syncPull(opts(fx));
		expect(
			await fs.readFile(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "utf-8"),
		).toBe("installed locally");
		expect(await exists(path.join(fx.configDir, "skills/autospec-run/extra/a.md"))).toBe(true);

		// Removing it from the repo must not delete the local copy either.
		await pushFromOtherMachine(fx, { remove: ["claude/skills/autospec-run"] });
		await syncPull(opts(fx));
		expect(await exists(path.join(fx.configDir, "skills/autospec-run/SKILL.md"))).toBe(true);
		expect(await fs.readFile(path.join(fx.configDir, "CLAUDE.md"), "utf-8")).toBe("remote");
	});

	it("pull --force still does not touch an installed excluded skill", async () => {
		const fx = await makeFixture();
		await write(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "installed locally");
		await pushFromOtherMachine(fx, {
			write: {
				"tools/sync-config.json": EXCLUDE_AUTOSPEC,
				"claude/skills/autospec-run/SKILL.md": "different in repo",
			},
		});
		await syncPull({ ...opts(fx), force: true });
		expect(
			await fs.readFile(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "utf-8"),
		).toBe("installed locally");
	});

	it("status and drift show no entries for excluded paths", async () => {
		const fx = await makeFixture();
		await writeSyncConfig(fx.repoDir, EXCLUDE_AUTOSPEC);
		await write(path.join(fx.configDir, "skills/autospec-run/SKILL.md"), "x");
		const status = await syncStatus(opts(fx));
		expect(status.localModifications.some((m) => m.path.includes("autospec"))).toBe(false);
		const drift = await classifyDriftForEnv(fx.env, fx.repoDir, fx.homeDir);
		expect([...drift.localOnly, ...drift.remoteOnly, ...drift.bothChanged]).toEqual([]);

		await fs.rm(path.join(fx.repoDir, "tools", "sync-config.json"));
		const control = await classifyDriftForEnv(fx.env, fx.repoDir, fx.homeDir);
		expect(control.localOnly).toContain("skills/autospec-run/SKILL.md");
	});

	it("a malformed exclude fails push with a fix message", async () => {
		const fx = await makeFixture();
		await writeSyncConfig(fx.repoDir, '{"exclude": "skills/*"}');
		await expect(syncPush({ ...opts(fx), skipDiscovery: true })).rejects.toThrow(
			/sync-config\.json.*exclude/s,
		);
	});
});
