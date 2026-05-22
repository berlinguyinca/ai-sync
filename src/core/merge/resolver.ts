/**
 * MergeResolver interface and types for AI-assisted merge resolution.
 *
 * Adapters mirror the ExecFn pattern from src/core/provisioner.ts:7 — they
 * accept an injected execFn for testability.
 */

export type FileType =
	| { kind: "markdown" }
	| { kind: "json" }
	| { kind: "yaml" }
	| { kind: "unknown"; extension: string };

export interface MergeInput {
	/** Path relative to the env config dir, e.g. "CLAUDE.md". */
	relativePath: string;
	/** Environment id, e.g. "claude" | "opencode". */
	envName: string;
	/** Last-synced content; null if the file is new. */
	base: string | null;
	/** Current on-disk content. */
	local: string;
	/** Post-pull content from the sync repo. */
	remote: string;
	/** File classification, resolved upstream by strategies.ts (issue #27). */
	fileType: FileType;
}

export interface MergeOutput {
	mergedContent: string;
	/** Optional rationale from the adapter, surfaced in status reports. */
	notes?: string;
}

export interface MergeResolver {
	readonly name: string;
	/** Probe whether the underlying CLI is available. */
	available(): Promise<boolean>;
	/** Produce a merged version of the input. */
	resolve(input: MergeInput): Promise<MergeOutput>;
}

/**
 * Error class for resolver failures. The `reason` field is a short tag
 * used by the orchestrator to decide fallback behavior.
 */
export class ResolverError extends Error {
	readonly reason: "non-zero-exit" | "timeout" | "malformed-output" | "probe-failed" | "io-error";
	readonly tempdir?: string;
	constructor(
		reason: ResolverError["reason"],
		message: string,
		options?: { tempdir?: string; cause?: unknown },
	) {
		super(message);
		this.name = "ResolverError";
		this.reason = reason;
		this.tempdir = options?.tempdir;
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}
