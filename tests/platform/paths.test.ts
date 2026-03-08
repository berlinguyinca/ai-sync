import { describe, expect, it } from "vitest";
import { normalizePath } from "../../src/platform/paths.js";

describe("normalizePath", () => {
	it("converts backslashes to forward slashes", () => {
		expect(normalizePath("agents\\default.md")).toBe("agents/default.md");
	});

	it("leaves forward slashes unchanged (no-op on POSIX)", () => {
		expect(normalizePath("agents/default.md")).toBe("agents/default.md");
	});

	it("handles deeply nested Windows-style paths", () => {
		expect(normalizePath("plugins\\marketplaces\\custom.json")).toBe(
			"plugins/marketplaces/custom.json",
		);
	});

	it("returns single-segment paths unchanged", () => {
		expect(normalizePath("settings.json")).toBe("settings.json");
	});

	it("returns empty string for empty input", () => {
		expect(normalizePath("")).toBe("");
	});

	it("handles mixed separators", () => {
		expect(normalizePath("agents/skills\\my-skill/SKILL.md")).toBe(
			"agents/skills/my-skill/SKILL.md",
		);
	});

	it("handles multiple consecutive backslashes", () => {
		expect(normalizePath("a\\\\b\\c")).toBe("a//b/c");
	});
});
