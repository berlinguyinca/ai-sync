import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/paths.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getInstallDir: () => testInstallDir,
	};
});

let testInstallDir: string;

import {
	getEnabledEnvironments,
	isAutoDetecting,
	resetEnvironmentConfig,
	setEnabledEnvironments,
} from "../../src/core/env-config.js";
import { ALL_ENVIRONMENTS, getEnvironmentById } from "../../src/core/environment.js";
import { registerEnvCommand } from "../../src/cli/commands/env.js";

describe("env command logic", () => {
	beforeEach(() => {
		testInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cmd-test-"));
	});

	afterEach(() => {
		fs.rmSync(testInstallDir, { recursive: true, force: true });
	});

	describe("env list", () => {
		it("all known environments are listed", () => {
			expect(ALL_ENVIRONMENTS.length).toBeGreaterThanOrEqual(2);
			const ids = ALL_ENVIRONMENTS.map((e) => e.id);
			expect(ids).toContain("claude");
			expect(ids).toContain("opencode");
		});

		it("each environment has a display name and config dir", () => {
			for (const env of ALL_ENVIRONMENTS) {
				expect(env.displayName).toBeTruthy();
				expect(env.getConfigDir()).toBeTruthy();
			}
		});
	});

	describe("env enable", () => {
		it("enables a new environment explicitly", () => {
			// Start with explicit config so we control the baseline
			setEnabledEnvironments(["claude"]);
			expect(getEnabledEnvironments()).toEqual(["claude"]);

			setEnabledEnvironments(["claude", "opencode"]);
			expect(getEnabledEnvironments()).toEqual(["claude", "opencode"]);
		});

		it("rejects unknown environment ids", () => {
			expect(() => setEnabledEnvironments(["claude", "unknown"])).toThrow(/Unknown environment/);
		});

		it("is idempotent — enabling already-enabled env is safe", () => {
			setEnabledEnvironments(["claude"]);
			const before = getEnabledEnvironments();
			setEnabledEnvironments(["claude"]);
			expect(getEnabledEnvironments()).toEqual(before);
		});
	});

	describe("env disable", () => {
		it("disables an environment by filtering it out", () => {
			setEnabledEnvironments(["claude", "opencode"]);
			setEnabledEnvironments(["claude"]);
			expect(getEnabledEnvironments()).toEqual(["claude"]);
		});

		it("cannot disable all environments", () => {
			expect(() => setEnabledEnvironments([])).toThrow(/at least one environment/i);
		});
	});

	describe("env reset", () => {
		it("removes config and switches back to auto-detect", () => {
			setEnabledEnvironments(["claude"]);
			expect(isAutoDetecting()).toBe(false);

			resetEnvironmentConfig();
			expect(isAutoDetecting()).toBe(true);
			// Auto-detect should find at least claude
			expect(getEnabledEnvironments()).toContain("claude");
		});
	});

	describe("getEnvironmentById", () => {
		it("returns environment for known ids", () => {
			expect(getEnvironmentById("claude")).toBeDefined();
			expect(getEnvironmentById("opencode")).toBeDefined();
		});

		it("returns undefined for unknown ids", () => {
			expect(getEnvironmentById("unknown")).toBeUndefined();
		});
	});
});

describe("env CLI wrapper (registerEnvCommand)", () => {
	let program: Command;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		testInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cli-test-"));
		program = new Command();
		program.exitOverride();
		registerEnvCommand(program);
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		fs.rmSync(testInstallDir, { recursive: true, force: true });
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = undefined;
	});

	describe("env list action", () => {
		it("prints all known environments with their status", async () => {
			await program.parseAsync(["node", "test", "env", "list"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			// Should list all environments
			for (const env of ALL_ENVIRONMENTS) {
				expect(output).toContain(env.id);
			}
		});

		it("shows auto-detect mode when no explicit config", async () => {
			resetEnvironmentConfig();
			await program.parseAsync(["node", "test", "env", "list"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("auto-detect");
		});

		it("shows manual mode when explicit config exists", async () => {
			setEnabledEnvironments(["claude"]);
			await program.parseAsync(["node", "test", "env", "list"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("manual");
		});
	});

	describe("env enable action", () => {
		it("enables a valid environment and prints success", async () => {
			setEnabledEnvironments(["claude"]);
			await program.parseAsync(["node", "test", "env", "enable", "opencode"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("Enabled");
			expect(getEnabledEnvironments()).toContain("opencode");
		});

		it("prints already-enabled for a duplicate enable", async () => {
			setEnabledEnvironments(["claude"]);
			await program.parseAsync(["node", "test", "env", "enable", "claude"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("already enabled");
		});

		it("prints error for unknown environment id", async () => {
			await program.parseAsync(["node", "test", "env", "enable", "nonexistent"]);

			const output = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("Unknown environment");
			expect(process.exitCode).toBe(1);
		});
	});

	describe("env disable action", () => {
		it("disables a valid enabled environment", async () => {
			setEnabledEnvironments(["claude", "opencode"]);
			await program.parseAsync(["node", "test", "env", "disable", "opencode"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("Disabled");
			expect(getEnabledEnvironments()).not.toContain("opencode");
		});

		it("prints already-disabled for a non-enabled environment", async () => {
			setEnabledEnvironments(["claude"]);
			await program.parseAsync(["node", "test", "env", "disable", "opencode"]);

			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("already disabled");
		});

		it("refuses to disable the last remaining environment", async () => {
			setEnabledEnvironments(["claude"]);
			await program.parseAsync(["node", "test", "env", "disable", "claude"]);

			const output = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("Cannot disable all");
			expect(process.exitCode).toBe(1);
		});

		it("prints error for unknown environment id", async () => {
			await program.parseAsync(["node", "test", "env", "disable", "nonexistent"]);

			const output = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("Unknown environment");
			expect(process.exitCode).toBe(1);
		});
	});

	describe("env reset action", () => {
		it("resets to auto-detect and prints detected environments", async () => {
			setEnabledEnvironments(["claude"]);
			expect(isAutoDetecting()).toBe(false);

			await program.parseAsync(["node", "test", "env", "reset"]);

			expect(isAutoDetecting()).toBe(true);
			const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
			expect(output).toContain("auto-detect");
		});
	});
});
