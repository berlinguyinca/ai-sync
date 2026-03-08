import * as fs from "node:fs/promises";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import type {
	StatusResult,
	PullResult,
	PushResult,
	FetchResult,
	RemoteWithRefs,
} from "simple-git";

/**
 * Initializes a new git repository at the specified path.
 * Sets the default branch to "main" for consistency across platforms.
 *
 * @param repoPath - Absolute path to the directory where the repo will be initialized
 * @throws Error if the directory does not exist
 */
export async function initRepo(repoPath: string): Promise<void> {
	// Verify directory exists
	try {
		await fs.access(repoPath);
	} catch {
		throw new Error(`Directory does not exist: ${repoPath}`);
	}

	// Use -b main to ensure consistent branch name across platforms
	// (some systems default to "master")
	await simpleGit(repoPath).init(["--initial-branch=main"]);
}

/**
 * Checks whether a directory is a git repository.
 *
 * @param dirPath - Absolute path to the directory to check
 * @returns true if the directory is a git repo, false otherwise
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
	try {
		return await simpleGit(dirPath).checkIsRepo();
	} catch {
		return false;
	}
}

/**
 * Stages specified files in the git repository.
 * Always uses explicit file paths -- never `git add .`.
 *
 * @param repoPath - Absolute path to the git repository
 * @param files - Array of relative file paths to stage
 */
export async function addFiles(
	repoPath: string,
	files: string[],
): Promise<void> {
	await simpleGit(repoPath).add(files);
}

/**
 * Creates a commit with the specified message.
 *
 * @param repoPath - Absolute path to the git repository
 * @param message - Commit message
 */
export async function commitFiles(
	repoPath: string,
	message: string,
): Promise<void> {
	await simpleGit(repoPath).commit(message);
}

/**
 * Writes a .gitattributes file enforcing LF line endings.
 *
 * @param repoPath - Absolute path to the directory where .gitattributes will be created
 */
export async function writeGitattributes(repoPath: string): Promise<void> {
	const content = [
		"* text=auto eol=lf",
		"*.json text eol=lf",
		"*.md text eol=lf",
		"*.js text eol=lf",
		"*.sh text eol=lf",
		"",
	].join("\n");

	await fs.writeFile(path.join(repoPath, ".gitattributes"), content);
}

/**
 * Pushes committed changes to a remote repository.
 *
 * @param repoPath - Absolute path to the git repository
 * @param remote - Remote name (defaults to "origin")
 * @param branch - Branch name (defaults to "main")
 * @returns PushResult with push details
 */
export async function pushToRemote(
	repoPath: string,
	remote = "origin",
	branch = "main",
): Promise<PushResult> {
	return simpleGit(repoPath).push(remote, branch);
}

/**
 * Pulls changes from a remote repository.
 *
 * @param repoPath - Absolute path to the git repository
 * @param remote - Remote name (defaults to "origin")
 * @param branch - Branch name (defaults to "main")
 * @returns PullResult with pull details
 */
export async function pullFromRemote(
	repoPath: string,
	remote = "origin",
	branch = "main",
): Promise<PullResult> {
	return simpleGit(repoPath).pull(remote, branch);
}

/**
 * Fetches from a remote without merging.
 *
 * @param repoPath - Absolute path to the git repository
 * @param remote - Remote name (defaults to "origin")
 * @returns FetchResult with fetch details
 */
export async function fetchRemote(
	repoPath: string,
	remote = "origin",
): Promise<FetchResult> {
	return simpleGit(repoPath).fetch(remote);
}

/**
 * Gets the current git status of the repository.
 *
 * @param repoPath - Absolute path to the git repository
 * @returns StatusResult with ahead, behind, modified, isClean, etc.
 */
export async function getStatus(repoPath: string): Promise<StatusResult> {
	return simpleGit(repoPath).status();
}

/**
 * Adds a named remote to the git repository.
 *
 * @param repoPath - Absolute path to the git repository
 * @param name - Name for the remote (e.g., "origin")
 * @param url - URL or path for the remote
 */
export async function addRemote(
	repoPath: string,
	name: string,
	url: string,
): Promise<void> {
	await simpleGit(repoPath).addRemote(name, url);
}

/**
 * Returns the list of configured remotes with their refs.
 *
 * @param repoPath - Absolute path to the git repository
 * @returns Array of remote objects with name and refs
 */
export async function getRemotes(
	repoPath: string,
): Promise<RemoteWithRefs[]> {
	return simpleGit(repoPath).getRemotes(true);
}

/**
 * Checks whether any remote is configured.
 *
 * @param repoPath - Absolute path to the git repository
 * @returns true if at least one remote is configured
 */
export async function hasRemote(repoPath: string): Promise<boolean> {
	const remotes = await getRemotes(repoPath);
	return remotes.length > 0;
}
