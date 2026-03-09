export type { BootstrapOptions, BootstrapResult } from "./cli/commands/bootstrap.js";
export { handleBootstrap } from "./cli/commands/bootstrap.js";
export { createBackup } from "./core/backup.js";
export {
	DEFAULT_SYNC_TARGETS,
	isPathAllowed,
	PLUGIN_IGNORE_PATTERNS,
	PLUGIN_SYNC_PATTERNS,
} from "./core/manifest.js";
export { expandPathsForLocal, rewritePathsForRepo } from "./core/path-rewriter.js";
export { scanDirectory } from "./core/scanner.js";
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
export { getClaudeDir, getHomeDir, getSyncRepoDir, normalizePath } from "./platform/paths.js";
export type { InstallSkillsResult } from "./core/skills.js";
export { installSkills } from "./core/skills.js";
export type { UpdateResult } from "./core/updater.js";
export { getInstallDir, performUpdate, startupUpdateCheck } from "./core/updater.js";
