import type { MergeResolver } from "../resolver.js";
import { createClaudeAdapter, type ExecFn } from "./claude-cli.js";

export type AdapterName = "claude" | "codex" | "opencode";

/**
 * Factory registry mapping adapter names to constructors.
 * codex and opencode adapters land in issues #25 and #26.
 */
export function createAdapter(name: AdapterName, execFn?: ExecFn): MergeResolver {
	switch (name) {
		case "claude":
			return createClaudeAdapter(execFn);
		case "codex":
		case "opencode":
			throw new Error(`Adapter "${name}" not implemented yet (tracked by issues #25/#26)`);
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown adapter: ${String(exhaustive)}`);
		}
	}
}
