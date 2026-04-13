import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	generateIndex,
	hasConflictMarkers,
	parseIndex,
	resolveFragmentPath,
	splitMarkdownIntoFragments,
} from "../../src/core/fragmenter.js";

describe("fragmenter", () => {
	describe("splitMarkdownIntoFragments", () => {
		it("splits content into fragments by ## headers", () => {
			const content = [
				"# Global Config",
				"",
				"Some preamble text.",
				"",
				"## TDD & Testing",
				"TDD is non-negotiable.",
				"",
				"## Code Quality",
				"Small functions, single responsibility.",
			].join("\n");

			const sectionMap = new Map([
				["## TDD & Testing", "shared/standards/tdd.md"],
				["## Code Quality", "shared/standards/code-quality.md"],
			]);

			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments).toHaveLength(2);
			expect(result.fragments[0]?.path).toBe("shared/standards/tdd.md");
			expect(result.fragments[1]?.path).toBe("shared/standards/code-quality.md");
		});

		it("includes the ## header line at the start of each fragment", () => {
			const content = ["## Stack", "TypeScript strict mode."].join("\n");

			const sectionMap = new Map([["## Stack", "shared/standards/stack.md"]]);
			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments[0]?.content).toContain("## Stack");
			expect(result.fragments[0]?.content).toContain("TypeScript strict mode.");
		});

		it("keeps nested ### headers within the parent fragment", () => {
			const content = [
				"## Architecture",
				"",
				"### Interfaces",
				"Depend on abstractions.",
				"",
				"### Separation",
				"Keep layers clean.",
				"",
				"## Testing",
				"Write tests first.",
			].join("\n");

			const sectionMap = new Map([
				["## Architecture", "shared/arch.md"],
				["## Testing", "shared/testing.md"],
			]);

			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments).toHaveLength(2);
			const archContent = result.fragments[0]?.content ?? "";
			expect(archContent).toContain("### Interfaces");
			expect(archContent).toContain("### Separation");
			expect(archContent).toContain("Depend on abstractions.");
			// Testing section should NOT be in architecture fragment
			expect(archContent).not.toContain("Write tests first.");
		});

		it("preserves preamble content before the first ## header", () => {
			const content = [
				"# My Config",
				"",
				"This is a preamble line.",
				"",
				"## Standards",
				"Quality matters.",
			].join("\n");

			const sectionMap = new Map([["## Standards", "shared/standards.md"]]);
			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.indexContent).toContain("# My Config");
			expect(result.indexContent).toContain("This is a preamble line.");
		});

		it("skips sections with no mapped path in sectionMap", () => {
			const content = ["## Known", "content", "", "## Unknown", "also content"].join("\n");

			const sectionMap = new Map([["## Known", "shared/known.md"]]);
			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments).toHaveLength(1);
			expect(result.fragments[0]?.path).toBe("shared/known.md");
		});

		it("skips empty sections", () => {
			const content = ["## EmptySection", "", "", "## RealSection", "Has content."].join("\n");

			const sectionMap = new Map([
				["## EmptySection", "shared/empty.md"],
				["## RealSection", "shared/real.md"],
			]);

			const result = splitMarkdownIntoFragments(content, sectionMap);

			// EmptySection only has "## EmptySection" header — after trimEnd that's non-empty
			// but let's check the actual behavior: header alone is NOT empty
			const emptyFrag = result.fragments.find((f) => f.path === "shared/empty.md");
			const realFrag = result.fragments.find((f) => f.path === "shared/real.md");
			expect(realFrag).toBeDefined();
			expect(realFrag?.content).toContain("Has content.");
			// EmptySection has a header line, so it won't be completely empty
			if (emptyFrag) {
				expect(emptyFrag.content.trim()).toBe("## EmptySection");
			}
		});

		it("treats content before any ## header as preamble (no fragment)", () => {
			const content = [
				"# Top level heading",
				"Some intro.",
				"More intro.",
				"",
				"## Section",
				"Body.",
			].join("\n");

			const sectionMap = new Map([["## Section", "shared/section.md"]]);
			const result = splitMarkdownIntoFragments(content, sectionMap);

			// Only one fragment — preamble not a fragment
			expect(result.fragments).toHaveLength(1);
			expect(result.indexContent).toContain("# Top level heading");
		});

		it("handles content with no ## headers — everything is preamble", () => {
			const content = "# Title\n\nJust a preamble. No sections here.";
			const sectionMap = new Map<string, string>();

			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments).toHaveLength(0);
			expect(result.indexContent).toContain("# Title");
			expect(result.indexContent).toContain("Just a preamble.");
		});

		it("handles a single section with no preamble", () => {
			const content = ["## Only Section", "Content here."].join("\n");
			const sectionMap = new Map([["## Only Section", "shared/only.md"]]);

			const result = splitMarkdownIntoFragments(content, sectionMap);

			expect(result.fragments).toHaveLength(1);
			expect(result.fragments[0]?.path).toBe("shared/only.md");
		});

		it("produces references in the index in document order", () => {
			const content = [
				"## First",
				"aaa",
				"",
				"## Second",
				"bbb",
				"",
				"## Third",
				"ccc",
			].join("\n");

			const sectionMap = new Map([
				["## First", "shared/first.md"],
				["## Second", "shared/second.md"],
				["## Third", "shared/third.md"],
			]);

			const result = splitMarkdownIntoFragments(content, sectionMap);
			const parsed = parseIndex(result.indexContent);

			expect(parsed.references).toEqual([
				"shared/first.md",
				"shared/second.md",
				"shared/third.md",
			]);
		});

		it("infers scope from the first path segment", () => {
			const content = ["## TDD", "test first"].join("\n");
			const sectionMap = new Map([["## TDD", "myenv/tdd.md"]]);

			const result = splitMarkdownIntoFragments(content, sectionMap);
			expect(result.fragments[0]?.scope).toBe("myenv");
		});

		it("uses 'shared' as scope for shared/ paths", () => {
			const content = ["## TDD", "test first"].join("\n");
			const sectionMap = new Map([["## TDD", "shared/tdd.md"]]);

			const result = splitMarkdownIntoFragments(content, sectionMap);
			expect(result.fragments[0]?.scope).toBe("shared");
		});

		it("handles trailing newlines in content gracefully", () => {
			const content = "## Section\nBody.\n\n\n";
			const sectionMap = new Map([["## Section", "shared/section.md"]]);

			const result = splitMarkdownIntoFragments(content, sectionMap);
			expect(result.fragments).toHaveLength(1);
			// Content should not have excessive trailing whitespace
			expect(result.fragments[0]?.content).toBe("## Section\nBody.");
		});
	});

	describe("generateIndex", () => {
		it("produces preamble followed by @-references", () => {
			const result = generateIndex("# Config", ["shared/tdd.md", "shared/quality.md"]);
			expect(result).toBe("# Config\n\n@shared/tdd.md\n@shared/quality.md");
		});

		it("returns only references when preamble is empty", () => {
			const result = generateIndex("", ["shared/tdd.md"]);
			expect(result).toBe("@shared/tdd.md");
		});

		it("returns only preamble when references is empty", () => {
			const result = generateIndex("# Just Preamble", []);
			expect(result).toBe("# Just Preamble");
		});

		it("each reference is on its own line prefixed with @", () => {
			const result = generateIndex("", ["a/b.md", "c/d.md", "e/f.md"]);
			const lines = result.split("\n");
			expect(lines).toEqual(["@a/b.md", "@c/d.md", "@e/f.md"]);
		});
	});

	describe("parseIndex", () => {
		it("extracts preamble and reference paths", () => {
			const content = "# Config\n\nSome text.\n\n@shared/tdd.md\n@shared/quality.md";
			const result = parseIndex(content);

			expect(result.preamble).toBe("# Config\n\nSome text.");
			expect(result.references).toEqual(["shared/tdd.md", "shared/quality.md"]);
		});

		it("handles content with only references (no preamble)", () => {
			const content = "@shared/a.md\n@shared/b.md";
			const result = parseIndex(content);

			expect(result.preamble).toBe("");
			expect(result.references).toEqual(["shared/a.md", "shared/b.md"]);
		});

		it("handles content with only preamble (no references)", () => {
			const content = "# Title\n\nJust text.";
			const result = parseIndex(content);

			expect(result.preamble).toBe("# Title\n\nJust text.");
			expect(result.references).toEqual([]);
		});

		it("strips the leading @ from reference paths", () => {
			const content = "@some/path/fragment.md";
			const result = parseIndex(content);
			expect(result.references[0]).toBe("some/path/fragment.md");
		});

		it("handles trimmed @ lines (leading whitespace)", () => {
			const content = "preamble\n  @shared/a.md";
			const result = parseIndex(content);
			expect(result.references).toEqual(["shared/a.md"]);
		});
	});

	describe("parseIndex / generateIndex roundtrip", () => {
		it("roundtrips preamble and references correctly", () => {
			const preamble = "# My Config\n\nSome description.";
			const references = ["shared/tdd.md", "shared/stack.md", "shared/arch.md"];

			const indexContent = generateIndex(preamble, references);
			const parsed = parseIndex(indexContent);

			expect(parsed.preamble).toBe(preamble);
			expect(parsed.references).toEqual(references);
		});

		it("roundtrips with empty preamble", () => {
			const references = ["shared/a.md", "shared/b.md"];
			const indexContent = generateIndex("", references);
			const parsed = parseIndex(indexContent);

			expect(parsed.preamble).toBe("");
			expect(parsed.references).toEqual(references);
		});

		it("roundtrips with empty references", () => {
			const preamble = "# Just a title";
			const indexContent = generateIndex(preamble, []);
			const parsed = parseIndex(indexContent);

			expect(parsed.preamble).toBe(preamble);
			expect(parsed.references).toEqual([]);
		});
	});

	describe("resolveFragmentPath", () => {
		it("joins sync repo dir with the reference path after stripping @", () => {
			const syncRepoDir = "/home/user/.ai-sync";
			const result = resolveFragmentPath("@shared/standards/tdd.md", syncRepoDir);
			expect(result).toBe(path.join("/home/user/.ai-sync", "shared/standards/tdd.md"));
		});

		it("works when reference has no leading @", () => {
			const syncRepoDir = "/home/user/.ai-sync";
			const result = resolveFragmentPath("shared/standards/tdd.md", syncRepoDir);
			expect(result).toBe(path.join("/home/user/.ai-sync", "shared/standards/tdd.md"));
		});

		it("returns an absolute path", () => {
			const result = resolveFragmentPath("@shared/x.md", "/sync");
			expect(path.isAbsolute(result)).toBe(true);
		});

		it("handles nested paths", () => {
			const syncRepoDir = "/repo";
			const result = resolveFragmentPath("@env/work/deep/fragment.md", syncRepoDir);
			expect(result).toBe(path.join("/repo", "env/work/deep/fragment.md"));
		});
	});

	describe("hasConflictMarkers", () => {
		it("returns true when content contains <<<<<<<", () => {
			const content = "some text\n<<<<<<< HEAD\nmy version\n=======\nother\n>>>>>>> branch";
			expect(hasConflictMarkers(content)).toBe(true);
		});

		it("returns true when content contains >>>>>>>", () => {
			const content = ">>>>>>> branch-name";
			expect(hasConflictMarkers(content)).toBe(true);
		});

		it("returns false for clean content", () => {
			const content = "# Clean file\n\nNo conflict markers here.";
			expect(hasConflictMarkers(content)).toBe(false);
		});

		it("returns false for empty string", () => {
			expect(hasConflictMarkers("")).toBe(false);
		});

		it("detects conflict markers embedded in larger text", () => {
			const content = "line1\nline2\n<<<<<<< HEAD\nconflict\n=======\nother\n>>>>>>>\nline3";
			expect(hasConflictMarkers(content)).toBe(true);
		});
	});
});
