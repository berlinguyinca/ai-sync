import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildMergePrompt } from "../prompts.js";
import {
	type MergeInput,
	type MergeOutput,
	type MergeResolver,
	ResolverError,
} from "../resolver.js";
import { defaultExecFn, type ExecFn } from "./claude-cli.js";

export interface OpencodeAdapterOptions {
	/** Hard timeout in milliseconds for `resolve()`. Default 60_000. */
	timeoutMs?: number;
	/** Override the opencode binary name (default "opencode"). */
	binary?: string;
	/** Tempdir factory; defaults to os.tmpdir(). */
	tmpdirRoot?: string;
}

/**
 * Creates a MergeResolver backed by the `opencode` CLI.
 *
 * `available()` runs `opencode --version` via the injected execFn.
 * `resolve()` writes the prompt to a tempdir, invokes
 * `opencode run -p <file>`, and returns stdout as the merged
 * content. A hard timeout is enforced via AbortController. On success the
 * tempdir is cleaned up; on failure it is preserved and the path is
 * surfaced via ResolverError.tempdir.
 */
export function createOpencodeAdapter(
	execFn: ExecFn = defaultExecFn,
	options: OpencodeAdapterOptions = {},
): MergeResolver {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const binary = options.binary ?? "opencode";
	const tmpdirRoot = options.tmpdirRoot ?? os.tmpdir();

	return {
		name: "opencode",
		async available(): Promise<boolean> {
			try {
				await execFn(binary, ["--version"]);
				return true;
			} catch {
				return false;
			}
		},
		async resolve(input: MergeInput): Promise<MergeOutput> {
			const id = crypto.randomBytes(6).toString("hex");
			const tempdir = path.join(tmpdirRoot, `ai-sync-merge-${process.pid}-${id}`);
			await fs.mkdir(tempdir, { recursive: true });

			const promptFile = path.join(tempdir, "prompt.txt");
			const prompt = buildMergePrompt(
				input.relativePath,
				input.base,
				input.local,
				input.remote,
				input.fileType,
			);
			try {
				await fs.writeFile(promptFile, prompt, "utf-8");
				// Preserve base/local/remote for postmortem
				if (input.base !== null) {
					await fs.writeFile(path.join(tempdir, "base.txt"), input.base, "utf-8");
				}
				await fs.writeFile(path.join(tempdir, "local.txt"), input.local, "utf-8");
				await fs.writeFile(path.join(tempdir, "remote.txt"), input.remote, "utf-8");
			} catch (err) {
				throw new ResolverError(
					"io-error",
					`Failed to prepare tempdir ${tempdir}: ${(err as Error).message}`,
					{ tempdir, cause: err },
				);
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let result: { stdout: string; stderr: string };
			try {
				result = await execFn(binary, ["run", "-p", promptFile], {
					signal: controller.signal,
				});
			} catch (err) {
				const e = err as NodeJS.ErrnoException & { code?: string; killed?: boolean };
				if (controller.signal.aborted || e.code === "ABORT_ERR" || e.name === "AbortError") {
					throw new ResolverError(
						"timeout",
						`opencode exceeded timeout of ${timeoutMs}ms (tempdir: ${tempdir})`,
						{ tempdir, cause: err },
					);
				}
				throw new ResolverError(
					"non-zero-exit",
					`opencode exited non-zero: ${(err as Error).message} (tempdir: ${tempdir})`,
					{ tempdir, cause: err },
				);
			} finally {
				clearTimeout(timer);
			}

			const merged = result.stdout;
			if (typeof merged !== "string" || merged.length === 0) {
				throw new ResolverError(
					"malformed-output",
					`opencode returned empty stdout (tempdir: ${tempdir})`,
					{ tempdir },
				);
			}

			// Success: cleanup tempdir.
			try {
				await fs.rm(tempdir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; ignore failures.
			}

			return { mergedContent: merged };
		},
	};
}
