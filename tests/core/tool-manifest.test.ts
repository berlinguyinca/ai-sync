import { describe, expect, it } from "vitest";
import {
	PostInstallActionSchema,
	ToolEntrySchema,
	ToolManifestSchema,
	ToolTypeSchema,
	VerifyStrategySchema,
} from "../../src/core/tool-manifest.js";

const BASE_DATE = "2025-01-01T00:00:00.000Z";

describe("tool-manifest", () => {
	describe("ToolTypeSchema", () => {
		it("accepts all valid tool types", () => {
			for (const type of ["pip", "cargo", "npm", "claude-plugin", "system"]) {
				expect(ToolTypeSchema.parse(type)).toBe(type);
			}
		});

		it("rejects unknown tool types", () => {
			expect(() => ToolTypeSchema.parse("brew")).toThrow();
			expect(() => ToolTypeSchema.parse("")).toThrow();
		});
	});

	describe("VerifyStrategySchema", () => {
		it("accepts binary-exists strategy", () => {
			const result = VerifyStrategySchema.parse({ type: "binary-exists", name: "git" });
			expect(result).toEqual({ type: "binary-exists", name: "git" });
		});

		it("accepts command-output strategy", () => {
			const result = VerifyStrategySchema.parse({
				type: "command-output",
				command: "node",
				args: ["--version"],
				expectContains: "v22",
			});
			expect(result).toEqual({
				type: "command-output",
				command: "node",
				args: ["--version"],
				expectContains: "v22",
			});
		});

		it("accepts command-output without expectContains", () => {
			const result = VerifyStrategySchema.parse({
				type: "command-output",
				command: "node",
				args: ["--version"],
			});
			expect(result.type).toBe("command-output");
			expect(result).not.toHaveProperty("expectContains");
		});

		it("accepts pip-package strategy", () => {
			const result = VerifyStrategySchema.parse({ type: "pip-package", name: "requests" });
			expect(result).toEqual({ type: "pip-package", name: "requests" });
		});

		it("accepts cargo-crate strategy", () => {
			const result = VerifyStrategySchema.parse({ type: "cargo-crate", name: "ripgrep" });
			expect(result).toEqual({ type: "cargo-crate", name: "ripgrep" });
		});

		it("accepts npm-package strategy", () => {
			const result = VerifyStrategySchema.parse({ type: "npm-package", name: "typescript" });
			expect(result).toEqual({ type: "npm-package", name: "typescript" });
		});

		it("rejects unknown strategy type", () => {
			expect(() => VerifyStrategySchema.parse({ type: "shell-command", cmd: "which git" })).toThrow();
		});

		it("rejects free-form string (old format)", () => {
			expect(() => VerifyStrategySchema.parse("which git")).toThrow();
		});
	});

	describe("PostInstallActionSchema", () => {
		it("accepts none action", () => {
			expect(PostInstallActionSchema.parse({ type: "none" })).toEqual({ type: "none" });
		});

		it("accepts run-command action", () => {
			const result = PostInstallActionSchema.parse({
				type: "run-command",
				command: "rustup",
				args: ["update"],
			});
			expect(result).toEqual({ type: "run-command", command: "rustup", args: ["update"] });
		});

		it("rejects free-form string (old format)", () => {
			expect(() => PostInstallActionSchema.parse("rustup update")).toThrow();
		});

		it("rejects unknown action type", () => {
			expect(() => PostInstallActionSchema.parse({ type: "exec", cmd: "pip install x" })).toThrow();
		});
	});

	describe("ToolEntrySchema", () => {
		it("parses a valid entry with binary-exists verify", () => {
			const result = ToolEntrySchema.parse({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			});
			expect(result.name).toBe("git");
			expect(result.type).toBe("system");
			expect(result.required).toBe(true);
			expect(result.postInstall).toEqual({ type: "none" });
		});

		it("defaults postInstall to { type: 'none' }", () => {
			const result = ToolEntrySchema.parse({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			});
			expect(result.postInstall).toEqual({ type: "none" });
		});

		it("defaults required to true", () => {
			const result = ToolEntrySchema.parse({
				name: "git",
				type: "system",
				verify: { type: "binary-exists", name: "git" },
			});
			expect(result.required).toBe(true);
		});

		it("allows required: false", () => {
			const result = ToolEntrySchema.parse({
				name: "git",
				type: "system",
				required: false,
				verify: { type: "binary-exists", name: "git" },
			});
			expect(result.required).toBe(false);
		});

		it("accepts optional fields: package, marketplace, version", () => {
			const result = ToolEntrySchema.parse({
				name: "rg",
				type: "cargo",
				package: "ripgrep",
				marketplace: "crates.io",
				version: "14.0.0",
				verify: { type: "binary-exists", name: "rg" },
			});
			expect(result.package).toBe("ripgrep");
			expect(result.marketplace).toBe("crates.io");
			expect(result.version).toBe("14.0.0");
		});

		it("rejects entry without name", () => {
			expect(() =>
				ToolEntrySchema.parse({
					type: "system",
					verify: { type: "binary-exists", name: "git" },
				}),
			).toThrow();
		});

		it("rejects entry with unknown type", () => {
			expect(() =>
				ToolEntrySchema.parse({
					name: "homebrew",
					type: "brew",
					verify: { type: "binary-exists", name: "brew" },
				}),
			).toThrow();
		});

		describe(".refine() - command-output verify constraint", () => {
			it("accepts when verify.command matches tool name", () => {
				const result = ToolEntrySchema.parse({
					name: "node",
					type: "system",
					verify: {
						type: "command-output",
						command: "node",
						args: ["--version"],
					},
				});
				expect(result.name).toBe("node");
			});

			it("accepts when verify.command matches tool package", () => {
				const result = ToolEntrySchema.parse({
					name: "rg",
					type: "cargo",
					package: "ripgrep",
					verify: {
						type: "command-output",
						command: "ripgrep",
						args: ["--version"],
					},
				});
				expect(result.name).toBe("rg");
			});

			it("rejects when verify.command does not match name or package", () => {
				expect(() =>
					ToolEntrySchema.parse({
						name: "rg",
						type: "cargo",
						package: "ripgrep",
						verify: {
							type: "command-output",
							command: "sh",
							args: ["-c", "rg --version"],
						},
					}),
				).toThrow("verify/postInstall commands must reference the tool's own binary");
			});
		});

		describe(".refine() - run-command postInstall constraint", () => {
			it("accepts when postInstall.command matches tool name", () => {
				const result = ToolEntrySchema.parse({
					name: "rustup",
					type: "system",
					verify: { type: "binary-exists", name: "rustup" },
					postInstall: { type: "run-command", command: "rustup", args: ["update"] },
				});
				expect(result.postInstall).toEqual({
					type: "run-command",
					command: "rustup",
					args: ["update"],
				});
			});

			it("accepts when postInstall.command matches tool package", () => {
				const result = ToolEntrySchema.parse({
					name: "rg",
					type: "cargo",
					package: "ripgrep",
					verify: { type: "binary-exists", name: "rg" },
					postInstall: { type: "run-command", command: "ripgrep", args: ["--update"] },
				});
				expect(result.postInstall).toEqual({
					type: "run-command",
					command: "ripgrep",
					args: ["--update"],
				});
			});

			it("rejects when postInstall.command does not match name or package", () => {
				expect(() =>
					ToolEntrySchema.parse({
						name: "rg",
						type: "cargo",
						package: "ripgrep",
						verify: { type: "binary-exists", name: "rg" },
						postInstall: { type: "run-command", command: "bash", args: ["-c", "rg --update"] },
					}),
				).toThrow("verify/postInstall commands must reference the tool's own binary");
			});
		});
	});

	describe("ToolManifestSchema", () => {
		const validManifest = {
			version: 1 as const,
			discoveredAt: BASE_DATE,
			sourcePlatform: "darwin" as const,
			tools: [
				{
					name: "git",
					type: "system" as const,
					verify: { type: "binary-exists" as const, name: "git" },
				},
			],
		};

		it("parses a valid manifest", () => {
			const result = ToolManifestSchema.parse(validManifest);
			expect(result.version).toBe(1);
			expect(result.sourcePlatform).toBe("darwin");
			expect(result.tools).toHaveLength(1);
		});

		it("defaults autoInstall to false", () => {
			const result = ToolManifestSchema.parse(validManifest);
			expect(result.autoInstall).toBe(false);
		});

		it("accepts autoInstall: true", () => {
			const result = ToolManifestSchema.parse({ ...validManifest, autoInstall: true });
			expect(result.autoInstall).toBe(true);
		});

		it("rejects version other than 1", () => {
			expect(() => ToolManifestSchema.parse({ ...validManifest, version: 2 })).toThrow();
		});

		it("rejects invalid discoveredAt (non-datetime string)", () => {
			expect(() =>
				ToolManifestSchema.parse({ ...validManifest, discoveredAt: "not-a-date" }),
			).toThrow();
		});

		it("rejects unknown sourcePlatform", () => {
			expect(() =>
				ToolManifestSchema.parse({ ...validManifest, sourcePlatform: "freebsd" }),
			).toThrow();
		});

		it("accepts linux and win32 platforms", () => {
			expect(
				ToolManifestSchema.parse({ ...validManifest, sourcePlatform: "linux" }).sourcePlatform,
			).toBe("linux");
			expect(
				ToolManifestSchema.parse({ ...validManifest, sourcePlatform: "win32" }).sourcePlatform,
			).toBe("win32");
		});

		it("accepts an empty tools array", () => {
			const result = ToolManifestSchema.parse({ ...validManifest, tools: [] });
			expect(result.tools).toHaveLength(0);
		});
	});
});
