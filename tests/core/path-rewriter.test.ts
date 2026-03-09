import { describe, expect, it } from "vitest";
import { expandPathsForLocal, rewritePathsForRepo } from "../../src/core/path-rewriter.js";

describe("path-rewriter", () => {
	describe("rewritePathsForRepo", () => {
		it("replaces home directory with {{HOME}} token", () => {
			const content = '{"path":"/Users/wohlgemuth/.claude/settings.json"}';
			const result = rewritePathsForRepo(content, "/Users/wohlgemuth");
			expect(JSON.parse(result).path).toBe("{{HOME}}/.claude/settings.json");
		});

		it("handles multiple path occurrences in one file", () => {
			const content = JSON.stringify({
				first: "/Users/wohlgemuth/.claude/a",
				second: "/Users/wohlgemuth/.claude/b",
			});
			const result = rewritePathsForRepo(content, "/Users/wohlgemuth");
			expect(result).not.toContain("/Users/wohlgemuth");
			const parsed = JSON.parse(result);
			expect(parsed.first).toBe("{{HOME}}/.claude/a");
			expect(parsed.second).toBe("{{HOME}}/.claude/b");
		});

		it("does not modify content without home dir paths", () => {
			const content = '{"key":"value","count":42}';
			const result = rewritePathsForRepo(content, "/Users/wohlgemuth");
			const parsed = JSON.parse(result);
			expect(parsed.key).toBe("value");
			expect(parsed.count).toBe(42);
		});

		it("handles home dirs with special regex characters", () => {
			const content = '{"path":"/home/user.name/.claude/config"}';
			const result = rewritePathsForRepo(content, "/home/user.name");
			expect(JSON.parse(result).path).toBe("{{HOME}}/.claude/config");
		});

		it("produces valid JSON with escaped quotes in values", () => {
			const content = JSON.stringify({
				command: 'node "/Users/wohlgemuth/.claude/hooks/test.js"',
			});
			const result = rewritePathsForRepo(content, "/Users/wohlgemuth");
			const parsed = JSON.parse(result);
			expect(parsed.command).toBe('node "{{HOME}}/.claude/hooks/test.js"');
		});

		it("preserves pretty-print formatting", () => {
			const content = JSON.stringify(
				{ path: "/Users/bob/.claude/x" },
				null,
				2,
			);
			const result = rewritePathsForRepo(content, "/Users/bob");
			expect(result).toContain("\n"); // still pretty-printed
			expect(JSON.parse(result).path).toBe("{{HOME}}/.claude/x");
		});

		it("preserves compact formatting", () => {
			const content = '{"path":"/Users/bob/.claude/x"}';
			const result = rewritePathsForRepo(content, "/Users/bob");
			expect(result).not.toContain("\n");
			expect(JSON.parse(result).path).toBe("{{HOME}}/.claude/x");
		});
	});

	describe("expandPathsForLocal", () => {
		it("replaces {{HOME}} token with provided home directory", () => {
			const content = '{"path":"{{HOME}}/.claude/settings.json"}';
			const result = expandPathsForLocal(content, "/Users/testuser");
			expect(JSON.parse(result).path).toBe("/Users/testuser/.claude/settings.json");
		});

		it("handles multiple token occurrences", () => {
			const content = JSON.stringify({
				first: "{{HOME}}/.claude/a",
				second: "{{HOME}}/.claude/b",
			});
			const result = expandPathsForLocal(content, "/home/linux-user");
			expect(result).not.toContain("{{HOME}}");
			const parsed = JSON.parse(result);
			expect(parsed.first).toBe("/home/linux-user/.claude/a");
			expect(parsed.second).toBe("/home/linux-user/.claude/b");
		});
	});

	describe("Windows backslash handling", () => {
		it("handles Windows-style home directory with backslashes", () => {
			const content = '{"p":"C:\\\\Users\\\\bob\\\\.claude\\\\hooks\\\\test.js"}';
			const result = rewritePathsForRepo(content, "C:\\Users\\bob");
			const parsed = JSON.parse(result);
			expect(parsed.p).toBe("{{HOME}}/.claude/hooks/test.js");
		});

		it("handles mixed separator content on Windows", () => {
			const content =
				'{"a":"C:\\\\Users\\\\bob/.claude/x","b":"C:\\\\Users\\\\bob\\\\.claude\\\\y"}';
			const result = rewritePathsForRepo(content, "C:\\Users\\bob");
			const parsed = JSON.parse(result);
			expect(parsed.a).toBe("{{HOME}}/.claude/x");
			expect(parsed.b).toBe("{{HOME}}/.claude/y");
		});

		it("roundtrips from Windows source to Linux target", () => {
			const windowsContent = '{"hook":"C:\\\\Users\\\\bob\\\\.claude\\\\hooks\\\\pre.sh"}';
			const rewritten = rewritePathsForRepo(windowsContent, "C:\\Users\\bob");
			const rewrittenParsed = JSON.parse(rewritten);
			expect(rewrittenParsed.hook).toBe("{{HOME}}/.claude/hooks/pre.sh");
			expect(rewrittenParsed.hook).not.toContain("\\");

			const expanded = expandPathsForLocal(rewritten, "/home/bob");
			const expandedParsed = JSON.parse(expanded);
			expect(expandedParsed.hook).toBe("/home/bob/.claude/hooks/pre.sh");
		});
	});

	describe("roundtrip", () => {
		it("preserves content structure through rewrite and expand", () => {
			const original = JSON.stringify(
				{
					editor: "/Users/machineA/.claude/extensions/vscode",
					backup: "/Users/machineA/.config/backup",
					plain: "no paths here",
				},
				null,
				2,
			);
			const rewritten = rewritePathsForRepo(original, "/Users/machineA");
			const expanded = expandPathsForLocal(rewritten, "/home/machineB");

			expect(expanded).toContain("/home/machineB/.claude/extensions/vscode");
			expect(expanded).toContain("/home/machineB/.config/backup");
			expect(expanded).toContain("no paths here");
			expect(expanded).not.toContain("/Users/machineA");
			expect(expanded).not.toContain("{{HOME}}");
		});

		it("perfect roundtrip when same homeDir is used", () => {
			const original = JSON.stringify(
				{
					hooks: {
						SessionStart: [
							{
								hooks: [
									{
										type: "command",
										command: 'node "/Users/bob/.claude/hooks/test.js"',
									},
								],
							},
						],
					},
				},
				null,
				2,
			);
			const rewritten = rewritePathsForRepo(original, "/Users/bob");
			const expanded = expandPathsForLocal(rewritten, "/Users/bob");

			// Values should match
			expect(JSON.parse(expanded)).toEqual(JSON.parse(original));
			// And the result should be valid JSON
			expect(() => JSON.parse(expanded)).not.toThrow();
		});
	});
});
