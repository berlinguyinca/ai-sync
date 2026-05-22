/**
 * Per-file-type merge strategy dispatcher.
 *
 * Routes a MergeInput through a resolver based on its file type, then
 * applies post-merge validation:
 *   - markdown / ai-freeform → resolver output is returned verbatim
 *   - json / ai-validated    → JSON.parse the merged content (throw → json-parse)
 *   - yaml / ai-validated    → yaml.parse the merged content (throw → yaml-parse)
 *   - unknown / keep-local   → short-circuit without calling the resolver
 *
 * Per-type overrides come from `config.perType`, a glob → strategy-name map.
 * v1 glob support is intentionally minimal — only `*.ext` extension patterns
 * and the catch-all `*` are matched. This is sufficient for the defaults in
 * docs/specs/2026-05-22-ai-merge-resolver-design.md §4.5; richer globbing can
 * be added once a real need shows up.
 */

import * as path from "node:path";
import * as yaml from "yaml";
import type { MergeConfig } from "./config.js";
import type { FileType, MergeInput, MergeResolver } from "./resolver.js";

export type StrategyName = "ai-freeform" | "ai-validated" | "keep-local";

export type StrategyReason =
	| "json-parse"
	| "yaml-parse"
	| "unsupported-type"
	| "keep-local-override";

export type StrategyResult =
	| { ok: true; mergedContent: string; fileType: FileType; notes?: string }
	| { ok: false; reason: StrategyReason; fileType: FileType };

/**
 * Classify a file by its extension. Content-sniffing for unextensioned files
 * (e.g., `Makefile`) intentionally returns `unknown` with empty extension.
 */
export function classify(relativePath: string): FileType {
	const ext = path.extname(relativePath).toLowerCase();
	switch (ext) {
		case ".md":
		case ".markdown":
		case ".txt":
			return { kind: "markdown" };
		case ".json":
			return { kind: "json" };
		case ".yml":
		case ".yaml":
			return { kind: "yaml" };
		default:
			return { kind: "unknown", extension: ext };
	}
}

/**
 * Match a relative path against a minimal glob.
 *
 * Supported forms:
 *   - "*"            → matches anything
 *   - "*.ext"        → matches basenames whose extension is `.ext`
 *   - exact string   → matches a literal basename or full relative path
 *
 * Anything else falls back to a literal compare.
 */
function globMatch(pattern: string, relativePath: string): boolean {
	if (pattern === "*") return true;
	const base = path.basename(relativePath);
	if (pattern.startsWith("*.")) {
		const want = pattern.slice(1).toLowerCase(); // ".ext"
		return path.extname(base).toLowerCase() === want;
	}
	return pattern === base || pattern === relativePath;
}

/**
 * Determine the strategy for a path. The first matching `perType` entry
 * (in declaration order) wins; a catch-all `*` matches last by convention.
 *
 * When no override matches, the default strategy is derived from the file
 * type: markdown → ai-freeform; json/yaml → ai-validated; unknown → keep-local.
 */
function pickStrategy(
	relativePath: string,
	fileType: FileType,
	perType: Record<string, string>,
): StrategyName {
	// Walk entries in insertion order, but defer "*" until last so a generic
	// catch-all doesn't shadow a more specific later entry.
	const entries = Object.entries(perType);
	const specific = entries.filter(([p]) => p !== "*");
	const wildcard = entries.find(([p]) => p === "*");
	for (const [pattern, strat] of specific) {
		if (globMatch(pattern, relativePath) && isStrategyName(strat)) {
			return strat;
		}
	}
	if (wildcard && isStrategyName(wildcard[1])) {
		// Only honor `*` for unknown file types; typed files keep their
		// type-appropriate default unless a specific glob said otherwise.
		if (fileType.kind === "unknown") return wildcard[1];
	}
	switch (fileType.kind) {
		case "markdown":
			return "ai-freeform";
		case "json":
		case "yaml":
			return "ai-validated";
		default:
			return "keep-local";
	}
}

function isStrategyName(s: string): s is StrategyName {
	return s === "ai-freeform" || s === "ai-validated" || s === "keep-local";
}

/**
 * Dispatch a merge by file type, honoring per-type config overrides.
 *
 * Never throws: parse failures and unsupported types return `{ok: false}`
 * so the orchestrator can cleanly fall back to keep-local.
 */
export async function mergeWithStrategy(
	input: Omit<MergeInput, "fileType"> & { fileType?: FileType },
	resolver: MergeResolver,
	config: Pick<MergeConfig, "perType">,
): Promise<StrategyResult> {
	const fileType = input.fileType ?? classify(input.relativePath);
	const strategy = pickStrategy(input.relativePath, fileType, config.perType);

	if (strategy === "keep-local") {
		return {
			ok: false,
			reason: fileType.kind === "unknown" ? "unsupported-type" : "keep-local-override",
			fileType,
		};
	}

	const output = await resolver.resolve({ ...input, fileType });
	const merged = output.mergedContent;
	const notes = output.notes;

	if (strategy === "ai-freeform") {
		return { ok: true, mergedContent: merged, fileType, notes };
	}

	// ai-validated → parse-validate per file type. Markdown under ai-validated
	// is treated as JSON-shaped per spec §4.5 (rare but explicit).
	if (fileType.kind === "yaml") {
		try {
			yaml.parse(merged);
			return { ok: true, mergedContent: merged, fileType, notes };
		} catch {
			return { ok: false, reason: "yaml-parse", fileType };
		}
	}
	try {
		JSON.parse(merged);
		return { ok: true, mergedContent: merged, fileType, notes };
	} catch {
		return { ok: false, reason: "json-parse", fileType };
	}
}
