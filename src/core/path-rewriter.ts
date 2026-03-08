/**
 * Rewrites absolute home directory paths in content to portable {{HOME}} tokens.
 * Used when copying settings.json into the sync repo.
 *
 * @param content - The file content to process
 * @param homeDir - The absolute path to the home directory to replace
 * @returns Content with home directory paths replaced by {{HOME}}
 */
export function rewritePathsForRepo(content: string, homeDir: string): string {
	return content.replaceAll(homeDir, "{{HOME}}");
}

/**
 * Expands {{HOME}} tokens in content to the local home directory path.
 * Used when applying settings.json from the sync repo to the local machine.
 *
 * @param content - The file content to process
 * @param homeDir - The absolute path to the local home directory
 * @returns Content with {{HOME}} tokens replaced by the home directory
 */
export function expandPathsForLocal(content: string, homeDir: string): string {
	return content.replaceAll("{{HOME}}", homeDir);
}
