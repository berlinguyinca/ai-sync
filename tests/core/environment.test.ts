import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ALL_ENVIRONMENTS,
	AntigravityEnvironment,
	ClaudeEnvironment,
	CodexEnvironment,
	getEnvironmentById,
	OpenCodeEnvironment,
} from "../../src/core/environment.js";

describe("environment", () => {
	describe("ClaudeEnvironment", () => {
		const claude = new ClaudeEnvironment();

		it("has id 'claude'", () => {
			expect(claude.id).toBe("claude");
		});

		it("has display name 'Claude Code'", () => {
			expect(claude.displayName).toBe("Claude Code");
		});

		it("config dir is ~/.claude", () => {
			expect(claude.getConfigDir()).toBe(path.join(os.homedir(), ".claude"));
		});

		it("has settings.json as sync target", () => {
			expect(claude.getSyncTargets()).toContain("settings.json");
		});

		it("has CLAUDE.md as sync target", () => {
			expect(claude.getSyncTargets()).toContain("CLAUDE.md");
		});

		it("has commands/ as sync target", () => {
			expect(claude.getSyncTargets()).toContain("commands/");
		});

		it("has skills/ as sync target", () => {
			expect(claude.getSyncTargets()).toContain("skills/");
		});

		it("has rules/ as sync target", () => {
			expect(claude.getSyncTargets()).toContain("rules/");
		});

		it("has keybindings.json as sync target", () => {
			expect(claude.getSyncTargets()).toContain("keybindings.json");
		});

		it("has plugin sync patterns", () => {
			expect(claude.getPluginSyncPatterns().length).toBeGreaterThan(0);
		});

		it("has installed_plugins.json in plugin sync patterns", () => {
			expect(claude.getPluginSyncPatterns()).toContain("plugins/installed_plugins.json");
		});

		it("has cache/ in plugin sync patterns", () => {
			expect(claude.getPluginSyncPatterns()).toContain("plugins/cache/");
		});

		it("has data/ in plugin sync patterns", () => {
			expect(claude.getPluginSyncPatterns()).toContain("plugins/data/");
		});

		it("has plugin ignore patterns", () => {
			expect(claude.getIgnorePatterns()).toContain("plugins/install-counts-cache.json");
		});

		it("path rewrite targets include settings.json", () => {
			expect(claude.getPathRewriteTargets()).toContain("settings.json");
		});

		it("path rewrite targets include installed_plugins.json", () => {
			expect(claude.getPathRewriteTargets()).toContain("installed_plugins.json");
		});

		it("path rewrite targets include known_marketplaces.json", () => {
			expect(claude.getPathRewriteTargets()).toContain("known_marketplaces.json");
		});

		it("skills subdir is 'commands'", () => {
			expect(claude.getSkillsSubdir()).toBe("commands");
		});
	});

	describe("OpenCodeEnvironment", () => {
		const opencode = new OpenCodeEnvironment();

		it("has id 'opencode'", () => {
			expect(opencode.id).toBe("opencode");
		});

		it("has display name 'OpenCode'", () => {
			expect(opencode.displayName).toBe("OpenCode");
		});

		it("config dir defaults to ~/.config/opencode", () => {
			const expected = path.join(
				process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
				"opencode",
			);
			expect(opencode.getConfigDir()).toBe(expected);
		});

		it("has opencode.json as sync target", () => {
			expect(opencode.getSyncTargets()).toContain("opencode.json");
		});

		it("has command/ (singular) as sync target", () => {
			expect(opencode.getSyncTargets()).toContain("command/");
		});

		it("does not have commands/ (plural) as sync target", () => {
			expect(opencode.getSyncTargets()).not.toContain("commands/");
		});

		it("has no plugin sync patterns", () => {
			expect(opencode.getPluginSyncPatterns()).toHaveLength(0);
		});

		it("has no ignore patterns", () => {
			expect(opencode.getIgnorePatterns()).toHaveLength(0);
		});

		it("path rewrite targets include opencode.json", () => {
			expect(opencode.getPathRewriteTargets()).toContain("opencode.json");
		});

		it("skills subdir is 'command' (singular)", () => {
			expect(opencode.getSkillsSubdir()).toBe("command");
		});
	});

	describe("CodexEnvironment", () => {
		const codex = new CodexEnvironment();
		const originalCodexHome = process.env.CODEX_HOME;

		afterEach(() => {
			if (originalCodexHome === undefined) {
				delete process.env.CODEX_HOME;
			} else {
				process.env.CODEX_HOME = originalCodexHome;
			}
		});

		it("has id 'codex'", () => {
			expect(codex.id).toBe("codex");
		});

		it("has display name 'Codex'", () => {
			expect(codex.displayName).toBe("Codex");
		});

		it("config dir defaults to ~/.codex", () => {
			delete process.env.CODEX_HOME;
			expect(codex.getConfigDir()).toBe(path.join(os.homedir(), ".codex"));
		});

		it("respects CODEX_HOME when set", () => {
			process.env.CODEX_HOME = "/custom/codex";
			expect(codex.getConfigDir()).toBe("/custom/codex");
		});

		it("has config.toml as sync target", () => {
			expect(codex.getSyncTargets()).toContain("config.toml");
		});

		it("has automations/ as sync target", () => {
			expect(codex.getSyncTargets()).toContain("automations/");
		});

		it("has no plugin sync patterns", () => {
			expect(codex.getPluginSyncPatterns()).toHaveLength(0);
		});

		it("has no ignore patterns", () => {
			expect(codex.getIgnorePatterns()).toHaveLength(0);
		});

		it("path rewrite targets include config.toml", () => {
			expect(codex.getPathRewriteTargets()).toContain("config.toml");
		});

		it("does not define a skills subdir", () => {
			expect(codex.getSkillsSubdir()).toBeNull();
		});
	});

	describe("AntigravityEnvironment", () => {
		const antigravity = new AntigravityEnvironment();

		it("has id 'antigravity'", () => {
			expect(antigravity.id).toBe("antigravity");
		});

		it("has display name 'Antigravity'", () => {
			expect(antigravity.displayName).toBe("Antigravity");
		});

		it("config dir is ~/.antigravity", () => {
			expect(antigravity.getConfigDir()).toBe(path.join(os.homedir(), ".antigravity"));
		});

		it("has settings.json as sync target", () => {
			expect(antigravity.getSyncTargets()).toContain("settings.json");
		});

		it("has agents/ as sync target", () => {
			expect(antigravity.getSyncTargets()).toContain("agents/");
		});

		it("has commands/ as sync target", () => {
			expect(antigravity.getSyncTargets()).toContain("commands/");
		});

		it("has extensions/ as sync target", () => {
			expect(antigravity.getSyncTargets()).toContain("extensions/");
		});

		it("has no plugin sync patterns", () => {
			expect(antigravity.getPluginSyncPatterns()).toHaveLength(0);
		});

		it("has no ignore patterns", () => {
			expect(antigravity.getIgnorePatterns()).toHaveLength(0);
		});

		it("path rewrite targets include settings.json", () => {
			expect(antigravity.getPathRewriteTargets()).toContain("settings.json");
		});

		it("skills subdir is 'commands'", () => {
			expect(antigravity.getSkillsSubdir()).toBe("commands");
		});
	});

	describe("ALL_ENVIRONMENTS", () => {
		it("contains claude, codex, opencode, and antigravity", () => {
			const ids = ALL_ENVIRONMENTS.map((e) => e.id);
			expect(ids).toContain("claude");
			expect(ids).toContain("codex");
			expect(ids).toContain("opencode");
			expect(ids).toContain("antigravity");
		});

		it("has exactly 4 environments", () => {
			expect(ALL_ENVIRONMENTS).toHaveLength(4);
		});
	});

	describe("getEnvironmentById", () => {
		it("returns claude environment for 'claude'", () => {
			const env = getEnvironmentById("claude");
			expect(env).toBeDefined();
			expect(env?.id).toBe("claude");
		});

		it("returns opencode environment for 'opencode'", () => {
			const env = getEnvironmentById("opencode");
			expect(env).toBeDefined();
			expect(env?.id).toBe("opencode");
		});

		it("returns codex environment for 'codex'", () => {
			const env = getEnvironmentById("codex");
			expect(env).toBeDefined();
			expect(env?.id).toBe("codex");
		});

		it("returns antigravity environment for 'antigravity'", () => {
			const env = getEnvironmentById("antigravity");
			expect(env).toBeDefined();
			expect(env?.id).toBe("antigravity");
		});

		it("returns undefined for unknown id", () => {
			expect(getEnvironmentById("unknown")).toBeUndefined();
		});
	});
});
