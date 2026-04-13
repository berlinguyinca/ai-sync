import { describe, expect, it } from "vitest";
import { makeAllowlistFn, needsPathRewrite } from "../../src/core/env-helpers.js";
import {
	AntigravityEnvironment,
	ClaudeEnvironment,
	CodexEnvironment,
	OpenCodeEnvironment,
} from "../../src/core/environment.js";

describe("makeAllowlistFn", () => {
	describe("ClaudeEnvironment", () => {
		const env = new ClaudeEnvironment();
		const isAllowed = makeAllowlistFn(env);

		it("allows exact sync targets", () => {
			expect(isAllowed("settings.json")).toBe(true);
			expect(isAllowed("CLAUDE.md")).toBe(true);
			expect(isAllowed("package.json")).toBe(true);
			expect(isAllowed("gsd-file-manifest.json")).toBe(true);
			expect(isAllowed("keybindings.json")).toBe(true);
		});

		it("allows files under directory sync targets", () => {
			expect(isAllowed("agents/default.md")).toBe(true);
			expect(isAllowed("commands/my-cmd.md")).toBe(true);
			expect(isAllowed("hooks/pre-push.sh")).toBe(true);
			expect(isAllowed("get-shit-done/focus.json")).toBe(true);
			expect(isAllowed("skills/my-skill/SKILL.md")).toBe(true);
			expect(isAllowed("rules/custom-rule.md")).toBe(true);
		});

		it("allows plugin sync patterns", () => {
			expect(isAllowed("plugins/blocklist.json")).toBe(true);
			expect(isAllowed("plugins/known_marketplaces.json")).toBe(true);
			expect(isAllowed("plugins/installed_plugins.json")).toBe(true);
			expect(isAllowed("plugins/marketplaces/custom.json")).toBe(true);
			expect(isAllowed("plugins/cache/some-cache.json")).toBe(true);
			expect(isAllowed("plugins/data/some-data.json")).toBe(true);
		});

		it("rejects ignored patterns even if they match plugin patterns", () => {
			expect(isAllowed("plugins/install-counts-cache.json")).toBe(false);
		});

		it("rejects unknown files", () => {
			expect(isAllowed("random-file.txt")).toBe(false);
			expect(isAllowed(".env")).toBe(false);
			expect(isAllowed("credentials.json")).toBe(false);
			expect(isAllowed("plugins/unknown-plugin.json")).toBe(false);
		});

		it("allows files under fragment dirs (FragmentCapable)", () => {
			expect(isAllowed("shared/standards/tdd.md")).toBe(true);
			expect(isAllowed("claude/orchestration/agents.md")).toBe(true);
		});
	});

	describe("CodexEnvironment", () => {
		const codexEnv = new CodexEnvironment();
		const isAllowed = makeAllowlistFn(codexEnv);

		it("allows codex-specific sync targets", () => {
			expect(isAllowed("config.toml")).toBe(true);
			expect(isAllowed("automations/my-automation.toml")).toBe(true);
		});

		it("does not allow fragment dir paths (not FragmentCapable)", () => {
			expect(isAllowed("shared/standards/tdd.md")).toBe(false);
			expect(isAllowed("claude/orchestration/agents.md")).toBe(false);
		});
	});

	describe("OpenCodeEnvironment", () => {
		const env = new OpenCodeEnvironment();
		const isAllowed = makeAllowlistFn(env);

		it("allows opencode-specific sync targets", () => {
			expect(isAllowed("opencode.json")).toBe(true);
			expect(isAllowed("settings.json")).toBe(true);
			expect(isAllowed("package.json")).toBe(true);
			expect(isAllowed("gsd-file-manifest.json")).toBe(true);
		});

		it("allows files under directory sync targets", () => {
			expect(isAllowed("agents/default.md")).toBe(true);
			expect(isAllowed("command/my-cmd.md")).toBe(true);
			expect(isAllowed("hooks/pre-push.sh")).toBe(true);
			expect(isAllowed("get-shit-done/focus.json")).toBe(true);
		});

		it("rejects claude-specific targets that opencode does not have", () => {
			expect(isAllowed("CLAUDE.md")).toBe(false);
			expect(isAllowed("keybindings.json")).toBe(false);
			expect(isAllowed("skills/my-skill/SKILL.md")).toBe(false);
			expect(isAllowed("rules/custom-rule.md")).toBe(false);
		});

		it("rejects plugin paths (opencode has no plugin patterns)", () => {
			expect(isAllowed("plugins/blocklist.json")).toBe(false);
			expect(isAllowed("plugins/marketplaces/custom.json")).toBe(false);
		});

		it("rejects unknown files", () => {
			expect(isAllowed("random-file.txt")).toBe(false);
		});
	});

	describe("AntigravityEnvironment", () => {
		const env = new AntigravityEnvironment();
		const isAllowed = makeAllowlistFn(env);

		it("allows antigravity-specific sync targets", () => {
			expect(isAllowed("settings.json")).toBe(true);
		});

		it("allows files under directory sync targets", () => {
			expect(isAllowed("agents/default.md")).toBe(true);
			expect(isAllowed("commands/my-cmd.md")).toBe(true);
			expect(isAllowed("extensions/my-ext.json")).toBe(true);
		});

		it("rejects claude-specific or opencode-specific targets", () => {
			expect(isAllowed("CLAUDE.md")).toBe(false);
			expect(isAllowed("opencode.json")).toBe(false);
			expect(isAllowed("keybindings.json")).toBe(false);
			expect(isAllowed("package.json")).toBe(false);
			expect(isAllowed("hooks/pre-push.sh")).toBe(false);
		});

		it("rejects plugin paths (antigravity has no plugin patterns)", () => {
			expect(isAllowed("plugins/blocklist.json")).toBe(false);
		});

		it("rejects unknown files", () => {
			expect(isAllowed("random-file.txt")).toBe(false);
		});
	});
});

describe("needsPathRewrite", () => {
	describe("ClaudeEnvironment", () => {
		const env = new ClaudeEnvironment();

		it("returns true for settings.json", () => {
			expect(needsPathRewrite("settings.json", env)).toBe(true);
		});

		it("returns true for installed_plugins.json under any directory", () => {
			expect(needsPathRewrite("plugins/installed_plugins.json", env)).toBe(true);
		});

		it("returns true for known_marketplaces.json under any directory", () => {
			expect(needsPathRewrite("plugins/known_marketplaces.json", env)).toBe(true);
		});

		it("returns false for files not in rewrite targets", () => {
			expect(needsPathRewrite("CLAUDE.md", env)).toBe(false);
			expect(needsPathRewrite("package.json", env)).toBe(false);
			expect(needsPathRewrite("agents/default.md", env)).toBe(false);
			expect(needsPathRewrite("keybindings.json", env)).toBe(false);
		});
	});

	describe("OpenCodeEnvironment", () => {
		const env = new OpenCodeEnvironment();

		it("returns true for opencode.json", () => {
			expect(needsPathRewrite("opencode.json", env)).toBe(true);
		});

		it("returns false for settings.json (not in opencode rewrite targets)", () => {
			expect(needsPathRewrite("settings.json", env)).toBe(false);
		});

		it("returns false for unrelated files", () => {
			expect(needsPathRewrite("agents/default.md", env)).toBe(false);
			expect(needsPathRewrite("package.json", env)).toBe(false);
		});
	});

	describe("AntigravityEnvironment", () => {
		const env = new AntigravityEnvironment();

		it("returns true for settings.json", () => {
			expect(needsPathRewrite("settings.json", env)).toBe(true);
		});

		it("returns false for other files", () => {
			expect(needsPathRewrite("agents/default.md", env)).toBe(false);
			expect(needsPathRewrite("commands/my-cmd.md", env)).toBe(false);
		});
	});

	it("matches based on basename, not full path", () => {
		const env = new ClaudeEnvironment();
		// "settings.json" is a rewrite target; a nested path with that basename should match
		expect(needsPathRewrite("some/nested/settings.json", env)).toBe(true);
		// "installed_plugins.json" basename match
		expect(needsPathRewrite("deep/path/installed_plugins.json", env)).toBe(true);
	});
});
