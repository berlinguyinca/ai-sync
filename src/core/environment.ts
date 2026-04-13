import * as os from "node:os";
import * as path from "node:path";
import { getCodexConfigDir } from "../platform/paths.js";

/**
 * Represents an AI tool environment (e.g., Claude Code, OpenCode) whose
 * configuration can be synced across machines.
 */
export interface Environment {
	/** Unique identifier used as subdirectory name in the sync repo. */
	id: string;
	/** Human-readable name for CLI output. */
	displayName: string;
	/** Returns the absolute path to the tool's config directory. */
	getConfigDir(): string;
	/** Files and directories to sync (same format as DEFAULT_SYNC_TARGETS). */
	getSyncTargets(): readonly string[];
	/** Additional plugin sync patterns. */
	getPluginSyncPatterns(): readonly string[];
	/** Patterns to explicitly exclude from sync. */
	getIgnorePatterns(): readonly string[];
	/** Files that need {{HOME}} path rewriting. */
	getPathRewriteTargets(): string[];
	/** Subdirectory name for slash-command skills, or null if not supported. */
	getSkillsSubdir(): string | null;
}

/**
 * Optional capability for environments that support fragment-based config files.
 * Use isFragmentCapable() type guard to check at runtime.
 */
export interface FragmentCapable {
	getFragmentDirs(): string[];
	getIndexFile(): string;
}

export function isFragmentCapable(env: Environment): env is Environment & FragmentCapable {
	return "getFragmentDirs" in env && "getIndexFile" in env;
}

/**
 * Claude Code environment — config lives at ~/.claude
 */
export class ClaudeEnvironment implements Environment, FragmentCapable {
	readonly id = "claude";
	readonly displayName = "Claude Code";

	getConfigDir(): string {
		return path.join(os.homedir(), ".claude");
	}

	getSyncTargets(): readonly string[] {
		return [
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
	}

	getPluginSyncPatterns(): readonly string[] {
		return [
			"plugins/blocklist.json",
			"plugins/known_marketplaces.json",
			"plugins/marketplaces/",
			"plugins/installed_plugins.json",
			"plugins/cache/",
			"plugins/data/",
		];
	}

	getIgnorePatterns(): readonly string[] {
		return ["plugins/install-counts-cache.json"];
	}

	getPathRewriteTargets(): string[] {
		return ["settings.json", "installed_plugins.json", "known_marketplaces.json"];
	}

	getSkillsSubdir(): string | null {
		return "commands";
	}

	getFragmentDirs(): string[] {
		return ["shared/", "claude/orchestration/"];
	}

	getIndexFile(): string {
		return "CLAUDE.md";
	}
}

/**
 * Codex environment — config lives at CODEX_HOME or ~/.codex
 */
export class CodexEnvironment implements Environment {
	readonly id = "codex";
	readonly displayName = "Codex";

	getConfigDir(): string {
		return getCodexConfigDir();
	}

	getSyncTargets(): readonly string[] {
		return ["config.toml", "automations/"];
	}

	getPluginSyncPatterns(): readonly string[] {
		return [];
	}

	getIgnorePatterns(): readonly string[] {
		return [];
	}

	getPathRewriteTargets(): string[] {
		return ["config.toml"];
	}

	getSkillsSubdir(): string | null {
		return null;
	}
}

/**
 * OpenCode environment — config lives at ~/.config/opencode/ (respects XDG_CONFIG_HOME)
 */
export class OpenCodeEnvironment implements Environment {
	readonly id = "opencode";
	readonly displayName = "OpenCode";

	getConfigDir(): string {
		const xdgConfig = process.env.XDG_CONFIG_HOME;
		const base = xdgConfig || path.join(os.homedir(), ".config");
		return path.join(base, "opencode");
	}

	getSyncTargets(): readonly string[] {
		return [
			"opencode.json",
			"settings.json",
			"agents/",
			"command/",
			"hooks/",
			"get-shit-done/",
			"package.json",
			"gsd-file-manifest.json",
		];
	}

	getPluginSyncPatterns(): readonly string[] {
		return [];
	}

	getIgnorePatterns(): readonly string[] {
		return [];
	}

	getPathRewriteTargets(): string[] {
		return ["opencode.json"];
	}

	getSkillsSubdir(): string | null {
		return "command";
	}
}

/**
 * Google Antigravity environment — config lives at ~/.antigravity
 */
export class AntigravityEnvironment implements Environment {
	readonly id = "antigravity";
	readonly displayName = "Antigravity";

	getConfigDir(): string {
		return path.join(os.homedir(), ".antigravity");
	}

	getSyncTargets(): readonly string[] {
		return ["settings.json", "agents/", "commands/", "extensions/"];
	}

	getPluginSyncPatterns(): readonly string[] {
		return [];
	}

	getIgnorePatterns(): readonly string[] {
		return [];
	}

	getPathRewriteTargets(): string[] {
		return ["settings.json"];
	}

	getSkillsSubdir(): string | null {
		return "commands";
	}
}

/** All known environments. */
export const ALL_ENVIRONMENTS: readonly Environment[] = [
	new ClaudeEnvironment(),
	new CodexEnvironment(),
	new OpenCodeEnvironment(),
	new AntigravityEnvironment(),
];

/** Look up an environment by its id. */
export function getEnvironmentById(id: string): Environment | undefined {
	return ALL_ENVIRONMENTS.find((e) => e.id === id);
}
