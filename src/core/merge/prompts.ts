import type { FileType } from "./resolver.js";

/**
 * Per-env drift payload used to build a summary prompt. Mirrors the shape
 * of {@link import("../drift.js").DriftReport} but with optional content
 * snippets per file so the resolver can produce a meaningful natural-
 * language summary.
 */
export interface SummaryDiffEntry {
	relativePath: string;
	side: "local" | "remote" | "both";
	/** Optional preview of what changed (already capped by caller). */
	snippet?: string;
}

export interface SummaryDiffData {
	localOnly: SummaryDiffEntry[];
	remoteOnly: SummaryDiffEntry[];
	bothChanged: SummaryDiffEntry[];
}

/**
 * Builds the prompt used by the resolver when invoked in "summarize
 * differences" mode by `ai-sync status --summarize`.
 *
 * The prompt aggregates the per-env drift classification into a single
 * structured request so the resolver returns a short natural-language
 * description of what each side changed. The caller is responsible for
 * capping the payload (e.g. 200 lines per env) before invoking this.
 */
export function buildSummaryPrompt(envName: string, diffData: SummaryDiffData): string {
	const lines: string[] = [];
	lines.push(
		`You are summarizing configuration drift for the "${envName}" environment.`,
		"Read the lists below and produce a concise natural-language summary (2-5 sentences)",
		"describing what changed on each side. Do not propose merges — just describe the drift.",
		"Respond with ONLY the summary text. No code fences, no headings, no prose preamble.",
		"",
	);
	const renderBucket = (label: string, entries: SummaryDiffEntry[]): void => {
		lines.push(`<${label}>`);
		if (entries.length === 0) {
			lines.push("(none)");
		} else {
			for (const e of entries) {
				lines.push(`- ${e.relativePath}`);
				if (e.snippet && e.snippet.length > 0) {
					for (const sline of e.snippet.split("\n")) {
						lines.push(`    ${sline}`);
					}
				}
			}
		}
		lines.push(`</${label}>`);
		lines.push("");
	};
	renderBucket("LOCAL_ONLY", diffData.localOnly);
	renderBucket("REMOTE_ONLY", diffData.remoteOnly);
	renderBucket("BOTH_CHANGED", diffData.bothChanged);
	return lines.join("\n");
}

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
