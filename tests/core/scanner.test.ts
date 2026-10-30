import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAllowlistFn } from "../../src/core/env-helpers.js";
import type { Environment } from "../../src/core/environment.js";
import { scanDirectory } from "../../src/core/scanner.js";

class TestEnv implements Environment {
	readonly id = "test";
	readonly displayName = "Test";
	constructor(
		private readonly targets: readonly string[],
		private readonly ignores: readonly string[],
	) {}
	getConfigDir(): string {
		return "/unused";
	}
	getSyncTargets(): readonly string[] {
		return this.targets;
	}
	getPluginSyncPatterns(): readonly string[] {
		return [];
	}
	getIgnorePatterns(): readonly string[] {
		return this.ignores;
	}
	getPathRewriteTargets(): string[] {
		return [];
	}
	getSkillsSubdir(): string | null {
		return null;
	}
}

describe("scanner", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-test-"));
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

	it("includes files under rules/ directory", async () => {
		await createFile("rules/context7.md", "# Context7 rules");
		await createFile("rules/team/coding-standards.md", "# Team standards");

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("rules/context7.md");
		expect(result).toContain("rules/team/coding-standards.md");
	});

	it("includes keybindings.json when present", async () => {
		await createFile("keybindings.json", '{"bindings": []}');

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("keybindings.json");
	});

	it("follows symlinked files", async () => {
		await createFile("CLAUDE.md", "# Real file");
		// Create a symlink to an allowed file
		await fs.symlink(path.join(tmpDir, "CLAUDE.md"), path.join(tmpDir, "settings.json"));

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("CLAUDE.md");
		// settings.json is a symlink to a file, should be included
		expect(result).toContain("settings.json");
	});

	it("follows symlinked directories", async () => {
		// Create an external directory with files
		const externalDir = path.join(tmpDir, "_external");
		await fs.mkdir(externalDir, { recursive: true });
		await fs.writeFile(path.join(externalDir, "skill.md"), "# Skill");

		// Create commands/gw as a symlink to the external directory
		await fs.mkdir(path.join(tmpDir, "commands"), { recursive: true });
		await fs.symlink(externalDir, path.join(tmpDir, "commands", "gw"));

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("commands/gw/skill.md");
	});

	it("prevents cycles from circular symlinks", async () => {
		// Create a directory with a symlink back to parent
		await createFile("commands/real.md", "# Real");
		await fs.symlink(tmpDir, path.join(tmpDir, "commands", "loop"));

		const result = await scanDirectory(tmpDir);
		expect(result).toContain("commands/real.md");
		// Should not loop infinitely
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

describe("scanner symlinks to ignored files", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-symlink-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	const targets = ["extensions/"];
	const ignores = ["auth.json", "models.json", "logs/"];
	const allow = () => makeAllowlistFn(new TestEnv(targets, ignores));

	it("skips a symlink pointing at an ignored file inside the config dir", async () => {
		await fs.mkdir(path.join(tmpDir, "extensions"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "auth.json"), '{"k":"secret"}');
		await fs.writeFile(path.join(tmpDir, "extensions", "ok.ts"), "export {}");
		await fs.symlink("../auth.json", path.join(tmpDir, "extensions", "creds"));

		const result = await scanDirectory(tmpDir, allow());
		expect(result).toEqual(["extensions/ok.ts"]);
	});

	it("skips a symlink pointing at an ignored file outside the config dir", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-outside-"));
		try {
			await fs.writeFile(path.join(outside, "models.json"), "secret");
			await fs.mkdir(path.join(tmpDir, "extensions"), { recursive: true });
			await fs.symlink(path.join(outside, "models.json"), path.join(tmpDir, "extensions", "m"));

			expect(await scanDirectory(tmpDir, allow())).toEqual([]);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it("skips a symlink to a file inside an ignored directory of the config dir", async () => {
		await fs.mkdir(path.join(tmpDir, "logs"), { recursive: true });
		await fs.mkdir(path.join(tmpDir, "extensions"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "logs", "a.log"), "log");
		await fs.symlink("../logs/a.log", path.join(tmpDir, "extensions", "l"));

		expect(await scanDirectory(tmpDir, allow())).toEqual([]);
	});

	it("still syncs a symlink to a non-ignored external file", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-outside-"));
		try {
			await fs.writeFile(path.join(outside, "helper.ts"), "export {}");
			await fs.mkdir(path.join(tmpDir, "extensions"), { recursive: true });
			await fs.symlink(path.join(outside, "helper.ts"), path.join(tmpDir, "extensions", "h.ts"));

			expect(await scanDirectory(tmpDir, allow())).toEqual(["extensions/h.ts"]);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});
