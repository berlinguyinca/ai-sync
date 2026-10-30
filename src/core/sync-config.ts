import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

/**
 * Schema for `tools/sync-config.json` in the sync repo.
 *
 * `plugins` defaults to true (plugin files are synced, the historical behaviour).
 * When false, the claude environment's plugin sync patterns are treated as empty
 * in every code path: nothing under `plugins/` is pushed, pulled, backed up,
 * diffed or deleted.
 */
export const SyncConfigSchema = z.strictObject({
	plugins: z.boolean().default(true),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

/** Default config (plugins synced). */
export function defaultSyncConfig(): SyncConfig {
	return SyncConfigSchema.parse({});
}

/**
 * Loads `<syncRepoDir>/tools/sync-config.json`. If the file is absent, returns
 * the schema defaults. If the file is present but malformed or has unknown
 * keys, throws an error that tells the user how to fix it (it never silently
 * falls back to syncing plugins).
 */
export async function loadSyncConfig(syncRepoDir: string): Promise<SyncConfig> {
	const configPath = path.join(syncRepoDir, "tools", "sync-config.json");
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return defaultSyncConfig();
		}
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`Invalid JSON in ${configPath}: ${(err as Error).message}. ` +
				`Fix the file (expected e.g. {"plugins": false}) or delete it to restore defaults.`,
		);
	}
	const result = SyncConfigSchema.safeParse(parsed);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => {
			if (issue.code === "unrecognized_keys") {
				return `unknown key(s) ${issue.keys.map((k) => `"${k}"`).join(", ")} (allowed: "plugins")`;
			}
			return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
		});
		throw new Error(
			`Invalid ${configPath}: ${problems.join("; ")}. ` +
				`Fix the file (expected e.g. {"plugins": false}) or delete it to restore defaults.`,
		);
	}
	return result.data;
}
