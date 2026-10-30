import { describe, expect, it } from "vitest";
import {
	DEFAULT_SYNC_TARGETS,
	isPathAllowed,
	isPathIgnored,
	isRepoLevelPathAllowed,
	PLUGIN_IGNORE_PATTERNS,
	PLUGIN_SYNC_PATTERNS,
	REPO_LEVEL_SYNC_TARGETS,
} from "../../src/core/manifest.js";

describe("manifest", () => {
	describe("DEFAULT_SYNC_TARGETS", () => {
		it("contains exactly 11 sync targets", () => {
			expect(DEFAULT_SYNC_TARGETS).toHaveLength(11);
		});

		it("contains the expected sync targets", () => {
			const expected = [
				"settings.json",
				"CLAUDE.md",
				"agents/",
				"commands/",
				"hooks/",
				"get-shit-done/",
				"package.json",
				"gsd-file-manifest.json",
				"skills/",
				"rules/",
				"keybindings.json",
			];
			expect([...DEFAULT_SYNC_TARGETS].sort()).toEqual([...expected].sort());
		});
	});

	describe("PLUGIN_SYNC_PATTERNS", () => {
		it("contains 6 plugin sync patterns", () => {
			expect(PLUGIN_SYNC_PATTERNS).toHaveLength(6);
		});

		it("contains the expected plugin sync patterns", () => {
			const expected = [
				"plugins/blocklist.json",
				"plugins/known_marketplaces.json",
				"plugins/marketplaces/",
				"plugins/installed_plugins.json",
				"plugins/cache/",
				"plugins/data/",
			];
			expect([...PLUGIN_SYNC_PATTERNS].sort()).toEqual([...expected].sort());
		});
	});

	describe("PLUGIN_IGNORE_PATTERNS", () => {
		it("contains the plugin ignore pattern", () => {
			expect(PLUGIN_IGNORE_PATTERNS).toContain("plugins/install-counts-cache.json");
		});
	});

	describe("isPathAllowed", () => {
		it("allows settings.json", () => {
			expect(isPathAllowed("settings.json")).toBe(true);
		});

		it("allows CLAUDE.md", () => {
			expect(isPathAllowed("CLAUDE.md")).toBe(true);
		});

		it("allows nested files under allowed directories", () => {
			expect(isPathAllowed("agents/my-skill/SKILL.md")).toBe(true);
		});

		it("allows files under skills/ directory", () => {
			expect(isPathAllowed("skills/autoresearch/SKILL.md")).toBe(true);
		});

		it("allows files under rules/ directory", () => {
			expect(isPathAllowed("rules/context7.md")).toBe(true);
		});

		it("allows nested files under rules/ directory", () => {
			expect(isPathAllowed("rules/team/coding-standards.md")).toBe(true);
		});

		it("allows keybindings.json", () => {
			expect(isPathAllowed("keybindings.json")).toBe(true);
		});

		it("allows plugins/installed_plugins.json", () => {
			expect(isPathAllowed("plugins/installed_plugins.json")).toBe(true);
		});

		it("allows files under plugins/cache/ directory", () => {
			expect(
				isPathAllowed("plugins/cache/claude-plugins-official/superpowers/5.0.5/package.json"),
			).toBe(true);
		});

		it("rejects files in projects/ directory", () => {
			expect(isPathAllowed("projects/foo.md")).toBe(false);
		});

		it("rejects files in debug/ directory", () => {
			expect(isPathAllowed("debug/logs.txt")).toBe(false);
		});

		it("rejects files in telemetry/ directory", () => {
			expect(isPathAllowed("telemetry/data.json")).toBe(false);
		});

		it("allows plugin sync patterns", () => {
			expect(isPathAllowed("plugins/blocklist.json")).toBe(true);
		});

		it("rejects plugin ignore patterns", () => {
			expect(isPathAllowed("plugins/install-counts-cache.json")).toBe(false);
		});

		it("supports directory, basename and glob ignore patterns", () => {
			const t = ["a/", "b.json"];
			expect(isPathAllowed("a/x", t, [], ["a/skip/"])).toBe(true);
			expect(isPathAllowed("a/skip/x", t, [], ["a/skip/"])).toBe(false);
			expect(isPathAllowed("a/deep/b.json", t, [], ["b.json"])).toBe(false);
			expect(isPathAllowed("a/x.bak1", t, [], ["*.bak*"])).toBe(false);
			expect(isPathAllowed("a/x.txt", t, [], ["*.bak*"])).toBe(true);
			expect(isPathAllowed("a/orch-1/x", t, [], ["orch-*/"])).toBe(false);
		});

		it("matches single-segment directory patterns at any depth", () => {
			const t = ["a/"];
			expect(isPathAllowed("a/logs/x.log", t, [], ["logs/"])).toBe(false);
			expect(isPathAllowed("a/b/logs/x.log", t, [], ["logs/"])).toBe(false);
			expect(isPathAllowed("a/b/orch-9/x", t, [], ["orch-*/"])).toBe(false);
			expect(isPathAllowed("a/logs.txt", t, [], ["logs/"])).toBe(true);
		});

		it("anchors directory patterns with an inner slash at the config root", () => {
			const t = ["a/", "b/"];
			expect(isPathAllowed("a/skip/x", t, [], ["a/skip/"])).toBe(false);
			expect(isPathAllowed("b/a/skip/x", t, [], ["a/skip/"])).toBe(true);
		});

		it("matches ignore patterns case-insensitively", () => {
			const t = ["extensions/"];
			expect(isPathAllowed("extensions/Auth.json", t, [], ["auth.json"])).toBe(false);
			expect(isPathAllowed("extensions/x/engineering.YAML", t, [], ["engineering.yaml"])).toBe(
				false,
			);
			expect(isPathAllowed("extensions/Logs/a", t, [], ["logs/"])).toBe(false);
		});

		it("treats ? in ignore patterns literally", () => {
			const t = ["a/"];
			expect(isPathAllowed("a/x?.json", t, [], ["x?.json"])).toBe(false);
			expect(isPathAllowed("a/xy.json", t, [], ["x?.json"])).toBe(true);
		});

		it("allows files nested under plugin sync directories", () => {
			expect(isPathAllowed("plugins/marketplaces/some-repo/file.md")).toBe(true);
		});

		it("allows files under plugins/data/ directory", () => {
			expect(isPathAllowed("plugins/data/superpowers-claude-plugins-official/state.json")).toBe(
				true,
			);
		});

		it("rejects unknown directories", () => {
			expect(isPathAllowed("unknown-new-directory/file.txt")).toBe(false);
		});
	});

	describe("REPO_LEVEL_SYNC_TARGETS", () => {
		it("contains shared/ and tools/", () => {
			expect(REPO_LEVEL_SYNC_TARGETS).toContain("shared/");
			expect(REPO_LEVEL_SYNC_TARGETS).toContain("tools/");
		});
	});

	describe("isRepoLevelPathAllowed", () => {
		it("allows files nested under shared/", () => {
			expect(isRepoLevelPathAllowed("shared/standards/tdd.md")).toBe(true);
		});

		it("allows files nested under tools/", () => {
			expect(isRepoLevelPathAllowed("tools/manifest.json")).toBe(true);
		});

		it("rejects paths not in repo-level targets", () => {
			expect(isRepoLevelPathAllowed("random/file.txt")).toBe(false);
		});

		it("rejects paths that are prefix matches but not under a target dir", () => {
			expect(isRepoLevelPathAllowed("shared-other/file.txt")).toBe(false);
		});
	});

	describe("root-anchored ignore patterns", () => {
		it("matches only at the config root when the pattern starts with /", () => {
			expect(isPathIgnored("git/a", ["/git/"])).toBe(true);
			expect(isPathIgnored("git/x/b", ["/git/"])).toBe(true);
			expect(isPathIgnored("skills/git/a", ["/git/"])).toBe(false);
			expect(isPathIgnored("GIT/a", ["/git/"])).toBe(true);
			expect(isPathIgnored("git", ["/git/"])).toBe(false);
			expect(isPathIgnored("gitx/a", ["/git/"])).toBe(false);
		});

		it("anchors file patterns too", () => {
			expect(isPathIgnored("x.json", ["/x.json"])).toBe(true);
			expect(isPathIgnored("a/x.json", ["/x.json"])).toBe(false);
		});
	});
});
