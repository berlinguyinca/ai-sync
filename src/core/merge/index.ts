import type { MergeConfig } from "./config.js";
import { type FileType, type MergeResolver, ResolverError } from "./resolver.js";
import { type StagedEntry, stage } from "./staging.js";
import { classify, mergeWithStrategy } from "./strategies.js";

export type { ExecFn } from "./adapters/claude-cli.js";
export { createClaudeAdapter, defaultExecFn } from "./adapters/claude-cli.js";
export type { AdapterName } from "./adapters/index.js";
export { createAdapter } from "./adapters/index.js";
export type { MergeConfig } from "./config.js";
export { defaultMergeConfig, loadMergeConfig, MergeConfigSchema } from "./config.js";
export { buildMergePrompt } from "./prompts.js";
export type {
	FileType,
	MergeInput,
	MergeOutput,
	MergeResolver,
} from "./resolver.js";
export { ResolverError } from "./resolver.js";
export type { AcceptResult, StagedEntry, StageInput } from "./staging.js";
export {
	acceptStaged,
	ensureGitignoreEntry,
	getStagedContent,
	listStaged,
	rejectStaged,
	removeFromManifest,
	stage,
	stagedFilePath,
} from "./staging.js";
export type {
	StrategyName,
	StrategyReason,
	StrategyResult,
} from "./strategies.js";
export { classify, mergeWithStrategy } from "./strategies.js";

/**
 * Classify a file by its extension. Kept as a stable name for legacy callers;
 * delegates to `classify()` from strategies.ts (issue #27) so there is one
 * source of truth.
 */
export function classifyFile(relativePath: string): FileType {
	return classify(relativePath);
}

export interface TryAiMergeInput {
	relativePath: string;
	envName: string;
	base: string | null;
	local: string;
	remote: string;
}

export interface TryAiMergeDeps {
	config: MergeConfig;
	resolver: MergeResolver;
	syncRepoDir: string;
	/** Optional warning logger for resolver failures (keeps pull non-fatal). */
	warn?: (message: string) => void;
}

export type TryMergeResult =
	| { kind: "staged"; entry: StagedEntry }
	| { kind: "applied"; mergedContent: string }
	| { kind: "fallback"; reason: string };

/**
 * Orchestrates a single conflict resolution attempt.
 *
 * Short-circuits to `fallback` immediately when `config.enabled === false`,
 * preserving byte-identical pre-feature behavior in the keep-local branch.
 *
 * On success, the merged content is staged under `.ai-sync/pending/` unless
 * `config.autoApply` is true, in which case the result is returned as
 * `applied` (the caller is responsible for writing it to the live target).
 *
 * Any resolver failure returns `fallback` with a reason — never throws.
 */
export async function tryAiMerge(
	input: TryAiMergeInput,
	deps: TryAiMergeDeps,
): Promise<TryMergeResult> {
	if (!deps.config.enabled) {
		return { kind: "fallback", reason: "disabled" };
	}
	const fileType = classify(input.relativePath);
	try {
		const dispatch = await mergeWithStrategy(
			{
				relativePath: input.relativePath,
				envName: input.envName,
				base: input.base,
				local: input.local,
				remote: input.remote,
				fileType,
			},
			deps.resolver,
			deps.config,
		);
		if (!dispatch.ok) {
			deps.warn?.(
				`AI merge fell back to keep-local for ${input.envName}/${input.relativePath}: ${dispatch.reason}`,
			);
			return { kind: "fallback", reason: dispatch.reason };
		}
		if (deps.config.autoApply) {
			return { kind: "applied", mergedContent: dispatch.mergedContent };
		}
		const entry = await stage(deps.syncRepoDir, {
			envName: input.envName,
			relativePath: input.relativePath,
			mergedContent: dispatch.mergedContent,
			resolver: deps.resolver.name,
			notes: dispatch.notes,
		});
		return { kind: "staged", entry };
	} catch (err) {
		const reason =
			err instanceof ResolverError ? err.reason : (err as Error)?.message || "unknown-error";
		deps.warn?.(
			`AI merge fell back to keep-local for ${input.envName}/${input.relativePath}: ${reason}`,
		);
		return { kind: "fallback", reason };
	}
}
