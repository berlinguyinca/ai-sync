import { describe, expect, it, vi } from "vitest";
import { defaultMergeConfig } from "../../../src/core/merge/config.js";
import type { MergeInput, MergeResolver } from "../../../src/core/merge/resolver.js";
import { classify, mergeWithStrategy } from "../../../src/core/merge/strategies.js";

function fakeResolver(merged: string): MergeResolver & { calls: number } {
	const out = {
		name: "fake",
		calls: 0,
		async available() {
			return true;
		},
		async resolve() {
			out.calls++;
			return { mergedContent: merged };
		},
	};
	return out;
}

const baseInput = (relativePath: string): Omit<MergeInput, "fileType"> => ({
	relativePath,
	envName: "claude",
	base: "B",
	local: "L",
	remote: "R",
});

describe("classify()", () => {
	it("matches the orchestrator's classifyFile()", () => {
		expect(classify("a.md").kind).toBe("markdown");
		expect(classify("a.json").kind).toBe("json");
		expect(classify("a.yaml").kind).toBe("yaml");
		expect(classify("Makefile").kind).toBe("unknown");
	});
});

describe("mergeWithStrategy()", () => {
	const cfg = defaultMergeConfig();

	it("markdown passes resolver output through verbatim", async () => {
		const r = fakeResolver("# merged content\n");
		const result = await mergeWithStrategy(baseInput("CLAUDE.md"), r, cfg);
		expect(r.calls).toBe(1);
		expect(result.ok).toBe(true);
		expect(result.ok && result.mergedContent).toBe("# merged content\n");
		expect(result.fileType.kind).toBe("markdown");
	});

	it("valid JSON passes parse-validation", async () => {
		const r = fakeResolver('{"a": 1, "b": [2, 3]}');
		const result = await mergeWithStrategy(baseInput("settings.json"), r, cfg);
		expect(result.ok).toBe(true);
		expect(result.ok && result.mergedContent).toBe('{"a": 1, "b": [2, 3]}');
	});

	it("invalid JSON returns ok=false reason=json-parse", async () => {
		const r = fakeResolver('{"a": 1,'); // truncated
		const result = await mergeWithStrategy(baseInput("settings.json"), r, cfg);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("json-parse");
	});

	it("valid YAML passes parse-validation", async () => {
		const r = fakeResolver("a: 1\nb:\n  - 2\n  - 3\n");
		const result = await mergeWithStrategy(baseInput("config.yaml"), r, cfg);
		expect(result.ok).toBe(true);
		expect(result.fileType.kind).toBe("yaml");
	});

	it("invalid YAML returns ok=false reason=yaml-parse", async () => {
		const r = fakeResolver("a: 1\n  b: : :\n\t- bad indent"); // tab+invalid
		const result = await mergeWithStrategy(baseInput("config.yaml"), r, cfg);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("yaml-parse");
	});

	it("unknown extension returns ok=false reason=unsupported-type", async () => {
		const r = fakeResolver("anything");
		const result = await mergeWithStrategy(baseInput("Makefile"), r, cfg);
		expect(r.calls).toBe(0);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("unsupported-type");
	});

	it("perType override forces keep-local on *.lock without calling resolver", async () => {
		const r = fakeResolver("would have merged");
		const result = await mergeWithStrategy(baseInput("package-lock.json"), r, {
			perType: { "*.json": "keep-local" },
		});
		expect(r.calls).toBe(0);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("keep-local-override");
	});

	it("perType override: *.md → ai-validated treats markdown as JSON-shaped", async () => {
		const r = fakeResolver("not json");
		const result = await mergeWithStrategy(baseInput("note.md"), r, {
			perType: { "*.md": "ai-validated" },
		});
		expect(r.calls).toBe(1);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("json-parse");
	});

	it("perType override: *.md → ai-validated with valid JSON content passes", async () => {
		const r = fakeResolver('{"ok":true}');
		const result = await mergeWithStrategy(baseInput("note.md"), r, {
			perType: { "*.md": "ai-validated" },
		});
		expect(result.ok).toBe(true);
	});

	it("perType *.lock → keep-local short-circuits", async () => {
		const r = fakeResolver("x");
		const result = await mergeWithStrategy(baseInput("yarn.lock"), r, {
			perType: { "*.lock": "keep-local", "*": "ai-freeform" },
		});
		expect(r.calls).toBe(0);
		expect(result.ok).toBe(false);
	});

	it("does not propagate resolver exceptions — caller handles them", async () => {
		const resolver: MergeResolver = {
			name: "boom",
			available: async () => true,
			resolve: vi.fn().mockRejectedValue(new Error("nope")),
		};
		await expect(mergeWithStrategy(baseInput("a.md"), resolver, cfg)).rejects.toThrow("nope");
	});
});
