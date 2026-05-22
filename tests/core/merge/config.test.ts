import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMergeConfig, loadMergeConfig } from "../../../src/core/merge/config.js";

let syncRepoDir: string;

beforeEach(async () => {
	syncRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-config-test-"));
});

afterEach(async () => {
	await fs.rm(syncRepoDir, { recursive: true, force: true });
});

describe("loadMergeConfig()", () => {
	it("returns schema defaults when the file is absent", async () => {
		const cfg = await loadMergeConfig(syncRepoDir);
		expect(cfg.enabled).toBe(false);
		expect(cfg.resolver).toBe("claude");
		expect(cfg.autoApply).toBe(false);
		expect(cfg.timeoutSeconds).toBe(60);
		expect(cfg.perType["*.md"]).toBe("ai-freeform");
	});

	it("merges partial config with defaults", async () => {
		await fs.mkdir(path.join(syncRepoDir, "tools"), { recursive: true });
		await fs.writeFile(
			path.join(syncRepoDir, "tools", "merge-config.json"),
			JSON.stringify({ enabled: true, resolver: "codex" }),
			"utf-8",
		);
		const cfg = await loadMergeConfig(syncRepoDir);
		expect(cfg.enabled).toBe(true);
		expect(cfg.resolver).toBe("codex");
		expect(cfg.autoApply).toBe(false); // still default
		expect(cfg.timeoutSeconds).toBe(60); // still default
	});

	it("throws on invalid JSON", async () => {
		await fs.mkdir(path.join(syncRepoDir, "tools"), { recursive: true });
		await fs.writeFile(path.join(syncRepoDir, "tools", "merge-config.json"), "{not json", "utf-8");
		await expect(loadMergeConfig(syncRepoDir)).rejects.toThrow(/Invalid JSON/);
	});

	it("throws on schema mismatch (e.g. unknown resolver)", async () => {
		await fs.mkdir(path.join(syncRepoDir, "tools"), { recursive: true });
		await fs.writeFile(
			path.join(syncRepoDir, "tools", "merge-config.json"),
			JSON.stringify({ resolver: "gpt" }),
			"utf-8",
		);
		await expect(loadMergeConfig(syncRepoDir)).rejects.toThrow();
	});

	it("throws on negative timeout", async () => {
		await fs.mkdir(path.join(syncRepoDir, "tools"), { recursive: true });
		await fs.writeFile(
			path.join(syncRepoDir, "tools", "merge-config.json"),
			JSON.stringify({ timeoutSeconds: -1 }),
			"utf-8",
		);
		await expect(loadMergeConfig(syncRepoDir)).rejects.toThrow();
	});
});

describe("defaultMergeConfig()", () => {
	it("returns the same defaults as the loader for an absent file", () => {
		const cfg = defaultMergeConfig();
		expect(cfg.enabled).toBe(false);
		expect(cfg.resolver).toBe("claude");
		expect(cfg.timeoutSeconds).toBe(60);
	});
});
