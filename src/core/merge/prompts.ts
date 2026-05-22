import type { FileType } from "./resolver.js";

/**
 * Build the merge prompt presented to the resolver CLI.
 *
 * v1 emits a single uniform prompt for all file types. Per-type variation
 * is the responsibility of issue #27 (strategy dispatcher).
 */
export function buildMergePrompt(
	relativePath: string,
	base: string | null,
	local: string,
	remote: string,
	fileType: FileType,
): string {
	const typeLabel = fileType.kind === "unknown" ? `unknown (${fileType.extension})` : fileType.kind;
	const baseSection =
		base === null
			? "<BASE>\n(no common ancestor — file is new on both sides)\n</BASE>"
			: `<BASE>\n${base}\n</BASE>`;
	return [
		`You are resolving a 3-way merge conflict for the file "${relativePath}" (type: ${typeLabel}).`,
		"Combine the intent of both sides without losing information.",
		"Respond with ONLY the merged file contents — no prose, no code fences, no commentary.",
		"",
		baseSection,
		"",
		`<LOCAL>\n${local}\n</LOCAL>`,
		"",
		`<REMOTE>\n${remote}\n</REMOTE>`,
		"",
	].join("\n");
}
