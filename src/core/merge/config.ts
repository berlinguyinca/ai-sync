import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

/**
 * Schema for `tools/merge-config.json` in the sync repo.
 *
 * `enabled` defaults to false in v1 — flipping the flag is its own issue.
 * When false, tryAiMerge short-circuits to fallback (keep-local).
 */
export const MergeConfigSchema = z.object({
	enabled: z.boolean().default(false),
	resolver: z.enum(["claude", "codex", "opencode"]).default("claude"),
	autoApply: z.boolean().default(false),
	timeoutSeconds: z.number().int().positive().default(60),
	perType: z.record(z.string(), z.string()).default(() => ({
		"*.md": "ai-freeform",
		"*.json": "ai-validated",
		"*.yaml": "ai-validated",
		"*.yml": "ai-validated",
		"*.lock": "keep-local",
		"*": "keep-local",
	})),
});

export type MergeConfig = z.infer<typeof MergeConfigSchema>;

/**
 * Loads `<syncRepoDir>/tools/merge-config.json`. If the file is absent,
 * returns the schema defaults. If the file is present but malformed, throws.
 */
export async function loadMergeConfig(syncRepoDir: string): Promise<MergeConfig> {
	const configPath = path.join(syncRepoDir, "tools", "merge-config.json");
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return MergeConfigSchema.parse({});
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
	}
	return MergeConfigSchema.parse(parsed);
}

/** Default config (used by callers when the loader isn't appropriate). */
export function defaultMergeConfig(): MergeConfig {
	return MergeConfigSchema.parse({});
}
