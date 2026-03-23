import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to mock getInstallDir since it walks up from the running script
vi.mock("../../src/platform/paths.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getInstallDir: () => testInstallDir,
	};
});

let testInstallDir: string;

import {
	getEnabledEnvironmentInstances,
	getEnabledEnvironments,
	isAutoDetecting,
	resetEnvironmentConfig,
	setEnabledEnvironments,
} from "../../src/core/env-config.js";

describe("env-config", () => {
	beforeEach(() => {
		testInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-config-test-"));
	});

	afterEach(() => {
		fs.rmSync(testInstallDir, { recursive: true, force: true });
	});

	describe("getEnabledEnvironments", () => {
		it("auto-detects installed environments when no config file exists", () => {
			const result = getEnabledEnvironments();
			// Should contain at least "claude" (since ~/.claude exists on dev machines)
			// and may contain "opencode" if installed.  The key point is that it
			// doesn't return an empty list and every id is a known environment.
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result).toContain("claude");
		});

		it("reads environments from config file", () => {
			fs.writeFileSync(
				path.join(testInstallDir, ".environments.json"),
				JSON.stringify(["claude", "codex"]),
			);
			const result = getEnabledEnvironments();
			expect(result).toEqual(["claude", "codex"]);
		});

		it("falls back to auto-detect if config file is malformed", () => {
			fs.writeFileSync(path.join(testInstallDir, ".environments.json"), "not valid json");
			const result = getEnabledEnvironments();
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result).toContain("claude");
		});

		it("falls back to auto-detect if config contains non-strings", () => {
			fs.writeFileSync(path.join(testInstallDir, ".environments.json"), JSON.stringify([1, 2, 3]));
			const result = getEnabledEnvironments();
			expect(result.length).toBeGreaterThanOrEqual(1);
			expect(result).toContain("claude");
		});
	});

	describe("setEnabledEnvironments", () => {
		it("writes environments to config file", () => {
			setEnabledEnvironments(["claude", "codex"]);
			const content = fs.readFileSync(path.join(testInstallDir, ".environments.json"), "utf-8");
			expect(JSON.parse(content)).toEqual(["claude", "codex"]);
		});

		it("throws for unknown environment id", () => {
			expect(() => setEnabledEnvironments(["unknown"])).toThrow(/Unknown environment/);
		});

		it("throws when trying to set empty array", () => {
			expect(() => setEnabledEnvironments([])).toThrow(/at least one environment/i);
		});
	});

	describe("isAutoDetecting", () => {
		it("returns true when no config file exists", () => {
			expect(isAutoDetecting()).toBe(true);
		});

		it("returns false after setEnabledEnvironments is called", () => {
			setEnabledEnvironments(["claude"]);
			expect(isAutoDetecting()).toBe(false);
		});
	});

	describe("resetEnvironmentConfig", () => {
		it("removes config file and restores auto-detect", () => {
			setEnabledEnvironments(["claude"]);
			expect(isAutoDetecting()).toBe(false);
			resetEnvironmentConfig();
			expect(isAutoDetecting()).toBe(true);
		});

		it("is safe to call when no config file exists", () => {
			expect(() => resetEnvironmentConfig()).not.toThrow();
		});
	});

	describe("getEnabledEnvironmentInstances", () => {
		it("returns Environment instances for enabled envs", () => {
			fs.writeFileSync(path.join(testInstallDir, ".environments.json"), JSON.stringify(["claude"]));
			const instances = getEnabledEnvironmentInstances();
			expect(instances).toHaveLength(1);
			expect(instances[0].id).toBe("claude");
		});

		it("returns multiple environments when configured", () => {
			fs.writeFileSync(
				path.join(testInstallDir, ".environments.json"),
				JSON.stringify(["claude", "codex"]),
			);
			const instances = getEnabledEnvironmentInstances();
			expect(instances).toHaveLength(2);
			expect(instances.map((e) => e.id)).toEqual(["claude", "codex"]);
		});
	});
});
