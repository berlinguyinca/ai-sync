import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	discoverPipTools,
	discoverPlugins,
	formatInstallSummary,
	generateInstallScript,
	installTool,
	preflightCheck,
	provision,
	verifyTool,
	writeManifest,
} from "../../src/core/provisioner.js";
import type { ToolEntry, ToolManifest } from "../../src/core/tool-manifest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecFn(
	responses: Record<string, { stdout?: string; stderr?: string; throws?: boolean }>,
) {
	return vi.fn(async (cmd: string, args: string[]) => {
		const key = [cmd, ...args].join(" ");
		// Try exact match first, then prefix match
		const entry = responses[key] ?? Object.entries(responses).find(([k]) => key.startsWith(k))?.[1];
		if (!entry) {
			throw new Error(`Unexpected exec call: ${key}`);
		}
		if (entry.throws) throw new Error(`exec failed: ${key}`);
		return { stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" };
	});
}

function makeToolEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
	return {
		name: "mytool",
		type: "pip",
		package: "mytool",
		postInstall: { type: "none" },
		verify: { type: "pip-package", name: "mytool" },
		required: true,
		...overrides,
	};
}

function makeManifest(tools: ToolEntry[], autoInstall = false): ToolManifest {
	return {
		version: 1,
		discoveredAt: "2025-01-01T00:00:00.000Z",
		sourcePlatform: "darwin",
		tools,
		autoInstall,
	};
}

// ---------------------------------------------------------------------------
// preflightCheck
// ---------------------------------------------------------------------------

describe("preflightCheck", () => {
	it("returns ok:true when all required managers are available", async () => {
		const execFn = makeExecFn({
			"which pip": { stdout: "/usr/bin/pip" },
			"which npm": { stdout: "/usr/bin/npm" },
		});

		const manifest = makeManifest([
			makeToolEntry({ type: "pip", verify: { type: "pip-package", name: "requests" } }),
			makeToolEntry({
				name: "typescript",
				type: "npm",
				verify: { type: "npm-package", name: "typescript" },
			}),
		]);

		const result = await preflightCheck(manifest, execFn);
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("returns ok:false with missing list when a manager is not found", async () => {
		const execFn = makeExecFn({
			"which pip": { throws: true },
			"which cargo": { throws: true },
		});

		const manifest = makeManifest([
			makeToolEntry({ type: "pip", verify: { type: "pip-package", name: "requests" } }),
			makeToolEntry({
				name: "rg",
				type: "cargo",
				package: "ripgrep",
				verify: { type: "cargo-crate", name: "ripgrep" },
			}),
		]);

		const result = await preflightCheck(manifest, execFn);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("pip");
		expect(result.missing).toContain("cargo");
	});

	it("returns ok:true for manifest with only system tools (no managers needed)", async () => {
		const execFn = makeExecFn({});

		const manifest = makeManifest([
			makeToolEntry({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			}),
		]);

		const result = await preflightCheck(manifest, execFn);
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// formatInstallSummary
// ---------------------------------------------------------------------------

describe("formatInstallSummary", () => {
	it("produces readable output with exact commands for pip tools", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "requests",
				type: "pip",
				package: "requests",
				verify: { type: "pip-package", name: "requests" },
			}),
		];
		const summary = formatInstallSummary(tools);
		expect(summary).toContain("requests");
		expect(summary).toContain("pip install requests");
	});

	it("produces readable output for cargo tools", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "rg",
				type: "cargo",
				package: "ripgrep",
				verify: { type: "cargo-crate", name: "ripgrep" },
			}),
		];
		const summary = formatInstallSummary(tools);
		expect(summary).toContain("cargo install ripgrep");
	});

	it("produces readable output for npm tools", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "ts",
				type: "npm",
				package: "typescript",
				verify: { type: "npm-package", name: "typescript" },
			}),
		];
		const summary = formatInstallSummary(tools);
		expect(summary).toContain("npm install -g typescript");
	});

	it("shows plugin instruction for claude-plugin tools", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "my-plugin",
				type: "claude-plugin",
				marketplace: "https://example.com",
				verify: { type: "binary-exists", name: "my-plugin" },
			}),
		];
		const summary = formatInstallSummary(tools);
		expect(summary).toContain("my-plugin");
		expect(summary).toContain("marketplace");
	});

	it("returns 'No tools to install.' for empty list", () => {
		expect(formatInstallSummary([])).toBe("No tools to install.");
	});
});

// ---------------------------------------------------------------------------
// installTool
// ---------------------------------------------------------------------------

describe("installTool", () => {
	it("calls pip install for pip tools", async () => {
		const execFn = makeExecFn({ "pip install requests": { stdout: "" } });
		const tool = makeToolEntry({
			name: "requests",
			type: "pip",
			package: "requests",
			verify: { type: "pip-package", name: "requests" },
		});
		await installTool(tool, execFn);
		expect(execFn).toHaveBeenCalledWith("pip", ["install", "requests"]);
	});

	it("calls cargo install for cargo tools", async () => {
		const execFn = makeExecFn({ "cargo install ripgrep": { stdout: "" } });
		const tool = makeToolEntry({
			name: "rg",
			type: "cargo",
			package: "ripgrep",
			verify: { type: "cargo-crate", name: "ripgrep" },
		});
		await installTool(tool, execFn);
		expect(execFn).toHaveBeenCalledWith("cargo", ["install", "ripgrep"]);
	});

	it("calls npm install -g for npm tools", async () => {
		const execFn = makeExecFn({ "npm install -g typescript": { stdout: "" } });
		const tool = makeToolEntry({
			name: "typescript",
			type: "npm",
			package: "typescript",
			verify: { type: "npm-package", name: "typescript" },
		});
		await installTool(tool, execFn);
		expect(execFn).toHaveBeenCalledWith("npm", ["install", "-g", "typescript"]);
	});

	it("does not call execFn for claude-plugin tools", async () => {
		const execFn = vi.fn();
		const tool = makeToolEntry({
			name: "my-plugin",
			type: "claude-plugin",
			verify: { type: "binary-exists", name: "my-plugin" },
		});
		await installTool(tool, execFn);
		expect(execFn).not.toHaveBeenCalled();
	});

	it("does not call execFn for system tools", async () => {
		const execFn = vi.fn();
		const tool = makeToolEntry({
			name: "git",
			type: "system",
			verify: { type: "binary-exists", name: "git" },
		});
		await installTool(tool, execFn);
		expect(execFn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// verifyTool
// ---------------------------------------------------------------------------

describe("verifyTool", () => {
	it("dispatches binary-exists via which", async () => {
		const execFn = makeExecFn({ "which git": { stdout: "/usr/bin/git" } });
		const tool = makeToolEntry({
			name: "git",
			type: "system",
			verify: { type: "binary-exists", name: "git" },
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(true);
		expect(execFn).toHaveBeenCalledWith("which", ["git"]);
	});

	it("returns false for binary-exists when which fails", async () => {
		const execFn = makeExecFn({ "which notfound": { throws: true } });
		const tool = makeToolEntry({
			name: "notfound",
			type: "system",
			verify: { type: "binary-exists", name: "notfound" },
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(false);
	});

	it("dispatches command-output and checks expectContains", async () => {
		const execFn = makeExecFn({ "node --version": { stdout: "v22.0.0" } });
		const tool = makeToolEntry({
			name: "node",
			type: "system",
			verify: {
				type: "command-output",
				command: "node",
				args: ["--version"],
				expectContains: "v22",
			},
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(true);
	});

	it("returns false for command-output when expectContains not found", async () => {
		const execFn = makeExecFn({ "node --version": { stdout: "v20.0.0" } });
		const tool = makeToolEntry({
			name: "node",
			type: "system",
			verify: {
				type: "command-output",
				command: "node",
				args: ["--version"],
				expectContains: "v22",
			},
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(false);
	});

	it("dispatches pip-package via pip show", async () => {
		const execFn = makeExecFn({
			"pip show requests": { stdout: "Name: requests\nVersion: 2.31.0\n" },
		});
		const tool = makeToolEntry({
			name: "requests",
			type: "pip",
			package: "requests",
			verify: { type: "pip-package", name: "requests" },
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(true);
		expect(execFn).toHaveBeenCalledWith("pip", ["show", "requests"]);
	});

	it("dispatches npm-package via npm list -g", async () => {
		const execFn = makeExecFn({
			"npm list -g typescript": { stdout: "/usr/local/lib\n└── typescript@5.0.0\n" },
		});
		const tool = makeToolEntry({
			name: "typescript",
			type: "npm",
			package: "typescript",
			verify: { type: "npm-package", name: "typescript" },
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(true);
		expect(execFn).toHaveBeenCalledWith("npm", ["list", "-g", "typescript"]);
	});

	it("returns false when verify command throws", async () => {
		const execFn = makeExecFn({ "pip show missing": { throws: true } });
		const tool = makeToolEntry({
			name: "missing",
			type: "pip",
			package: "missing",
			verify: { type: "pip-package", name: "missing" },
		});
		const ok = await verifyTool(tool, execFn);
		expect(ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// provision — autoInstall: false
// ---------------------------------------------------------------------------

describe("provision with autoInstall:false", () => {
	it("returns commands without executing any installs", async () => {
		const execFn = vi.fn();
		const manifest = makeManifest([
			makeToolEntry({
				name: "requests",
				type: "pip",
				package: "requests",
				verify: { type: "pip-package", name: "requests" },
			}),
		]);

		const result = await provision({
			manifest,
			autoInstall: false,
			execFn,
			backupDir: "/tmp/backup",
		});

		expect(result.commands).toContain("pip install requests");
		expect(result.installed).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(execFn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// provision — autoInstall: true, confirm, install, verify
// ---------------------------------------------------------------------------

describe("provision with autoInstall:true", () => {
	it("calls confirmFn, installs, and verifies", async () => {
		const execFn = makeExecFn({
			"which pip": { stdout: "/usr/bin/pip" },
			"pip install requests": { stdout: "" },
			"pip show requests": { stdout: "Name: requests\nVersion: 2.31.0\n" },
		});
		const confirmFn = vi.fn(async () => true);
		const manifest = makeManifest([
			makeToolEntry({
				name: "requests",
				type: "pip",
				package: "requests",
				verify: { type: "pip-package", name: "requests" },
			}),
		]);

		const result = await provision({
			manifest,
			autoInstall: true,
			confirmFn,
			execFn,
			backupDir: "/tmp/backup",
		});

		expect(confirmFn).toHaveBeenCalledOnce();
		expect(result.installed).toHaveLength(1);
		expect(result.failed).toHaveLength(0);
		expect(result.rolledBack).toBe(false);
	});

	it("skips all tools when confirmFn returns false", async () => {
		const execFn = vi.fn();
		const confirmFn = vi.fn(async () => false);
		const manifest = makeManifest([
			makeToolEntry({
				name: "requests",
				type: "pip",
				package: "requests",
				verify: { type: "pip-package", name: "requests" },
			}),
		]);

		const result = await provision({
			manifest,
			autoInstall: true,
			confirmFn,
			execFn,
			backupDir: "/tmp/backup",
		});

		expect(result.skipped).toHaveLength(1);
		expect(result.installed).toHaveLength(0);
		expect(execFn).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// provision — rollback on failure
// ---------------------------------------------------------------------------

describe("provision rollback", () => {
	it("uninstalls previously installed tools when a later install fails", async () => {
		// tool-a installs successfully, tool-b fails
		const execFn = makeExecFn({
			"which pip": { stdout: "/usr/bin/pip" },
			"pip install tool-a": { stdout: "" },
			"pip show tool-a": { stdout: "Name: tool-a\nVersion: 1.0\n" },
			"pip install tool-b": { throws: true },
			"pip uninstall -y tool-a": { stdout: "" },
		});
		const confirmFn = vi.fn(async () => true);

		const toolA = makeToolEntry({
			name: "tool-a",
			package: "tool-a",
			verify: { type: "pip-package", name: "tool-a" },
		});
		const toolB = makeToolEntry({
			name: "tool-b",
			package: "tool-b",
			verify: { type: "pip-package", name: "tool-b" },
		});
		const manifest = makeManifest([toolA, toolB]);

		const result = await provision({
			manifest,
			autoInstall: true,
			confirmFn,
			execFn,
			backupDir: "/tmp/backup",
		});

		expect(result.rolledBack).toBe(true);
		expect(result.rollbackPartial).toBe(false);
		expect(execFn).toHaveBeenCalledWith("pip", ["uninstall", "-y", "tool-a"]);
	});

	it("sets rollbackPartial when an uninstall during rollback fails", async () => {
		const execFn = makeExecFn({
			"which pip": { stdout: "/usr/bin/pip" },
			"pip install tool-a": { stdout: "" },
			"pip show tool-a": { stdout: "Name: tool-a\nVersion: 1.0\n" },
			"pip install tool-b": { throws: true },
			"pip uninstall -y tool-a": { throws: true },
		});
		const confirmFn = vi.fn(async () => true);

		const toolA = makeToolEntry({
			name: "tool-a",
			package: "tool-a",
			verify: { type: "pip-package", name: "tool-a" },
		});
		const toolB = makeToolEntry({
			name: "tool-b",
			package: "tool-b",
			verify: { type: "pip-package", name: "tool-b" },
		});
		const manifest = makeManifest([toolA, toolB]);

		const result = await provision({
			manifest,
			autoInstall: true,
			confirmFn,
			execFn,
			backupDir: "/tmp/backup",
		});

		expect(result.rolledBack).toBe(true);
		expect(result.rollbackPartial).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// generateInstallScript
// ---------------------------------------------------------------------------

describe("generateInstallScript", () => {
	it("generates a valid shell script with install commands", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "requests",
				type: "pip",
				package: "requests",
				verify: { type: "pip-package", name: "requests" },
			}),
			makeToolEntry({
				name: "rg",
				type: "cargo",
				package: "ripgrep",
				verify: { type: "cargo-crate", name: "ripgrep" },
			}),
		];

		const script = generateInstallScript(tools);
		expect(script).toContain("#!/usr/bin/env bash");
		expect(script).toContain("set -euo pipefail");
		expect(script).toContain("pip install requests");
		expect(script).toContain("cargo install ripgrep");
	});

	it("includes comments for system and claude-plugin tools", () => {
		const tools: ToolEntry[] = [
			makeToolEntry({
				name: "my-plugin",
				type: "claude-plugin",
				verify: { type: "binary-exists", name: "my-plugin" },
			}),
			makeToolEntry({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			}),
		];

		const script = generateInstallScript(tools);
		expect(script).toContain("my-plugin");
		expect(script).toContain("git");
		// Should not contain actual install commands for these
		expect(script).not.toContain("pip install my-plugin");
		expect(script).not.toContain("apt install git");
	});
});

// ---------------------------------------------------------------------------
// discoverPipTools
// ---------------------------------------------------------------------------

describe("discoverPipTools", () => {
	it("parses pip show output and returns tool entries", async () => {
		const execFn = makeExecFn({
			"pip show requests": {
				stdout: "Name: requests\nVersion: 2.31.0\nSummary: HTTP library\n",
			},
		});

		const tools = await discoverPipTools(["requests"], execFn);
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("requests");
		expect(tools[0].type).toBe("pip");
		expect(tools[0].version).toBe("2.31.0");
		expect(tools[0].verify).toEqual({ type: "pip-package", name: "requests" });
	});

	it("skips packages that are not installed (pip show throws)", async () => {
		const execFn = makeExecFn({
			"pip show missing-pkg": { throws: true },
		});

		const tools = await discoverPipTools(["missing-pkg"], execFn);
		expect(tools).toHaveLength(0);
	});

	it("handles multiple packages", async () => {
		const execFn = makeExecFn({
			"pip show requests": { stdout: "Name: requests\nVersion: 2.31.0\n" },
			"pip show flask": { stdout: "Name: flask\nVersion: 3.0.0\n" },
		});

		const tools = await discoverPipTools(["requests", "flask"], execFn);
		expect(tools).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// discoverPlugins
// ---------------------------------------------------------------------------

describe("discoverPlugins", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "provisioner-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("reads installed_plugins.json and returns plugin entries", async () => {
		const plugins = [
			{ name: "my-plugin", marketplace: "https://example.com" },
			{ name: "another-plugin" },
		];
		await fs.writeFile(path.join(tmpDir, "installed_plugins.json"), JSON.stringify(plugins));

		const entries = await discoverPlugins(tmpDir);
		expect(entries).toHaveLength(2);
		expect(entries[0].name).toBe("my-plugin");
		expect(entries[0].type).toBe("claude-plugin");
		expect(entries[0].marketplace).toBe("https://example.com");
		expect(entries[1].name).toBe("another-plugin");
	});

	it("returns empty array when installed_plugins.json does not exist", async () => {
		const entries = await discoverPlugins(tmpDir);
		expect(entries).toHaveLength(0);
	});

	it("returns empty array when installed_plugins.json contains invalid JSON", async () => {
		await fs.writeFile(path.join(tmpDir, "installed_plugins.json"), "not-json{{{");
		const entries = await discoverPlugins(tmpDir);
		expect(entries).toHaveLength(0);
	});

	it("returns empty array when installed_plugins.json is not an array", async () => {
		await fs.writeFile(
			path.join(tmpDir, "installed_plugins.json"),
			JSON.stringify({ name: "plugin" }),
		);
		const entries = await discoverPlugins(tmpDir);
		expect(entries).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

describe("writeManifest", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "provisioner-manifest-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("writes valid JSON to tools/manifest.json in the sync repo dir", async () => {
		const manifest = makeManifest([
			makeToolEntry({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			}),
		]);

		await writeManifest(manifest, tmpDir);

		const manifestPath = path.join(tmpDir, "tools", "manifest.json");
		const raw = await fs.readFile(manifestPath, "utf-8");
		const parsed = JSON.parse(raw) as ToolManifest;

		expect(parsed.version).toBe(1);
		expect(parsed.tools).toHaveLength(1);
		expect(parsed.tools[0].name).toBe("git");
	});

	it("creates the tools/ directory if it does not exist", async () => {
		const manifest = makeManifest([]);
		await writeManifest(manifest, tmpDir);
		const stat = await fs.stat(path.join(tmpDir, "tools"));
		expect(stat.isDirectory()).toBe(true);
	});
});
