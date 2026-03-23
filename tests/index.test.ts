import { describe, expect, it } from "vitest";
import {
	ALL_ENVIRONMENTS,
	ClaudeEnvironment,
	CodexEnvironment,
	DEFAULT_SYNC_TARGETS,
	OpenCodeEnvironment,
	PLUGIN_IGNORE_PATTERNS,
	PLUGIN_SYNC_PATTERNS,
	createBackup,
	expandPathsForLocal,
	getClaudeDir,
	getCodexConfigDir,
	getEnvironmentById,
	getHomeDir,
	getInstallDir,
	getOpenCodeConfigDir,
	getSyncRepoDir,
	handleBootstrap,
	installSkills,
	isPathAllowed,
	makeAllowlistFn,
	needsPathRewrite,
	normalizePath,
	rewritePathsForRepo,
	scanDirectory,
	syncPull,
	syncPush,
	syncStatus,
	addFiles,
	addRemote,
	commitFiles,
	fetchRemote,
	getRemotes,
	getStatus,
	hasRemote,
	initRepo,
	isGitRepo,
	pullFromRemote,
	pushToRemote,
	writeGitattributes,
	detectRepoVersion,
	migrateToV2,
	getEnabledEnvironmentInstances,
	getEnabledEnvironments,
	isAutoDetecting,
	resetEnvironmentConfig,
	setEnabledEnvironments,
	performUpdate,
	startupUpdateCheck,
} from "../src/index.js";

describe("barrel exports (src/index.ts)", () => {
	describe("core/env-helpers exports", () => {
		it("exports makeAllowlistFn as a function", () => {
			expect(typeof makeAllowlistFn).toBe("function");
		});

		it("exports needsPathRewrite as a function", () => {
			expect(typeof needsPathRewrite).toBe("function");
		});
	});

	describe("core/environment exports", () => {
		it("exports ClaudeEnvironment as a function (class)", () => {
			expect(typeof ClaudeEnvironment).toBe("function");
		});

		it("exports OpenCodeEnvironment as a function (class)", () => {
			expect(typeof OpenCodeEnvironment).toBe("function");
		});

		it("exports CodexEnvironment as a function (class)", () => {
			expect(typeof CodexEnvironment).toBe("function");
		});

		it("exports ALL_ENVIRONMENTS as an array", () => {
			expect(Array.isArray(ALL_ENVIRONMENTS)).toBe(true);
			expect(ALL_ENVIRONMENTS.length).toBeGreaterThan(0);
		});

		it("exports getEnvironmentById as a function", () => {
			expect(typeof getEnvironmentById).toBe("function");
		});
	});

	describe("core/manifest exports", () => {
		it("exports DEFAULT_SYNC_TARGETS as an array", () => {
			expect(Array.isArray(DEFAULT_SYNC_TARGETS)).toBe(true);
			expect(DEFAULT_SYNC_TARGETS.length).toBeGreaterThan(0);
		});

		it("exports PLUGIN_SYNC_PATTERNS as an array", () => {
			expect(Array.isArray(PLUGIN_SYNC_PATTERNS)).toBe(true);
		});

		it("exports PLUGIN_IGNORE_PATTERNS as an array", () => {
			expect(Array.isArray(PLUGIN_IGNORE_PATTERNS)).toBe(true);
		});

		it("exports isPathAllowed as a function", () => {
			expect(typeof isPathAllowed).toBe("function");
		});
	});

	describe("core/sync-engine exports", () => {
		it("exports syncPush as a function", () => {
			expect(typeof syncPush).toBe("function");
		});

		it("exports syncPull as a function", () => {
			expect(typeof syncPull).toBe("function");
		});

		it("exports syncStatus as a function", () => {
			expect(typeof syncStatus).toBe("function");
		});
	});

	describe("core/backup exports", () => {
		it("exports createBackup as a function", () => {
			expect(typeof createBackup).toBe("function");
		});
	});

	describe("core/path-rewriter exports", () => {
		it("exports expandPathsForLocal as a function", () => {
			expect(typeof expandPathsForLocal).toBe("function");
		});

		it("exports rewritePathsForRepo as a function", () => {
			expect(typeof rewritePathsForRepo).toBe("function");
		});
	});

	describe("core/scanner exports", () => {
		it("exports scanDirectory as a function", () => {
			expect(typeof scanDirectory).toBe("function");
		});
	});

	describe("core/skills exports", () => {
		it("exports installSkills as a function", () => {
			expect(typeof installSkills).toBe("function");
		});
	});

	describe("core/migration exports", () => {
		it("exports detectRepoVersion as a function", () => {
			expect(typeof detectRepoVersion).toBe("function");
		});

		it("exports migrateToV2 as a function", () => {
			expect(typeof migrateToV2).toBe("function");
		});
	});

	describe("core/env-config exports", () => {
		it("exports getEnabledEnvironmentInstances as a function", () => {
			expect(typeof getEnabledEnvironmentInstances).toBe("function");
		});

		it("exports getEnabledEnvironments as a function", () => {
			expect(typeof getEnabledEnvironments).toBe("function");
		});

		it("exports isAutoDetecting as a function", () => {
			expect(typeof isAutoDetecting).toBe("function");
		});

		it("exports resetEnvironmentConfig as a function", () => {
			expect(typeof resetEnvironmentConfig).toBe("function");
		});

		it("exports setEnabledEnvironments as a function", () => {
			expect(typeof setEnabledEnvironments).toBe("function");
		});
	});

	describe("core/updater exports", () => {
		it("exports performUpdate as a function", () => {
			expect(typeof performUpdate).toBe("function");
		});

		it("exports startupUpdateCheck as a function", () => {
			expect(typeof startupUpdateCheck).toBe("function");
		});
	});

	describe("cli/commands/bootstrap exports", () => {
		it("exports handleBootstrap as a function", () => {
			expect(typeof handleBootstrap).toBe("function");
		});
	});

	describe("git/repo exports", () => {
		it("exports git functions", () => {
			expect(typeof addFiles).toBe("function");
			expect(typeof addRemote).toBe("function");
			expect(typeof commitFiles).toBe("function");
			expect(typeof fetchRemote).toBe("function");
			expect(typeof getRemotes).toBe("function");
			expect(typeof getStatus).toBe("function");
			expect(typeof hasRemote).toBe("function");
			expect(typeof initRepo).toBe("function");
			expect(typeof isGitRepo).toBe("function");
			expect(typeof pullFromRemote).toBe("function");
			expect(typeof pushToRemote).toBe("function");
			expect(typeof writeGitattributes).toBe("function");
		});
	});

	describe("platform/paths exports", () => {
		it("exports path utility functions", () => {
			expect(typeof getClaudeDir).toBe("function");
			expect(typeof getCodexConfigDir).toBe("function");
			expect(typeof getHomeDir).toBe("function");
			expect(typeof getInstallDir).toBe("function");
			expect(typeof getOpenCodeConfigDir).toBe("function");
			expect(typeof getSyncRepoDir).toBe("function");
			expect(typeof normalizePath).toBe("function");
		});
	});
});
