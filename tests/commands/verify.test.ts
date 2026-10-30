import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPullCommand } from "../../src/cli/commands/pull.js";
import { handlePush } from "../../src/cli/commands/push.js";
import { registerVerifyCommand } from "../../src/cli/commands/verify.js";
import { addFiles, addRemote, commitFiles, initRepo } from "../../src/git/repo.js";

// The hermetic setup points HOME at a throwaway dir, so ~/.claude is safe to use.
const claudeDir = () => path.join(os.homedir(), ".claude");

async function writeGoodTree() {
	const dir = claudeDir();
	await fs.mkdir(path.join(dir, "skills/alpha"), { recursive: true });
	await fs.writeFile(path.join(dir, "CLAUDE.md"), "# cfg\n");
	await fs.writeFile(
		path.join(dir, "skills/alpha/SKILL.md"),
		"---\nname: alpha\ndescription: d\n---\n",
	);
}

async function breakTree() {
	await fs.writeFile(
		path.join(claudeDir(), "skills/alpha/SKILL.md"),
		"---\nname: nope\ndescription: d\n---\n",
	);
}

let logs: string[];
let errs: string[];
let savedExit: typeof process.exitCode;
let tmp: string;
let savedInstallDir: string | undefined;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verify-cmd-"));
	// Keep .environments.json out of the repo checkout.
	savedInstallDir = process.env.AI_SYNC_INSTALL_DIR;
	process.env.AI_SYNC_INSTALL_DIR = path.join(tmp, "install");
	await fs.mkdir(process.env.AI_SYNC_INSTALL_DIR, { recursive: true });
	await fs.rm(claudeDir(), { recursive: true, force: true });
	logs = [];
	errs = [];
	vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
	vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
	savedExit = process.exitCode;
	process.exitCode = undefined;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (savedInstallDir === undefined) delete process.env.AI_SYNC_INSTALL_DIR;
	else process.env.AI_SYNC_INSTALL_DIR = savedInstallDir;
	process.exitCode = savedExit;
	await fs.rm(claudeDir(), { recursive: true, force: true });
	await fs.rm(tmp, { recursive: true, force: true });
});

async function run(register: (p: Command) => void, args: string[]) {
	const program = new Command();
	program.exitOverride();
	register(program);
	await program.parseAsync(["node", "test", ...args]);
}

describe("ai-sync verify", () => {
	it("exits 0 with JSON model only on stdout for a good tree", async () => {
		await writeGoodTree();
		await run(registerVerifyCommand, ["verify", "--env", "claude", "--json"]);
		expect(process.exitCode).toBe(0);
		expect(logs).toHaveLength(1);
		const model = JSON.parse(logs[0] as string);
		expect(model).toMatchObject({ ok: true, env: "claude", errors: [], warnings: [] });
		expect(model.checked).toMatchObject({ skills: 1, settings: false });
	});

	it("exits 1 with human output listing the error for a bad tree", async () => {
		await writeGoodTree();
		await breakTree();
		await run(registerVerifyCommand, ["verify", "--env", "claude"]);
		expect(process.exitCode).toBe(1);
		const out = logs.join("\n");
		expect(out).toContain("FAILED");
		expect(out).toContain("skills/alpha/SKILL.md");
	});

	it("exits 2 for an unknown environment", async () => {
		await run(registerVerifyCommand, ["verify", "--env", "nope"]);
		expect(process.exitCode).toBe(2);
		expect(errs.join("\n")).toContain("nope");
	});

	it("aggregates multiple environments in JSON", async () => {
		await writeGoodTree();
		const { setEnabledEnvironments } = await import("../../src/core/env-config.js");
		setEnabledEnvironments(["claude", "codex"]);
		await run(registerVerifyCommand, ["verify", "--json"]);
		const model = JSON.parse(logs[0] as string);
		expect(model.envs.map((e: { env: string }) => e.env)).toEqual(["claude", "codex"]);
		expect(typeof model.ok).toBe("boolean");
	});
});

async function setupPullRepo(verify: boolean | undefined) {
	const bare = path.join(tmp, "bare.git");
	const repo = path.join(tmp, "sync-repo");
	await fs.mkdir(bare, { recursive: true });
	await simpleGit(bare).init(true);
	await fs.mkdir(repo, { recursive: true });
	await initRepo(repo);
	await addRemote(repo, "origin", bare);
	await fs.mkdir(path.join(repo, "tools"), { recursive: true });
	const files = [".gitkeep"];
	await fs.writeFile(path.join(repo, ".gitkeep"), "");
	if (verify !== undefined) {
		await fs.writeFile(path.join(repo, "tools/sync-config.json"), JSON.stringify({ verify }));
		files.push("tools/sync-config.json");
	}
	await addFiles(repo, files);
	await commitFiles(repo, "initial");
	await simpleGit(repo).push("origin", "main");
	await simpleGit(repo).branch(["--set-upstream-to=origin/main", "main"]);
	await handlePush({ repoPath: repo, claudeDir: claudeDir() });
	return repo;
}

describe("pull with verify config", () => {
	it("verify:true exits 0 on a good tree and prints the result", async () => {
		await writeGoodTree();
		const repo = await setupPullRepo(true);
		await run(registerPullCommand, ["pull", "--repo-path", repo, "--claude-dir", claudeDir()]);
		expect(process.exitCode).toBeUndefined();
		expect(logs.join("\n")).toContain("claude: ");
		expect(logs.join("\n")).toContain("ok");
	});

	it("verify:true exits non-zero on a bad tree without rolling back", async () => {
		await writeGoodTree();
		await breakTree();
		const repo = await setupPullRepo(true);
		await run(registerPullCommand, ["pull", "--repo-path", repo, "--claude-dir", claudeDir()]);
		expect(process.exitCode).toBe(1);
		expect(errs.join("\n")).toMatch(/restore.*backup/i);
		const skill = await fs.readFile(path.join(claudeDir(), "skills/alpha/SKILL.md"), "utf-8");
		expect(skill).toContain("name: nope");
	});

	it("verify:true with --dry-run never verifies", async () => {
		await writeGoodTree();
		await breakTree();
		const repo = await setupPullRepo(true);
		await run(registerPullCommand, [
			"pull",
			"--dry-run",
			"--repo-path",
			repo,
			"--claude-dir",
			claudeDir(),
		]);
		expect(process.exitCode).toBeUndefined();
		expect(logs.join("\n")).not.toContain("Verifying");
	});

	it("default config does not run the verifier", async () => {
		await writeGoodTree();
		await breakTree();
		const repo = await setupPullRepo(undefined);
		await run(registerPullCommand, ["pull", "--repo-path", repo, "--claude-dir", claudeDir()]);
		expect(process.exitCode).toBeUndefined();
		expect(logs.join("\n")).not.toContain("Verifying");
	});
});
