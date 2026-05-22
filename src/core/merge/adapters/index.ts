import type { MergeResolver } from "../resolver.js";
import { createClaudeAdapter, type ExecFn } from "./claude-cli.js";
import { createCodexAdapter } from "./codex-cli.js";
import { createOpencodeAdapter } from "./opencode-cli.js";

export type AdapterName = "claude" | "codex" | "opencode";

/**
 * Factory registry mapping adapter names to constructors.
 */
export function createAdapter(name: AdapterName, execFn?: ExecFn): MergeResolver {
	switch (name) {
		case "claude":
			return createClaudeAdapter(execFn);
		case "codex":
			return createCodexAdapter(execFn);
		case "opencode":
			return createOpencodeAdapter(execFn);
		default: {
			const exhaustive: never = name;
			throw new Error(`Unknown adapter: ${String(exhaustive)}`);
		}
	}
}
