import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultExecFn, type ExecFn } from "./adapters/claude-cli.js";
import type { AdapterName } from "./adapters/index.js";
import { ResolverError } from "./resolver.js";

/**
 * CLI invocation shape per resolver. Mirrors the per-adapter `resolve()`
 * argv used internally; centralized here so `ai-sync status --summarize`
 * can drive any configured resolver with a custom prompt without
 * duplicating the merge-specific MergeInput plumbing.
 */
function buildArgv(resolver: AdapterName, promptFile: string): { binary: string; args: string[] } {
	switch (resolver) {
		case "claude":
			return { binary: "claude", args: ["-p", promptFile] };
		case "codex":
			return { binary: "codex", args: ["exec", "--prompt-file", promptFile] };
		case "opencode":
			return { binary: "opencode", args: ["run", promptFile] };
	}
}

export interface SummarizeOptions {
	timeoutMs?: number;
	tmpdirRoot?: string;
	execFn?: ExecFn;
}

/**
 * Invokes a configured resolver CLI with a freeform prompt and returns
 * stdout. Used by `ai-sync status --summarize` — one call per env.
 *
 * Errors are wrapped in {@link ResolverError} so callers can surface a
 * single yellow warning line without aborting the rest of the report.
 */
export async function summarizeWithResolver(
	resolver: AdapterName,
	prompt: string,
	options: SummarizeOptions = {},
): Promise<string> {
	const execFn = options.execFn ?? defaultExecFn;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const tmpdirRoot = options.tmpdirRoot ?? os.tmpdir();

	const id = crypto.randomBytes(6).toString("hex");
	const tempdir = path.join(tmpdirRoot, `ai-sync-summary-${process.pid}-${id}`);
	await fs.mkdir(tempdir, { recursive: true });
	const promptFile = path.join(tempdir, "prompt.txt");
	try {
		await fs.writeFile(promptFile, prompt, "utf-8");
	} catch (err) {
		throw new ResolverError(
			"io-error",
			`Failed to prepare tempdir ${tempdir}: ${(err as Error).message}`,
			{ tempdir, cause: err },
		);
	}

	const { binary, args } = buildArgv(resolver, promptFile);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let result: { stdout: string; stderr: string };
	try {
		result = await execFn(binary, args, { signal: controller.signal });
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { code?: string };
		if (controller.signal.aborted || e.code === "ABORT_ERR" || e.name === "AbortError") {
			throw new ResolverError(
				"timeout",
				`${resolver} exceeded timeout of ${timeoutMs}ms (tempdir: ${tempdir})`,
				{ tempdir, cause: err },
			);
		}
		throw new ResolverError(
			"non-zero-exit",
			`${resolver} exited non-zero: ${(err as Error).message} (tempdir: ${tempdir})`,
			{ tempdir, cause: err },
		);
	} finally {
		clearTimeout(timer);
	}

	const out = result.stdout;
	if (typeof out !== "string" || out.length === 0) {
		throw new ResolverError(
			"malformed-output",
			`${resolver} returned empty stdout (tempdir: ${tempdir})`,
			{ tempdir },
		);
	}

	try {
		await fs.rm(tempdir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
	return out;
}
