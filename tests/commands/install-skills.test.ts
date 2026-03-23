import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeEnvironment } from "../../src/core/environment.js";
import { installSkills } from "../../src/core/skills.js";
import { registerInstallSkillsCommand } from "../../src/cli/commands/install-skills.js";

describe("install-skills", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "install-skills-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("installs skills into claude commands/ directory", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });

		const result = await installSkills(claudeDir);
		expect(result.installed.length).toBeGreaterThan(0);
		expect(result.installed).toContain("sync.md");

		// Verify the file was actually written
		const content = await fs.readFile(path.join(claudeDir, "commands", "sync.md"), "utf-8");
		expect(content).toContain("ai-sync");
	});

	it("skips skills that are already up to date", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });

		// Install once
		await installSkills(claudeDir);

		// Install again — should skip
		const result = await installSkills(claudeDir);
		expect(result.installed).toHaveLength(0);
		expect(result.skipped).toContain("sync.md");
	});

	it("updates skills when content has changed", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		const commandsDir = path.join(claudeDir, "commands");
		await fs.mkdir(commandsDir, { recursive: true });

		// Write an outdated version
		await fs.writeFile(path.join(commandsDir, "sync.md"), "old content");

		const result = await installSkills(claudeDir);
		expect(result.installed).toContain("sync.md");
	});

	it("installs environment-specific skills into correct targets", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });

		// Create a test environment that points to our tmp dir
		const testEnv: InstanceType<typeof ClaudeEnvironment> = Object.create(ClaudeEnvironment.prototype);
		Object.defineProperty(testEnv, "id", { value: "claude" });
		Object.defineProperty(testEnv, "displayName", { value: "Claude Code" });
		testEnv.getConfigDir = () => claudeDir;
		testEnv.getSkillsSubdir = () => "commands";
		testEnv.getSyncTargets = () => ["settings.json", "CLAUDE.md", "commands/"];
		testEnv.getPluginSyncPatterns = () => [];
		testEnv.getIgnorePatterns = () => [];
		testEnv.getPathRewriteTargets = () => ["settings.json"];

		const result = await installSkills(claudeDir, [testEnv]);
		expect(result.installed.length).toBeGreaterThan(0);
		expect(result.perEnvironment).toBeDefined();
		expect(result.perEnvironment?.claude).toBeDefined();
	});

	it("creates commands/ directory if it does not exist", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });
		// Don't create commands/ — installSkills should create it

		const result = await installSkills(claudeDir);
		expect(result.installed.length).toBeGreaterThan(0);

		// Verify directory was created
		const stat = await fs.stat(path.join(claudeDir, "commands"));
		expect(stat.isDirectory()).toBe(true);
	});
});

describe("install-skills CLI wrapper (registerInstallSkillsCommand)", () => {
	let tmpDir: string;
	let program: Command;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let savedExitCode: number | undefined;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "install-skills-cli-test-"));
		program = new Command();
		program.exitOverride();
		registerInstallSkillsCommand(program);
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = savedExitCode;
	});

	it("runs install-skills and prints output about skills", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });

		await program.parseAsync(["node", "test", "install-skills", "--claude-dir", claudeDir]);

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		// The handler either prints "Installed skills" or "Already up to date" depending
		// on whether skills already exist on this machine (env instances point to real config dirs).
		// Either way, sync.md should appear in the output.
		expect(output).toContain("sync.md");
		expect(output).toMatch(/Installed skills|up to date/);
	});

	it("runs install-skills twice — second run reports up-to-date", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });

		// First install
		await program.parseAsync(["node", "test", "install-skills", "--claude-dir", claudeDir]);
		logSpy.mockClear();

		// Second install — new program instance needed since Commander tracks state
		const program2 = new Command();
		program2.exitOverride();
		registerInstallSkillsCommand(program2);
		await program2.parseAsync(["node", "test", "install-skills", "--claude-dir", claudeDir]);

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("up to date");
	});

	it("does not throw and does not set exitCode on success", async () => {
		const claudeDir = path.join(tmpDir, ".claude");
		await fs.mkdir(claudeDir, { recursive: true });

		await program.parseAsync(["node", "test", "install-skills", "--claude-dir", claudeDir]);
		expect(process.exitCode).toBeUndefined();
	});
});
