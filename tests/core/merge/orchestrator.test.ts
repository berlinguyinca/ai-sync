import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMergeConfig } from "../../../src/core/merge/config.js";
import { classifyFile, tryAiMerge } from "../../../src/core/merge/index.js";
import type { MergeResolver } from "../../../src/core/merge/resolver.js";
import { listStaged } from "../../../src/core/merge/staging.js";

let syncRepoDir: string;

beforeEach(async () => {
	syncRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-orch-test-"));
});

afterEach(async () => {
	await fs.rm(syncRepoDir, { recursive: true, force: true });
});

function stubResolver(content: string): MergeResolver {
	return {
		name: "stub",
		async available() {
			return true;
		},
		async resolve() {
			return { mergedContent: content };
		},
	};
}

describe("classifyFile()", () => {
	it("identifies markdown by extension", () => {
		expect(classifyFile("CLAUDE.md").kind).toBe("markdown");
		expect(classifyFile("a.markdown").kind).toBe("markdown");
		expect(classifyFile("notes.txt").kind).toBe("markdown");
	});
	it("identifies json/yaml/unknown", () => {
		expect(classifyFile("a.json").kind).toBe("json");
		expect(classifyFile("a.yaml").kind).toBe("yaml");
		expect(classifyFile("a.yml").kind).toBe("yaml");
		const u = classifyFile("Makefile");
		expect(u.kind).toBe("unknown");
		expect(u.kind === "unknown" && u.extension).toBe("");
	});
});

describe("tryAiMerge()", () => {
	it("short-circuits to fallback when config.enabled is false", async () => {
		const cfg = defaultMergeConfig();
		expect(cfg.enabled).toBe(false);
		let called = false;
		const resolver: MergeResolver = {
			name: "spy",
			async available() {
				return true;
			},
			async resolve() {
				called = true;
				return { mergedContent: "x" };
			},
		};
		const result = await tryAiMerge(
			{
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: "B",
				local: "L",
				remote: "R",
			},
			{ config: cfg, resolver, syncRepoDir },
		);
		expect(result.kind).toBe("fallback");
		expect(result.kind === "fallback" && result.reason).toBe("disabled");
		expect(called).toBe(false);
	});

	it("stages merged content when enabled and autoApply=false", async () => {
		const cfg = { ...defaultMergeConfig(), enabled: true };
		const result = await tryAiMerge(
			{
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: "B",
				local: "L",
				remote: "R",
			},
			{ config: cfg, resolver: stubResolver("MERGED"), syncRepoDir },
		);
		expect(result.kind).toBe("staged");
		const staged = await listStaged(syncRepoDir);
		expect(staged).toHaveLength(1);
		const file = await fs.readFile(
			path.join(syncRepoDir, ".ai-sync", "pending", "claude", "CLAUDE.md"),
			"utf-8",
		);
		expect(file).toBe("MERGED");
	});

	it("returns applied (no stage) when autoApply=true", async () => {
		const cfg = { ...defaultMergeConfig(), enabled: true, autoApply: true };
		const result = await tryAiMerge(
			{
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: null,
				local: "L",
				remote: "R",
			},
			{ config: cfg, resolver: stubResolver("MERGED"), syncRepoDir },
		);
		expect(result.kind).toBe("applied");
		expect(result.kind === "applied" && result.mergedContent).toBe("MERGED");
		const staged = await listStaged(syncRepoDir);
		expect(staged).toHaveLength(0);
	});

	it("routes through mergeWithStrategy and falls back when JSON parse fails", async () => {
		const cfg = { ...defaultMergeConfig(), enabled: true };
		const warnings: string[] = [];
		const result = await tryAiMerge(
			{
				relativePath: "settings.json",
				envName: "claude",
				base: "{}",
				local: "{}",
				remote: "{}",
			},
			{
				config: cfg,
				resolver: stubResolver("{not json"),
				syncRepoDir,
				warn: (m) => warnings.push(m),
			},
		);
		expect(result.kind).toBe("fallback");
		expect(result.kind === "fallback" && result.reason).toBe("json-parse");
		expect(warnings.some((w) => w.includes("json-parse"))).toBe(true);
		// strategy fallback should NOT stage anything
		const staged = await listStaged(syncRepoDir);
		expect(staged).toHaveLength(0);
	});

	it("routes a markdown file through ai-freeform and stages verbatim", async () => {
		const cfg = { ...defaultMergeConfig(), enabled: true };
		const result = await tryAiMerge(
			{
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: null,
				local: "L",
				remote: "R",
			},
			{ config: cfg, resolver: stubResolver("# merged\n"), syncRepoDir },
		);
		expect(result.kind).toBe("staged");
	});

	it("returns fallback when the resolver throws — never propagates", async () => {
		const cfg = { ...defaultMergeConfig(), enabled: true };
		const resolver: MergeResolver = {
			name: "boom",
			async available() {
				return true;
			},
			async resolve() {
				throw new Error("kaboom");
			},
		};
		const warnings: string[] = [];
		const result = await tryAiMerge(
			{
				relativePath: "CLAUDE.md",
				envName: "claude",
				base: null,
				local: "L",
				remote: "R",
			},
			{ config: cfg, resolver, syncRepoDir, warn: (m) => warnings.push(m) },
		);
		expect(result.kind).toBe("fallback");
		expect(warnings.length).toBe(1);
	});
});
