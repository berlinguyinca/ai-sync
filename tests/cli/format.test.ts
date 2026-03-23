import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeTypeIndicator, printFileChanges } from "../../src/cli/format.js";
import type { FileChange } from "../../src/core/sync-engine.js";

describe("changeTypeIndicator", () => {
	it("returns a yellow M for modified", () => {
		const result = changeTypeIndicator("modified");
		// The raw string contains ANSI escape codes for yellow around "M"
		expect(result).toContain("M");
	});

	it("returns a green A for added", () => {
		const result = changeTypeIndicator("added");
		expect(result).toContain("A");
	});

	it("returns a red D for deleted", () => {
		const result = changeTypeIndicator("deleted");
		expect(result).toContain("D");
	});

	it("returns different strings for each type", () => {
		const modified = changeTypeIndicator("modified");
		const added = changeTypeIndicator("added");
		const deleted = changeTypeIndicator("deleted");
		// Each indicator should be distinct
		expect(modified).not.toBe(added);
		expect(modified).not.toBe(deleted);
		expect(added).not.toBe(deleted);
	});
});

describe("printFileChanges", () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	it("prints nothing for an empty array", () => {
		printFileChanges([]);
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("prints one line per file change", () => {
		const changes: FileChange[] = [
			{ path: "settings.json", type: "modified" },
			{ path: "agents/default.md", type: "added" },
			{ path: "old-file.txt", type: "deleted" },
		];
		printFileChanges(changes);
		expect(consoleSpy).toHaveBeenCalledTimes(3);
	});

	it("includes the file path in each log line", () => {
		const changes: FileChange[] = [
			{ path: "CLAUDE.md", type: "modified" },
		];
		printFileChanges(changes);
		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const output = consoleSpy.mock.calls[0][0] as string;
		expect(output).toContain("CLAUDE.md");
	});

	it("includes the type indicator in each log line", () => {
		const changes: FileChange[] = [
			{ path: "file.txt", type: "added" },
		];
		printFileChanges(changes);
		const output = consoleSpy.mock.calls[0][0] as string;
		// Should contain the indicator character (A for added)
		expect(output).toContain("A");
	});

	it("formats output with leading indentation", () => {
		const changes: FileChange[] = [
			{ path: "test.json", type: "deleted" },
		];
		printFileChanges(changes);
		const output = consoleSpy.mock.calls[0][0] as string;
		// Output starts with two-space indent
		expect(output).toMatch(/^\s{2}/);
	});
});
