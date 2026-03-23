import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/paths.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getInstallDir: () => testInstallDir,
	};
});

let testInstallDir: string;

// Import after mock setup
import { startupUpdateCheck, performUpdate } from "../../src/core/updater.js";
import { registerUpdateCommand } from "../../src/cli/commands/update.js";

describe("updater", () => {
	beforeEach(() => {
		testInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
	});

	afterEach(() => {
		fs.rmSync(testInstallDir, { recursive: true, force: true });
	});

	describe("startupUpdateCheck", () => {
		it("returns null when checked recently", async () => {
			// Write a recent check timestamp
			const checkFile = path.join(testInstallDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now()));

			const result = await startupUpdateCheck();
			expect(result).toBeNull();
		});

		it("returns null on any error (never throws)", async () => {
			// testInstallDir has no git repo, so git commands will fail
			// startupUpdateCheck should swallow the error
			const result = await startupUpdateCheck();
			expect(result).toBeNull();
		});
	});

	describe("performUpdate", () => {
		it("skips when checked recently and not forced", async () => {
			// Write a recent check timestamp
			const checkFile = path.join(testInstallDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now()));

			const result = await performUpdate(false);
			expect(result.updated).toBe(false);
			expect(result.message).toContain("Skipped");
		});

		it("throws when git commands fail (no git repo)", async () => {
			// testInstallDir has no git repo, so git fetch will fail
			await expect(performUpdate(true)).rejects.toThrow();
		});
	});
});

describe("update CLI wrapper (registerUpdateCommand)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		testInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-cli-test-"));
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		fs.rmSync(testInstallDir, { recursive: true, force: true });
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = undefined;
	});

	it("prints 'Checking for updates...' and handles skipped result", async () => {
		// Write a recent check timestamp so performUpdate returns "skipped"
		const checkFile = path.join(testInstallDir, ".last-update-check");
		fs.writeFileSync(checkFile, String(Date.now()));

		const program = new Command();
		program.exitOverride();
		registerUpdateCommand(program);

		await program.parseAsync(["node", "test", "update"]);

		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("Checking for updates");
		expect(output).toContain("Skipped");
	});

	it("catches errors and sets process.exitCode = 1", async () => {
		// No .last-update-check file and no git repo = git fetch will fail
		const program = new Command();
		program.exitOverride();
		registerUpdateCommand(program);

		await program.parseAsync(["node", "test", "update", "--force"]);

		const errOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(errOutput).toContain("Update failed");
		expect(process.exitCode).toBe(1);
	});

	it("prints 'Checking for updates...' before the update attempt", async () => {
		const program = new Command();
		program.exitOverride();
		registerUpdateCommand(program);

		// Even if the update fails, the initial message should be printed
		await program.parseAsync(["node", "test", "update", "--force"]);

		const firstLogCall = logSpy.mock.calls[0]?.[0];
		expect(String(firstLogCall)).toContain("Checking for updates");
	});
});
