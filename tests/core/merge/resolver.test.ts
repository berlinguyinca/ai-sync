import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter, type ExecFn } from "../../../src/core/merge/adapters/claude-cli.js";
import { ResolverError } from "../../../src/core/merge/resolver.js";

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-merge-test-"));
});

afterEach(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("createClaudeAdapter", () => {
	describe("available()", () => {
		it("returns true when claude --version succeeds", async () => {
			const execFn: ExecFn = async (cmd, args) => {
				expect(cmd).toBe("claude");
				expect(args).toEqual(["--version"]);
				return { stdout: "claude 1.0.0\n", stderr: "" };
			};
			const adapter = createClaudeAdapter(execFn);
			expect(await adapter.available()).toBe(true);
		});

		it("returns false when claude --version throws", async () => {
			const execFn: ExecFn = async () => {
				throw new Error("ENOENT");
			};
			const adapter = createClaudeAdapter(execFn);
			expect(await adapter.available()).toBe(false);
		});
	});

	describe("resolve()", () => {
		it("returns stdout as mergedContent on success", async () => {
			const execFn: ExecFn = async (cmd, args) => {
				expect(cmd).toBe("claude");
				expect(args[0]).toBe("-p");
				// args[1] should be a tempdir-scoped prompt file
				expect(args[1]).toContain("prompt.txt");
				const promptContent = await fs.readFile(args[1], "utf-8");
				expect(promptContent).toContain("CLAUDE.md");
				expect(promptContent).toContain("local body");
				expect(promptContent).toContain("remote body");
				return { stdout: "merged body", stderr: "" };
			};
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			const out = await adapter.resolve({
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: "base body",
				local: "local body",
				remote: "remote body",
				fileType: { kind: "markdown" },
			});
			expect(out.mergedContent).toBe("merged body");
		});

		it("supports null base (new file on both sides)", async () => {
			const execFn: ExecFn = async (_cmd, args) => {
				const promptContent = await fs.readFile(args[1], "utf-8");
				expect(promptContent).toContain("no common ancestor");
				return { stdout: "merged", stderr: "" };
			};
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			const out = await adapter.resolve({
				relativePath: "new.md",
				envName: "claude",
				base: null,
				local: "L",
				remote: "R",
				fileType: { kind: "markdown" },
			});
			expect(out.mergedContent).toBe("merged");
		});

		it("throws ResolverError with reason non-zero-exit on subprocess failure", async () => {
			const execFn: ExecFn = async () => {
				const err = new Error("exited with code 1") as NodeJS.ErrnoException;
				err.code = "1";
				throw err;
			};
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			await expect(
				adapter.resolve({
					relativePath: "x.md",
					envName: "claude",
					base: null,
					local: "a",
					remote: "b",
					fileType: { kind: "markdown" },
				}),
			).rejects.toMatchObject({
				name: "ResolverError",
				reason: "non-zero-exit",
			});
		});

		it("throws ResolverError with reason timeout when signal aborts", async () => {
			const execFn: ExecFn = async (_cmd, _args, opts) => {
				return await new Promise((_resolve, reject) => {
					opts?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted") as NodeJS.ErrnoException;
						err.name = "AbortError";
						err.code = "ABORT_ERR";
						reject(err);
					});
				});
			};
			const adapter = createClaudeAdapter(execFn, {
				tmpdirRoot: tmpRoot,
				timeoutMs: 25,
			});
			await expect(
				adapter.resolve({
					relativePath: "x.md",
					envName: "claude",
					base: null,
					local: "a",
					remote: "b",
					fileType: { kind: "markdown" },
				}),
			).rejects.toMatchObject({
				name: "ResolverError",
				reason: "timeout",
			});
		});

		it("throws ResolverError with reason malformed-output on empty stdout", async () => {
			const execFn: ExecFn = async () => ({ stdout: "", stderr: "" });
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			await expect(
				adapter.resolve({
					relativePath: "x.md",
					envName: "claude",
					base: null,
					local: "a",
					remote: "b",
					fileType: { kind: "markdown" },
				}),
			).rejects.toMatchObject({
				name: "ResolverError",
				reason: "malformed-output",
			});
		});

		it("preserves tempdir on failure with path surfaced via error", async () => {
			let capturedTempdir: string | undefined;
			const execFn: ExecFn = async (_cmd, args) => {
				capturedTempdir = path.dirname(args[1]);
				throw new Error("boom");
			};
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			try {
				await adapter.resolve({
					relativePath: "x.md",
					envName: "claude",
					base: null,
					local: "a",
					remote: "b",
					fileType: { kind: "markdown" },
				});
				expect.fail("expected throw");
			} catch (err) {
				expect(err).toBeInstanceOf(ResolverError);
				expect((err as ResolverError).tempdir).toBe(capturedTempdir);
				// tempdir should still exist for postmortem
				const stat = await fs.stat(capturedTempdir as string);
				expect(stat.isDirectory()).toBe(true);
			}
		});

		it("cleans up tempdir on success", async () => {
			let capturedTempdir: string | undefined;
			const execFn: ExecFn = async (_cmd, args) => {
				capturedTempdir = path.dirname(args[1]);
				return { stdout: "merged", stderr: "" };
			};
			const adapter = createClaudeAdapter(execFn, { tmpdirRoot: tmpRoot });
			await adapter.resolve({
				relativePath: "x.md",
				envName: "claude",
				base: null,
				local: "a",
				remote: "b",
				fileType: { kind: "markdown" },
			});
			await expect(fs.stat(capturedTempdir as string)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});
});
