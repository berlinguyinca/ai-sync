import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResolverError } from "../../../src/core/merge/resolver.js";
import { summarizeWithResolver } from "../../../src/core/merge/summarize.js";

let tmpRoot: string;
beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-summarize-test-"));
});
afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("summarizeWithResolver", () => {
	it("writes the prompt to a tempdir and shells out to the resolver CLI", async () => {
		const execFn = vi.fn().mockResolvedValue({ stdout: "summary text", stderr: "" });
		const out = await summarizeWithResolver("claude", "PROMPT", {
			execFn,
			tmpdirRoot: tmpRoot,
		});
		expect(out).toBe("summary text");
		expect(execFn).toHaveBeenCalledOnce();
		const [bin, args] = execFn.mock.calls[0];
		expect(bin).toBe("claude");
		expect(args[0]).toBe("-p");
		const promptFile = args[1] as string;
		// Tempdir is cleaned on success — file should NOT exist anymore.
		await expect(fs.access(promptFile)).rejects.toBeDefined();
	});

	it("uses codex CLI flags for codex resolver", async () => {
		const execFn = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
		await summarizeWithResolver("codex", "P", { execFn, tmpdirRoot: tmpRoot });
		const [bin, args] = execFn.mock.calls[0];
		expect(bin).toBe("codex");
		expect(args.slice(0, 2)).toEqual(["exec", "--prompt-file"]);
	});

	it("uses opencode CLI flags for opencode resolver", async () => {
		const execFn = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
		await summarizeWithResolver("opencode", "P", { execFn, tmpdirRoot: tmpRoot });
		const [bin, args] = execFn.mock.calls[0];
		expect(bin).toBe("opencode");
		expect(args[0]).toBe("run");
	});

	it("throws ResolverError(non-zero-exit) when execFn rejects", async () => {
		const execFn = vi.fn().mockRejectedValue(new Error("exit 1"));
		await expect(
			summarizeWithResolver("claude", "P", { execFn, tmpdirRoot: tmpRoot }),
		).rejects.toBeInstanceOf(ResolverError);
	});

	it("throws ResolverError(malformed-output) when stdout is empty", async () => {
		const execFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
		await expect(
			summarizeWithResolver("claude", "P", { execFn, tmpdirRoot: tmpRoot }),
		).rejects.toMatchObject({ reason: "malformed-output" });
	});

	it("throws ResolverError(timeout) when execFn aborts", async () => {
		const execFn = vi.fn().mockImplementation((_b, _a, opts) => {
			return new Promise((_resolve, reject) => {
				opts?.signal?.addEventListener("abort", () => {
					const err = new Error("aborted") as Error & { code: string };
					err.code = "ABORT_ERR";
					reject(err);
				});
			});
		});
		await expect(
			summarizeWithResolver("claude", "P", {
				execFn,
				tmpdirRoot: tmpRoot,
				timeoutMs: 10,
			}),
		).rejects.toMatchObject({ reason: "timeout" });
	});
});
