import { describe, expect, it } from "vitest";
import {
	buildMergePrompt,
	buildSummaryPrompt,
	type SummaryDiffData,
} from "../../../src/core/merge/prompts.js";

describe("buildMergePrompt", () => {
	it("includes all three sides and the relative path", () => {
		const prompt = buildMergePrompt("CLAUDE.md", "base", "local", "remote", { kind: "markdown" });
		expect(prompt).toContain("CLAUDE.md");
		expect(prompt).toContain("<BASE>\nbase");
		expect(prompt).toContain("<LOCAL>\nlocal");
		expect(prompt).toContain("<REMOTE>\nremote");
		expect(prompt).toContain("type: markdown");
	});

	it("handles null base as a 'no common ancestor' note", () => {
		const prompt = buildMergePrompt("a.md", null, "L", "R", { kind: "markdown" });
		expect(prompt).toContain("no common ancestor");
	});
});

describe("buildSummaryPrompt", () => {
	const sample: SummaryDiffData = {
		localOnly: [{ relativePath: "CLAUDE.md", side: "local" }],
		remoteOnly: [{ relativePath: "settings.json", side: "remote", snippet: "theme: dark" }],
		bothChanged: [{ relativePath: "commands/foo.md", side: "both" }],
	};

	it("includes the env name in the preamble", () => {
		const prompt = buildSummaryPrompt("claude", sample);
		expect(prompt).toContain('"claude"');
	});

	it("lists files in their respective buckets", () => {
		const prompt = buildSummaryPrompt("claude", sample);
		expect(prompt).toMatch(/<LOCAL_ONLY>[\s\S]*CLAUDE\.md[\s\S]*<\/LOCAL_ONLY>/);
		expect(prompt).toMatch(/<REMOTE_ONLY>[\s\S]*settings\.json[\s\S]*<\/REMOTE_ONLY>/);
		expect(prompt).toMatch(/<BOTH_CHANGED>[\s\S]*commands\/foo\.md[\s\S]*<\/BOTH_CHANGED>/);
	});

	it("indents snippets under their file paths", () => {
		const prompt = buildSummaryPrompt("claude", sample);
		expect(prompt).toContain("    theme: dark");
	});

	it("renders empty buckets as (none)", () => {
		const prompt = buildSummaryPrompt("opencode", {
			localOnly: [],
			remoteOnly: [],
			bothChanged: [],
		});
		expect(prompt.match(/\(none\)/g)?.length).toBe(3);
	});

	it("asks for prose only, no merges", () => {
		const prompt = buildSummaryPrompt("claude", sample);
		expect(prompt.toLowerCase()).toContain("summary");
		expect(prompt).toMatch(/Do not propose merges/);
	});
});
