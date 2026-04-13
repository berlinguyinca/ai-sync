import * as path from "node:path";

/**
 * A fragment is a single section extracted from a monolithic markdown file.
 */
export interface Fragment {
	path: string; // Relative path in sync repo (e.g., "shared/standards/tdd.md")
	content: string;
	scope: "shared" | string; // "shared" or environment id
}

/**
 * Parsed representation of a thin index file containing @-references.
 */
export interface FragmentIndex {
	preamble: string; // Content before @-references
	references: string[]; // Ordered @-reference paths
}

/**
 * Result of splitting a monolithic markdown file into fragments.
 */
export interface SplitResult {
	fragments: Fragment[];
	indexContent: string;
	sourcePath: string;
}

/**
 * Splits a monolithic markdown file into fragment files by level-2 headers.
 *
 * Only `## ` headers are used as split points. Nested `###`, `####`, etc.
 * remain within their parent fragment. Content before the first `## ` header
 * becomes the preamble and is included in the generated index file but not
 * emitted as a separate fragment.
 *
 * Empty sections (blank content after stripping whitespace) are skipped.
 *
 * @param content - The full markdown content to split
 * @param sectionMap - Maps header text (e.g. `"## TDD & Testing"`) to fragment path
 * @returns SplitResult with fragments and generated index content
 */
export function splitMarkdownIntoFragments(
	content: string,
	sectionMap: Map<string, string>,
): SplitResult {
	const lines = content.split("\n");

	const preambleLines: string[] = [];
	let currentHeader: string | null = null;
	let currentLines: string[] = [];
	const fragments: Fragment[] = [];
	const references: string[] = [];

	const flushSection = (): void => {
		if (currentHeader === null) return;

		const fragmentPath = sectionMap.get(currentHeader);
		if (!fragmentPath) return;

		// Join and trim trailing whitespace only; preserve internal structure
		const sectionContent = currentLines.join("\n").trimEnd();
		if (sectionContent.length === 0) return;

		// Infer scope from path: first segment before "/"
		const firstSegment = fragmentPath.split("/")[0] ?? "shared";
		const scope: "shared" | string = firstSegment;

		fragments.push({ path: fragmentPath, content: sectionContent, scope });
		references.push(fragmentPath);
	};

	let inPreamble = true;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (inPreamble) {
				// First ## header — everything so far is preamble
				inPreamble = false;
			} else {
				// Flush previous section
				flushSection();
			}
			currentHeader = line;
			currentLines = [line];
		} else if (inPreamble) {
			preambleLines.push(line);
		} else {
			currentLines.push(line);
		}
	}

	// Flush the last section
	flushSection();

	// Build preamble string, trimming trailing blank lines
	const preamble = preambleLines.join("\n").trimEnd();

	const indexContent = generateIndex(preamble, references);

	return { fragments, indexContent, sourcePath: "" };
}

/**
 * Generates a thin index file from a preamble and an ordered list of @-references.
 *
 * Output format:
 * ```
 * <preamble content>
 *
 * @shared/standards/tdd.md
 * @shared/standards/code-quality.md
 * ```
 *
 * @param preamble - Content to place before the references
 * @param references - Ordered fragment paths (without leading `@`)
 * @returns The full index file content
 */
export function generateIndex(preamble: string, references: string[]): string {
	if (references.length === 0) {
		return preamble;
	}

	const refLines = references.map((ref) => `@${ref}`).join("\n");

	if (preamble.length === 0) {
		return refLines;
	}

	return `${preamble}\n\n${refLines}`;
}

/**
 * Parses a thin index file into its preamble and @-reference paths.
 *
 * Lines starting with `@` (after trimming) are treated as references.
 * All non-reference lines that appear before the first reference are collected
 * as the preamble.
 *
 * @param content - The index file content to parse
 * @returns FragmentIndex with preamble and reference paths
 */
export function parseIndex(content: string): FragmentIndex {
	const lines = content.split("\n");
	const preambleLines: string[] = [];
	const references: string[] = [];
	let seenReference = false;

	for (const line of lines) {
		if (line.trim().startsWith("@")) {
			seenReference = true;
			references.push(line.trim().slice(1));
		} else if (!seenReference) {
			preambleLines.push(line);
		}
	}

	// Trim trailing blank lines from preamble
	const preamble = preambleLines.join("\n").trimEnd();

	return { preamble, references };
}

/**
 * Resolves an @-reference to an absolute path within the sync repository.
 *
 * Strips the leading `@` from the reference string, then joins the result
 * with the sync repository root directory.
 *
 * @param reference - The @-reference string (e.g., `@shared/standards/tdd.md`)
 * @param syncRepoDir - Absolute path to the sync repository root
 * @returns Absolute path to the fragment file
 */
export function resolveFragmentPath(reference: string, syncRepoDir: string): string {
	const stripped = reference.startsWith("@") ? reference.slice(1) : reference;
	return path.join(syncRepoDir, stripped);
}

/**
 * Returns true if the content contains git conflict markers.
 *
 * Checks for the presence of `<<<<<<<` or `>>>>>>>` which indicate
 * an unresolved merge conflict.
 *
 * @param content - The file content to inspect
 * @returns true if conflict markers are present
 */
export function hasConflictMarkers(content: string): boolean {
	return content.includes("<<<<<<<") || content.includes(">>>>>>>");
}
