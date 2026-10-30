import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAllowlistFn } from "../../src/core/env-helpers.js";
import { ALL_ENVIRONMENTS, getEnvironmentById, PiEnvironment } from "../../src/core/environment.js";
import { syncPush } from "../../src/core/sync-engine.js";
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
			"extensions/pre-migration.ts",
			"prompts/foo-pre-edit.md",
			"logs/a.log",
			"backups/a",
			"archive/a",
			"git/a",
			"npm/a",
			"install/a",
			"engineering-memory/a",
			"orch-123/a",
			"orch-abc/sub/b",
		])("never allows %s", (p) => {
			expect(allowed(p)).toBe(false);
		});

		it("does not over-block unrelated names", () => {
			expect(allowed("extensions/git-helper.ts")).toBe(true);
			expect(allowed("extensions/npm/x.ts")).toBe(true);
		});
	});

	describe("push never copies secrets", () => {
		let tmpDir: string;
		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-env-test-"));
		});
		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

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
	});
});
