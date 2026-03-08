import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDirectory } from "../../src/core/scanner.js";

describe("scanner", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-sync-test-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function createFile(relativePath: string, content = ""): Promise<void> {
		const fullPath = path.join(tmpDir, relativePath);
		await fs.mkdir(path.dirname(fullPath), { recursive: true });
		await fs.writeFile(fullPath, content);
	}

	it("returns only files matching the allowlist from a directory tree", async () => {
		await createFile("settings.json", "{}");
		await createFile("CLAUDE.md", "# Config");
		await createFile("random-file.txt", "nope");
		await createFile("some-dir/file.ts", "nope");

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("settings.json");
		expect(result).toContain("CLAUDE.md");
		expect(result).not.toContain("random-file.txt");
		expect(result).not.toContain("some-dir/file.ts");
	});

	it("excludes files in ephemeral directories", async () => {
		await createFile("settings.json", "{}");
		await createFile("projects/foo.md", "project");
		await createFile("debug/logs.txt", "debug");
		await createFile("telemetry/data.json", "telemetry");

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("settings.json");
		expect(result).not.toContain("projects/foo.md");
		expect(result).not.toContain("debug/logs.txt");
		expect(result).not.toContain("telemetry/data.json");
	});

	it("returns relative paths", async () => {
		await createFile("settings.json", "{}");
		await createFile("agents/my-skill/SKILL.md", "skill");

		const result = await scanDirectory(tmpDir);
		for (const p of result) {
			expect(path.isAbsolute(p)).toBe(false);
		}
	});

	it("returns empty array for empty source directory", async () => {
		const result = await scanDirectory(tmpDir);
		expect(result).toEqual([]);
	});

	it("throws descriptive error for missing source directory", async () => {
		const missing = path.join(tmpDir, "nonexistent");
		await expect(scanDirectory(missing)).rejects.toThrow(
			`Source directory does not exist: ${missing}`,
		);
	});

	it("includes nested files under allowed directories", async () => {
		await createFile("agents/foo/bar.ts", "code");
		await createFile("agents/baz/deep/nested.md", "content");
		await createFile("hooks/pre-commit.sh", "#!/bin/bash");

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("agents/foo/bar.ts");
		expect(result).toContain("agents/baz/deep/nested.md");
		expect(result).toContain("hooks/pre-commit.sh");
	});

	it("returns forward-slash relative paths (cross-platform contract)", async () => {
		await createFile("agents/skill/SKILL.md", "skill");
		await createFile("hooks/pre-push.sh", "#!/bin/bash");

		const result = await scanDirectory(tmpDir);
		for (const p of result) {
			expect(p).not.toContain("\\");
			expect(path.isAbsolute(p)).toBe(false);
		}
		expect(result).toContain("agents/skill/SKILL.md");
		expect(result).toContain("hooks/pre-push.sh");
	});
});
