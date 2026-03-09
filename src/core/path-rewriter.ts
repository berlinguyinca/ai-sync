/**
 * Recursively walks a JSON value and applies a transform to every string leaf.
 * Returns a new value (does not mutate).
 */
function deepMapStrings(
	value: unknown,
	transform: (s: string) => string,
): unknown {
	if (typeof value === "string") {
		return transform(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => deepMapStrings(item, transform));
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value)) {
			result[key] = deepMapStrings(val, transform);
		}
		return result;
	}
	return value; // numbers, booleans, null
}

/**
 * Detects the indentation used in a JSON string.
 * Returns the indent argument for JSON.stringify (number of spaces or undefined for compact).
 */
function detectIndent(content: string): number | undefined {
	const match = content.match(/^[\t ]*\n([ \t]+)"/m);
	if (match) {
		return match[1].length;
	}
	// Check if it looks like pretty-printed JSON (has newlines between properties)
	if (content.includes("\n")) {
		return 2;
	}
	return undefined; // compact
}

/**
 * Rewrites absolute home directory paths in JSON content to portable {{HOME}} tokens.
 * Used when copying settings.json into the sync repo.
 *
 * Operates on parsed JSON values to avoid any interaction with JSON escaping.
 * Also normalizes Windows-style backslash separators to forward slashes in
 * {{HOME}}-prefixed paths for portable POSIX-style storage.
 *
 * @param content - The JSON file content to process
 * @param homeDir - The absolute path to the home directory to replace
 * @returns JSON content with home directory paths replaced by {{HOME}}
 */
export function rewritePathsForRepo(
	content: string,
	homeDir: string,
): string {
	try {
		const parsed = JSON.parse(content);
		const indent = detectIndent(content);

		// Build list of homeDir variants to replace (native, forward-slash)
		const variants = new Set<string>();
		variants.add(homeDir);
		if (homeDir.includes("\\")) {
			variants.add(homeDir.replaceAll("\\", "/"));
		}

		const rewritten = deepMapStrings(parsed, (s) => {
			let result = s;
			for (const variant of variants) {
				result = result.replaceAll(variant, "{{HOME}}");
			}
			// Normalize backslash path separators to forward slashes in
			// {{HOME}}-prefixed paths (Windows → POSIX portability).
			// e.g., {{HOME}}\.claude\hooks\test.js → {{HOME}}/.claude/hooks/test.js
			if (result.includes("{{HOME}}")) {
				result = result.replace(
					/\{\{HOME\}\}([^\s]*)/g,
					(_match, rest: string) =>
						`{{HOME}}${rest.replaceAll("\\", "/")}`,
				);
			}
			return result;
		});

		const suffix = content.endsWith("\n") ? "\n" : "";
		return JSON.stringify(rewritten, null, indent) + suffix;
	} catch {
		// Not valid JSON — fall back to plain string replacement
		return content.replaceAll(homeDir, "{{HOME}}");
	}
}

/**
 * Expands {{HOME}} tokens in JSON content to the local home directory path.
 * Used when applying settings.json from the sync repo to the local machine.
 *
 * Operates on parsed JSON values to avoid any interaction with JSON escaping.
 *
 * @param content - The JSON file content to process
 * @param homeDir - The absolute path to the local home directory
 * @returns JSON content with {{HOME}} tokens replaced by the home directory
 */
export function expandPathsForLocal(
	content: string,
	homeDir: string,
): string {
	try {
		const parsed = JSON.parse(content);
		const indent = detectIndent(content);

		const expanded = deepMapStrings(parsed, (s) =>
			s.replaceAll("{{HOME}}", homeDir),
		);

		const suffix = content.endsWith("\n") ? "\n" : "";
		return JSON.stringify(expanded, null, indent) + suffix;
	} catch {
		// Not valid JSON — fall back to plain string replacement
		return content.replaceAll("{{HOME}}", homeDir);
	}
}
