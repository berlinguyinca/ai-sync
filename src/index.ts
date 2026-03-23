export type { BootstrapOptions, BootstrapResult } from "./cli/commands/bootstrap.js";
export { handleBootstrap } from "./cli/commands/bootstrap.js";
export { createBackup } from "./core/backup.js";
export {
	getEnabledEnvironmentInstances,
	getEnabledEnvironments,
	isAutoDetecting,
	resetEnvironmentConfig,
	setEnabledEnvironments,
} from "./core/env-config.js";
export { makeAllowlistFn, needsPathRewrite } from "./core/env-helpers.js";
export type { Environment } from "./core/environment.js";
export {
	ALL_ENVIRONMENTS,
	ClaudeEnvironment,
	CodexEnvironment,
	getEnvironmentById,
	OpenCodeEnvironment,
} from "./core/environment.js";
export {
	DEFAULT_SYNC_TARGETS,
	isPathAllowed,
	PLUGIN_IGNORE_PATTERNS,
	PLUGIN_SYNC_PATTERNS,
} from "./core/manifest.js";
export type { MigrateResult } from "./core/migration.js";
export { detectRepoVersion, migrateToV2 } from "./core/migration.js";
export { expandPathsForLocal, rewritePathsForRepo } from "./core/path-rewriter.js";
export { scanDirectory } from "./core/scanner.js";
export type { InstallSkillsResult } from "./core/skills.js";
export { installSkills } from "./core/skills.js";
export type {
	FileChange,
	SyncOptions,
	SyncPullResult,
	SyncPushResult,
	SyncStatusResult,
} from "./core/sync-engine.js";
export {
	syncPull,
	syncPush,
	syncStatus,
} from "./core/sync-engine.js";
export type { UpdateResult } from "./core/updater.js";
export { performUpdate, startupUpdateCheck } from "./core/updater.js";
export {
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
} from "./git/repo.js";
export {
	getClaudeDir,
	getCodexConfigDir,
	getHomeDir,
	getInstallDir,
	getOpenCodeConfigDir,
	getSyncRepoDir,
	normalizePath,
} from "./platform/paths.js";
