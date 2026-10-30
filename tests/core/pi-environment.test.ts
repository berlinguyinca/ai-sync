import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAllowlistFn } from "../../src/core/env-helpers.js";
import {
	ALL_ENVIRONMENTS,
	ClaudeEnvironment,
	getEnvironmentById,
	PiEnvironment,
} from "../../src/core/environment.js";
import { scanDirectory } from "../../src/core/scanner.js";
import { syncPull, syncPush } from "../../src/core/sync-engine.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

describe("PiEnvironment", () => {
	const pi = new PiEnvironment();
	const originalDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
	});

	it("has id and display name", () => {
		expect(pi.id).toBe("pi");
		expect(pi.displayName).toBe("Pi");
	});

	it("config dir defaults to ~/.pi/agent and honours PI_CODING_AGENT_DIR", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		expect(pi.getConfigDir()).toBe(path.join(os.homedir(), ".pi", "agent"));
		process.env.PI_CODING_AGENT_DIR = "/custom/pi";
		expect(pi.getConfigDir()).toBe("/custom/pi");
	});

	it("is registered and discoverable", () => {
		expect(ALL_ENVIRONMENTS.some((e) => e.id === "pi")).toBe(true);
		expect(getEnvironmentById("pi")).toBeInstanceOf(PiEnvironment);
	});

	it("declares portable sync targets only", () => {
		expect([...pi.getSyncTargets()]).toEqual([
			"extensions/",
			"engineering-panel/",
			"bin/",
			"prompts/",
			"skills/",
			"AGENTS.md",
			"settings.json",
		]);
		expect(pi.getPluginSyncPatterns()).toEqual([]);
		expect(pi.getPathRewriteTargets()).toEqual([]);
		expect(pi.getSkillsSubdir()).toBeNull();
	});

	describe("allowlist", () => {
		const allowed = makeAllowlistFn(pi);

		it("allows portable files", () => {
			expect(allowed("extensions/x.ts")).toBe(true);
			expect(allowed("AGENTS.md")).toBe(true);
			expect(allowed("settings.json")).toBe(true);
			expect(allowed("prompts/a.md")).toBe(true);
		});

		it.each([
			"auth.json",
			"models.json",
			"models-store.json",
			"engineering.yaml",
			"capability-cache.json",
			"crashes.json",
			"extensions/auth.json",
			"extensions/foo/models.json",
			"skills/x/engineering.yaml",
			"extensions/x.ts.bak",
			"extensions/x.bak.1",
			"models.json.pre-dynamic-context.2026",
			"qwen-nodes.json.pre-deturing.2026",
			"extensions/foo.ts.pre-x",
			"extensions/foo.ts.bak-2026",
			"extensions/.env",
			"extensions/.env.local",
			"extensions/x.json~",
			"extensions/Auth.json",
			"x/engineering.YAML",
			"extensions/x/logs/a.log",
			"engineering-panel/orch-1/a",
			"engineering-panel/engineering-memory/a",
			"git/a",
			"git/x/b",
			"extensions/x/backups/a",
			"archive/a",
			"npm/a",
			"extensions/x/node_modules/a",
			"extensions/x/.venv/bin/python",
			"skills/x/__pycache__/a.pyc",
			"skills/x/Node_Modules/a",
			"install/x",
			"extensions/x/orch-abc/sub/b",
			"skills/.env/key",
			"skills/x.bak/secret",
			"skills/Y.PRE-1/s",
			"skills/auth.json/x",
			"extensions/foo.swp/a",
		])("never allows %s", (p) => {
			expect(allowed(p)).toBe(false);
		});

		it("allows generic dir names nested (only the root ones are anchored)", () => {
			expect(allowed("skills/foo/install/setup.sh")).toBe(true);
			expect(allowed("extensions/x/git/a")).toBe(true);
			expect(allowed("extensions/x/npm/a")).toBe(true);
			expect(allowed("extensions/x/archive/a")).toBe(true);
			const ignored = makeAllowlistFn(pi).isIgnored;
			expect(ignored("install/x")).toBe(true);
			expect(ignored("skills/foo/install/setup.sh")).toBe(false);
		});

		it("does not over-block unrelated names", () => {
			expect(allowed("extensions/git-helper.ts")).toBe(true);
			expect(allowed("prompts/foo-pre-edit.md")).toBe(true);
			expect(allowed("skills/x/pre-commit.md")).toBe(true);
			expect(allowed("extensions/pre-migration.ts")).toBe(true);
			expect(allowed("extensions/npm-helper/x.ts")).toBe(true);
			expect(allowed("skills/pre-commit/SKILL.md")).toBe(true);
		});
	});

	describe("symlinks into ignored directories", () => {
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-env-ign-"));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it.skipIf(process.platform === "win32")(
			"does not scan through links to a .env directory or a file inside it",
			async () => {
				await fs.mkdir(path.join(tmpDir, "skills", ".env"), { recursive: true });
				await fs.writeFile(path.join(tmpDir, "skills", ".env", "key"), "SECRET");
				await fs.mkdir(path.join(tmpDir, "skills", "ok"), { recursive: true });
				await fs.writeFile(path.join(tmpDir, "skills", "ok", "SKILL.md"), "ok");
				await fs.mkdir(path.join(tmpDir, "extensions"), { recursive: true });
				await fs.symlink(
					path.join(tmpDir, "skills", ".env"),
					path.join(tmpDir, "extensions", "envlink"),
				);
				await fs.symlink(
					path.join(tmpDir, "skills", ".env", "key"),
					path.join(tmpDir, "extensions", "envkey"),
				);
				const files = await scanDirectory(tmpDir, makeAllowlistFn(pi));
				expect(files).toEqual(["skills/ok/SKILL.md"]);
			},
		);
	});

	describe("pull never writes through local links", () => {
		class TmpClaude extends ClaudeEnvironment {
			constructor(private readonly dir: string) {
				super();
			}
			getConfigDir(): string {
				return this.dir;
			}
		}
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-env-pull-"));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		async function setup(envId: string): Promise<{ syncRepoDir: string; outside: string }> {
			const bareDir = path.join(tmpDir, "bare.git");
			const syncRepoDir = path.join(tmpDir, "sync-repo");
			const otherDir = path.join(tmpDir, "other");
			await fs.mkdir(bareDir, { recursive: true });
			await simpleGit(bareDir).init(true);
			await fs.mkdir(otherDir, { recursive: true });
			await initRepo(otherDir);
			await simpleGit(otherDir).addConfig("user.email", "t@t.com");
			await simpleGit(otherDir).addConfig("user.name", "T");
			await simpleGit(otherDir).addConfig("commit.gpgsign", "false");
			await addRemote(otherDir, "origin", bareDir);
			await fs.writeFile(path.join(otherDir, ".sync-version"), "2");
			await commitAll(otherDir, "initial");
			await simpleGit(otherDir).push("origin", "main");
			await simpleGit(bareDir).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
			await simpleGit(tmpDir).clone(bareDir, syncRepoDir);
			await simpleGit(syncRepoDir).addConfig("user.email", "t@t.com");
			await simpleGit(syncRepoDir).addConfig("user.name", "T");
			// remote gains a file under skills/outdir/
			await fs.mkdir(path.join(otherDir, envId, "skills", "outdir"), { recursive: true });
			await fs.writeFile(path.join(otherDir, envId, "skills", "outdir", "evil"), "EVIL");
			await commitAll(otherDir, "add evil");
			await simpleGit(otherDir).push("origin", "main");
			const outside = path.join(tmpDir, "outside");
			await fs.mkdir(outside, { recursive: true });
			return { syncRepoDir, outside };
		}

		async function commitAll(dir: string, msg: string): Promise<void> {
			await simpleGit(dir).add(["-A"]);
			await commitFiles(dir, msg);
		}

		it.skipIf(process.platform === "win32")(
			"pi: skips and reports files whose parent resolves outside the config dir",
			async () => {
				const { syncRepoDir, outside } = await setup("pi");
				const piDir = path.join(tmpDir, "home", ".pi", "agent");
				await fs.mkdir(path.join(piDir, "skills"), { recursive: true });
				await fs.symlink(outside, path.join(piDir, "skills", "outdir"));
				const prev = process.env.PI_CODING_AGENT_DIR;
				process.env.PI_CODING_AGENT_DIR = piDir;
				try {
					const result = await syncPull({
						syncRepoDir,
						homeDir: path.join(tmpDir, "home"),
						environments: [new PiEnvironment()],
					});
					expect(result.skippedLinks).toEqual(["pi: skills/outdir/evil"]);
				} finally {
					if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = prev;
				}
				expect(await fs.readdir(outside)).toEqual([]);
			},
		);

		it.skipIf(process.platform === "win32")(
			"claude: behaviour unchanged (still writes through a local link)",
			async () => {
				const { syncRepoDir, outside } = await setup("claude");
				const claudeDir = path.join(tmpDir, "home", ".claude");
				await fs.mkdir(path.join(claudeDir, "skills"), { recursive: true });
				await fs.symlink(outside, path.join(claudeDir, "skills", "outdir"));
				const result = await syncPull({
					syncRepoDir,
					homeDir: path.join(tmpDir, "home"),
					environments: [new TmpClaude(claudeDir)],
				});
				expect(result.skippedLinks).toBeUndefined();
				expect(await fs.readFile(path.join(outside, "evil"), "utf-8")).toBe("EVIL");
			},
		);
	});

	describe("push never copies secrets", () => {
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-env-test-"));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		async function initRepoWithRemote(): Promise<{
			syncRepoDir: string;
			homeDir: string;
			piDir: string;
		}> {
			const bareDir = path.join(tmpDir, "bare.git");
			const syncRepoDir = path.join(tmpDir, "sync-repo");
			const homeDir = path.join(tmpDir, "home");
			const piDir = path.join(homeDir, ".pi", "agent");
			await fs.mkdir(bareDir, { recursive: true });
			await simpleGit(bareDir).init(true);
			await fs.mkdir(syncRepoDir, { recursive: true });
			await initRepo(syncRepoDir);
			await simpleGit(syncRepoDir).addConfig("user.email", "t@t.com");
			await simpleGit(syncRepoDir).addConfig("user.name", "T");
			await simpleGit(syncRepoDir).addConfig("commit.gpgsign", "false");
			await addRemote(syncRepoDir, "origin", bareDir);
			await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2");
			await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
			await addFiles(syncRepoDir, [".gitkeep", ".sync-version"]);
			await commitFiles(syncRepoDir, "initial");
			await simpleGit(syncRepoDir).push("origin", "main");
			await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);
			return { syncRepoDir, homeDir, piDir };
		}

		async function pushPi(
			syncRepoDir: string,
			homeDir: string,
			piDir: string,
		): Promise<Awaited<ReturnType<typeof syncPush>>> {
			const prev = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = piDir;
			try {
				return await syncPush({ syncRepoDir, homeDir, environments: [new PiEnvironment()] });
			} finally {
				if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = prev;
			}
		}

		it.skipIf(process.platform === "win32")(
			"keeps previously synced files when a directory becomes an external link",
			async () => {
				const { syncRepoDir, homeDir, piDir } = await initRepoWithRemote();
				await fs.mkdir(path.join(piDir, "extensions", "sub"), { recursive: true });
				await fs.writeFile(path.join(piDir, "extensions", "a.ts"), "a");
				await fs.writeFile(path.join(piDir, "extensions", "sub", "b.ts"), "b");
				await fs.writeFile(path.join(piDir, "AGENTS.md"), "x");
				await pushPi(syncRepoDir, homeDir, piDir);

				const ext = path.join(tmpDir, "dotfiles", "pi-ext");
				await fs.mkdir(ext, { recursive: true });
				await fs.writeFile(path.join(ext, "a.ts"), "other");
				await fs.rm(path.join(piDir, "extensions"), { recursive: true });
				await fs.symlink(ext, path.join(piDir, "extensions"));
				await fs.rm(path.join(piDir, "AGENTS.md"));

				const result = await pushPi(syncRepoDir, homeDir, piDir);
				expect(result.skippedLinks).toContain("pi: extensions");
				await expect(
					fs.readFile(path.join(syncRepoDir, "pi", "extensions", "a.ts"), "utf-8"),
				).resolves.toBe("a");
				await expect(
					fs.readFile(path.join(syncRepoDir, "pi", "extensions", "sub", "b.ts"), "utf-8"),
				).resolves.toBe("b");
				// unrelated deletions are still propagated
				await expect(fs.access(path.join(syncRepoDir, "pi", "AGENTS.md"))).rejects.toThrow();
			},
		);

		it.skipIf(process.platform === "win32")(
			"does not write through a link inside the repo subdir",
			async () => {
				const { syncRepoDir, homeDir, piDir } = await initRepoWithRemote();
				const outside = path.join(tmpDir, "outside");
				await fs.mkdir(outside, { recursive: true });
				await fs.mkdir(path.join(syncRepoDir, "pi"), { recursive: true });
				await fs.symlink(outside, path.join(syncRepoDir, "pi", "extensions"));
				await fs.mkdir(path.join(piDir, "extensions"), { recursive: true });
				await fs.writeFile(path.join(piDir, "extensions", "x.ts"), "export {}");
				const result = await pushPi(syncRepoDir, homeDir, piDir);
				expect(await fs.readdir(outside)).toEqual([]);
				expect(result.skippedLinks).toContain("pi: extensions/x.ts");
			},
		);

		it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
			"fails closed when the repo subdir cannot be inspected (EACCES)",
			async () => {
				const { syncRepoDir, homeDir, piDir } = await initRepoWithRemote();
				const locked = path.join(syncRepoDir, "pi", "extensions");
				await fs.mkdir(locked, { recursive: true });
				await fs.chmod(locked, 0o000);
				try {
					await fs.mkdir(path.join(piDir, "extensions"), { recursive: true });
					await fs.writeFile(path.join(piDir, "extensions", "x.ts"), "export {}");
					const result = await pushPi(syncRepoDir, homeDir, piDir);
					expect(result.skippedLinks).toContain("pi: extensions/x.ts");
				} finally {
					await fs.chmod(locked, 0o755);
				}
			},
		);

		it("copies only extensions/x.ts when auth.json and models.json are present", async () => {
			const bareDir = path.join(tmpDir, "bare.git");
			const syncRepoDir = path.join(tmpDir, "sync-repo");
			const homeDir = path.join(tmpDir, "home");
			const piDir = path.join(homeDir, ".pi", "agent");
			await fs.mkdir(bareDir, { recursive: true });
			await simpleGit(bareDir).init(true);
			await fs.mkdir(syncRepoDir, { recursive: true });
			await initRepo(syncRepoDir);
			await simpleGit(syncRepoDir).addConfig("user.email", "t@t.com");
			await simpleGit(syncRepoDir).addConfig("user.name", "T");
			await simpleGit(syncRepoDir).addConfig("commit.gpgsign", "false");
			await addRemote(syncRepoDir, "origin", bareDir);
			await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2");
			await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
			await addFiles(syncRepoDir, [".gitkeep", ".sync-version"]);
			await commitFiles(syncRepoDir, "initial");
			await simpleGit(syncRepoDir).push("origin", "main");
			await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

			await fs.mkdir(path.join(piDir, "extensions"), { recursive: true });
			await fs.writeFile(path.join(piDir, "extensions", "x.ts"), "export {}");
			await fs.writeFile(path.join(piDir, "extensions", "auth.json"), '{"k":"secret"}');
			await fs.writeFile(path.join(piDir, "auth.json"), '{"k":"secret"}');
			await fs.writeFile(path.join(piDir, "models.json"), '{"k":"secret"}');

			const env = new PiEnvironment();
			const prev = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = piDir;
			try {
				await syncPush({ syncRepoDir, homeDir, environments: [env] });
			} finally {
				if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = prev;
			}

			await expect(
				fs.readFile(path.join(syncRepoDir, "pi", "extensions", "x.ts"), "utf-8"),
			).resolves.toBe("export {}");
			for (const p of ["auth.json", "models.json", "extensions/auth.json"]) {
				await expect(fs.access(path.join(syncRepoDir, "pi", p))).rejects.toThrow();
			}
			const tracked = await simpleGit(syncRepoDir).raw(["ls-files"]);
			expect(tracked).not.toContain("auth.json");
			expect(tracked).not.toContain("models.json");
		});

		it.skipIf(process.platform === "win32")(
			"skips symlinks resolving outside the config dir and reports them",
			async () => {
				const bareDir = path.join(tmpDir, "bare.git");
				const syncRepoDir = path.join(tmpDir, "sync-repo");
				const homeDir = path.join(tmpDir, "home");
				const piDir = path.join(homeDir, ".pi", "agent");
				await fs.mkdir(bareDir, { recursive: true });
				await simpleGit(bareDir).init(true);
				await fs.mkdir(syncRepoDir, { recursive: true });
				await initRepo(syncRepoDir);
				await simpleGit(syncRepoDir).addConfig("user.email", "t@t.com");
				await simpleGit(syncRepoDir).addConfig("user.name", "T");
				await simpleGit(syncRepoDir).addConfig("commit.gpgsign", "false");
				await addRemote(syncRepoDir, "origin", bareDir);
				await fs.writeFile(path.join(syncRepoDir, ".sync-version"), "2");
				await fs.writeFile(path.join(syncRepoDir, ".gitkeep"), "");
				await addFiles(syncRepoDir, [".gitkeep", ".sync-version"]);
				await commitFiles(syncRepoDir, "initial");
				await simpleGit(syncRepoDir).push("origin", "main");
				await simpleGit(syncRepoDir).branch(["--set-upstream-to=origin/main", "main"]);

				await fs.mkdir(path.join(piDir, "extensions"), { recursive: true });
				await fs.writeFile(path.join(piDir, "extensions", "x.ts"), "export {}");
				const outside = path.join(tmpDir, "outside");
				await fs.mkdir(outside, { recursive: true });
				await fs.writeFile(path.join(outside, "id_rsa"), "PRIVATE");
				await fs.symlink(path.join(outside, "id_rsa"), path.join(piDir, "extensions", "key.ts"));

				const env = new PiEnvironment();
				const prev = process.env.PI_CODING_AGENT_DIR;
				process.env.PI_CODING_AGENT_DIR = piDir;
				let result: Awaited<ReturnType<typeof syncPush>>;
				try {
					result = await syncPush({ syncRepoDir, homeDir, environments: [env] });
				} finally {
					if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = prev;
				}

				expect(result.skippedLinks).toEqual(["pi: extensions/key.ts"]);
				await expect(
					fs.readFile(path.join(syncRepoDir, "pi", "extensions", "x.ts"), "utf-8"),
				).resolves.toBe("export {}");
				await expect(
					fs.access(path.join(syncRepoDir, "pi", "extensions", "key.ts")),
				).rejects.toThrow();
				expect(await simpleGit(syncRepoDir).raw(["ls-files"])).not.toContain("key.ts");
			},
		);
	});
});
