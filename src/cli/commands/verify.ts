import type { Command } from "commander";
import pc from "picocolors";
import { getEnabledEnvironmentInstances } from "../../core/env-config.js";
import type { Environment } from "../../core/environment.js";
import { type VerifyResult, verifyEnvironment } from "../../core/verify/index.js";

const MAX_PRINTED_ISSUES = 20;

/** Verifies the given environments (optionally only `envId`). Throws on unknown env. */
export async function verifyEnvironments(
	environments: Environment[],
	envId?: string,
): Promise<VerifyResult[]> {
	const selected = envId ? environments.filter((e) => e.id === envId) : environments;
	if (envId && selected.length === 0) {
		throw new Error(
			`Environment "${envId}" is not enabled (enabled: ${environments.map((e) => e.id).join(", ") || "none"})`,
		);
	}
	const results: VerifyResult[] = [];
	for (const env of selected) results.push(await verifyEnvironment(env));
	return results;
}

/** Human-readable summary plus up to 20 errors. */
export function printVerifyResult(result: VerifyResult): void {
	const counts = Object.entries(result.checked)
		.map(([k, v]) => (typeof v === "boolean" ? `${k}: ${v ? "yes" : "no"}` : `${v} ${k}`))
		.join(", ");
	const status = result.ok ? pc.green("ok") : pc.red("FAILED");
	console.log(
		`${result.env}: ${status} -- ${counts}; ${result.errors.length} error(s), ${result.warnings.length} warning(s)${result.truncated ? " (truncated)" : ""}`,
	);
	for (const e of result.errors.slice(0, MAX_PRINTED_ISSUES)) {
		console.log(pc.red(`  error: ${e.path}: ${e.problem}`));
	}
	if (result.errors.length > MAX_PRINTED_ISSUES) {
		console.log(pc.red(`  ... and ${result.errors.length - MAX_PRINTED_ISSUES} more (use --json)`));
	}
}

export function registerVerifyCommand(program: Command): void {
	program
		.command("verify")
		.description("Check that the synced tool configuration loads (read-only)")
		.option("--env <id>", "Only verify a specific environment")
		.option("--json", "Print machine-readable JSON to stdout", false)
		.action(async (opts: { env?: string; json: boolean }) => {
			try {
				const results = await verifyEnvironments(getEnabledEnvironmentInstances(), opts.env);
				if (opts.json) {
					const out =
						results.length === 1 ? results[0] : { ok: results.every((r) => r.ok), envs: results };
					console.log(JSON.stringify(out, null, 2));
				} else {
					for (const r of results) printVerifyResult(r);
				}
				process.exitCode = results.every((r) => r.ok) ? 0 : 1;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Verify failed: ${message}`));
				process.exitCode = 2;
			}
		});
}
