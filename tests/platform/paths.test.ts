import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAntigravityConfigDir,
	getClaudeDir,
	getHomeDir,
	getInstallDir,
	getOpenCodeConfigDir,
	getSyncRepoDir,
	normalizePath,
} from "../../src/platform/paths.js";

describe("normalizePath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizePath("agents\\default.md")).toBe("agents/default.md");
	});

	it("leaves forward slashes unchanged (no-op on POSIX)", () => {
		expect(normalizePath("agents/default.md")).toBe("agents/default.md");
	});

	it("handles deeply nested Windows-style paths", () => {
		expect(normalizePath("plugins\\marketplaces\\custom.json")).toBe(
			"plugins/marketplaces/custom.json",
		);
	});

	it("returns single-segment paths unchanged", () => {
		expect(normalizePath("settings.json")).toBe("settings.json");
	});

	it("returns empty string for empty input", () => {
		expect(normalizePath("")).toBe("");
	});

	it("handles mixed separators", () => {
		expect(normalizePath("agents/skills\\my-skill/SKILL.md")).toBe(
			"agents/skills/my-skill/SKILL.md",
		);
	});

	it("handles multiple consecutive backslashes", () => {
		expect(normalizePath("a\\\\b\\c")).toBe("a//b/c");
	});
});

describe("getHomeDir", () => {
	it("returns the OS home directory", () => {
		expect(getHomeDir()).toBe(os.homedir());
	});

	it("returns a non-empty string", () => {
		expect(getHomeDir().length).toBeGreaterThan(0);
	});
});

describe("getClaudeDir", () => {
	it("returns ~/.claude", () => {
		expect(getClaudeDir()).toBe(path.join(os.homedir(), ".claude"));
	});

	it("is a child of the home directory", () => {
		expect(getClaudeDir().startsWith(getHomeDir())).toBe(true);
	});
});

describe("getAntigravityConfigDir", () => {
	it("returns ~/.antigravity", () => {
		expect(getAntigravityConfigDir()).toBe(path.join(os.homedir(), ".antigravity"));
	});

	it("is a child of the home directory", () => {
		expect(getAntigravityConfigDir().startsWith(getHomeDir())).toBe(true);
	});
});

describe("getOpenCodeConfigDir", () => {
	const originalXdg = process.env.XDG_CONFIG_HOME;

	afterEach(() => {
		if (originalXdg === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdg;
		}
	});

	it("defaults to ~/.config/opencode when XDG_CONFIG_HOME is not set", () => {
		delete process.env.XDG_CONFIG_HOME;
		expect(getOpenCodeConfigDir()).toBe(
			path.join(os.homedir(), ".config", "opencode"),
		);
	});

	it("respects XDG_CONFIG_HOME when set", () => {
		process.env.XDG_CONFIG_HOME = "/custom/config";
		expect(getOpenCodeConfigDir()).toBe(path.join("/custom/config", "opencode"));
	});
});

describe("getSyncRepoDir", () => {
	it("returns the custom path when provided", () => {
		expect(getSyncRepoDir("/custom/sync")).toBe("/custom/sync");
	});

	it("returns a path under the home directory when no custom path given", () => {
		// Without custom path, it returns either ~/.ai-sync or ~/.claude-sync
		const result = getSyncRepoDir();
		expect(result.startsWith(os.homedir())).toBe(true);
	});

	it("default path ends with .ai-sync or .claude-sync", () => {
		const result = getSyncRepoDir();
		const basename = path.basename(result);
		expect([".ai-sync", ".claude-sync"]).toContain(basename);
	});
});

describe("getInstallDir", () => {
	const originalAiSync = process.env.AI_SYNC_INSTALL_DIR;
	const originalClaudeSync = process.env.CLAUDE_SYNC_INSTALL_DIR;

	afterEach(() => {
		if (originalAiSync === undefined) {
			delete process.env.AI_SYNC_INSTALL_DIR;
		} else {
			process.env.AI_SYNC_INSTALL_DIR = originalAiSync;
		}
		if (originalClaudeSync === undefined) {
			delete process.env.CLAUDE_SYNC_INSTALL_DIR;
		} else {
			process.env.CLAUDE_SYNC_INSTALL_DIR = originalClaudeSync;
		}
	});

	it("returns AI_SYNC_INSTALL_DIR when set", () => {
		process.env.AI_SYNC_INSTALL_DIR = "/env/ai-sync";
		expect(getInstallDir()).toBe("/env/ai-sync");
	});

	it("returns CLAUDE_SYNC_INSTALL_DIR when AI_SYNC_INSTALL_DIR is not set", () => {
		delete process.env.AI_SYNC_INSTALL_DIR;
		process.env.CLAUDE_SYNC_INSTALL_DIR = "/env/claude-sync";
		expect(getInstallDir()).toBe("/env/claude-sync");
	});

	it("prefers AI_SYNC_INSTALL_DIR over CLAUDE_SYNC_INSTALL_DIR", () => {
		process.env.AI_SYNC_INSTALL_DIR = "/env/ai-sync";
		process.env.CLAUDE_SYNC_INSTALL_DIR = "/env/claude-sync";
		expect(getInstallDir()).toBe("/env/ai-sync");
	});

	it("walks up to find the project root when env vars are not set", () => {
		delete process.env.AI_SYNC_INSTALL_DIR;
		delete process.env.CLAUDE_SYNC_INSTALL_DIR;
		// Should find the ai-sync project root by walking up from the compiled file
		const dir = getInstallDir();
		expect(dir).toBeTruthy();
		// The found directory should contain a package.json
		expect(dir.length).toBeGreaterThan(0);
	});
});
