import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process module before importing updater
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

// Mock getInstallDir before importing updater
vi.mock("../../src/platform/paths.js", () => ({
	getInstallDir: vi.fn(),
}));

import { execSync } from "node:child_process";
import { getInstallDir } from "../../src/platform/paths.js";
import { performUpdate, startupUpdateCheck } from "../../src/core/updater.js";

const mockedGetInstallDir = vi.mocked(getInstallDir);
const mockedExecSync = vi.mocked(execSync);

describe("core/updater", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
		mockedGetInstallDir.mockReturnValue(tmpDir);
		mockedExecSync.mockReset();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe("performUpdate", () => {
		it("skips when checked recently and force is false", async () => {
			// Write a recent check timestamp
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now()));

			const result = await performUpdate(false);

			expect(result.updated).toBe(false);
			expect(result.message).toContain("Skipped");
			expect(result.message).toContain("checked recently");
			// execSync should NOT have been called
			expect(mockedExecSync).not.toHaveBeenCalled();
		});

		it("proceeds when checked recently but force is true", async () => {
			// Write a recent check timestamp
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now()));

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD (local)
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");
			// Mock git rev-parse origin/main (remote) — same as local
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");

			const result = await performUpdate(true);

			expect(result.updated).toBe(false);
			expect(result.message).toBe("Already up to date");
		});

		it("returns updated=false when already up to date", async () => {
			// Write a stale check timestamp (>24h ago)
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD (local)
			mockedExecSync.mockImplementationOnce(() => "abc1234567890abcdef\n");
			// Mock git rev-parse origin/main (remote) — same hash
			mockedExecSync.mockImplementationOnce(() => "abc1234567890abcdef\n");

			const result = await performUpdate();

			expect(result.updated).toBe(false);
			expect(result.message).toBe("Already up to date");
		});

		it("performs update when remote is different from local", async () => {
			// Write a stale check timestamp
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD (local)
			mockedExecSync.mockImplementationOnce(() => "aaaaaaa1234567890ab\n");
			// Mock git rev-parse origin/main (remote) — different
			mockedExecSync.mockImplementationOnce(() => "bbbbbbb9876543210cd\n");
			// Mock git reset --hard
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock npm install
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock npm run build
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse --short HEAD
			mockedExecSync.mockImplementationOnce(() => "bbbbbbb\n");

			const result = await performUpdate();

			expect(result.updated).toBe(true);
			expect(result.message).toContain("Updated");
			expect(result.fromRef).toBe("aaaaaaa");
			expect(result.toRef).toBe("bbbbbbb");

			// Verify the expected commands were called
			expect(mockedExecSync).toHaveBeenCalledTimes(7);
			// First call should be git fetch
			expect(mockedExecSync.mock.calls[0][0]).toContain("git fetch");
			// Fourth call should be git reset --hard
			expect(mockedExecSync.mock.calls[3][0]).toContain("git reset --hard");
			// Fifth call should be npm install
			expect(mockedExecSync.mock.calls[4][0]).toContain("npm install");
			// Sixth call should be npm run build
			expect(mockedExecSync.mock.calls[5][0]).toContain("npm run build");
		});

		it("checks when no check file exists", async () => {
			// No check file exists — should proceed with check (shouldCheck returns true)
			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD (local)
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");
			// Mock git rev-parse origin/main (remote) — same
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");

			const result = await performUpdate();

			expect(result.updated).toBe(false);
			expect(result.message).toBe("Already up to date");

			// Should have created the check file
			const checkFile = path.join(tmpDir, ".last-update-check");
			expect(fs.existsSync(checkFile)).toBe(true);
		});

		it("propagates errors from execSync", async () => {
			// Stale check time so it proceeds
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch to throw
			mockedExecSync.mockImplementationOnce(() => {
				throw new Error("fatal: Could not read from remote repository.");
			});

			await expect(performUpdate()).rejects.toThrow("Could not read from remote repository");
		});

		it("records check timestamp before fetching", async () => {
			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD
			mockedExecSync.mockImplementationOnce(() => "abc123\n");
			// Mock git rev-parse origin/main
			mockedExecSync.mockImplementationOnce(() => "abc123\n");

			await performUpdate();

			const checkFile = path.join(tmpDir, ".last-update-check");
			const content = fs.readFileSync(checkFile, "utf-8").trim();
			const timestamp = Number.parseInt(content, 10);

			// Should be a recent timestamp (within 10s)
			expect(Date.now() - timestamp).toBeLessThan(10_000);
		});
	});

	describe("startupUpdateCheck", () => {
		it("returns null when checked recently", async () => {
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now()));

			const result = await startupUpdateCheck();

			expect(result).toBeNull();
			// Should not have called execSync
			expect(mockedExecSync).not.toHaveBeenCalled();
		});

		it("returns null when already up to date", async () => {
			// Stale check timestamp
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");
			// Mock git rev-parse origin/main — same
			mockedExecSync.mockImplementationOnce(() => "abc1234567890\n");

			const result = await startupUpdateCheck();

			expect(result).toBeNull();
		});

		it("returns update message when remote is ahead", async () => {
			// Stale check timestamp
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD (local)
			mockedExecSync.mockImplementationOnce(() => "aaaaaaa1234567890ab\n");
			// Mock git rev-parse origin/main (remote) — different
			mockedExecSync.mockImplementationOnce(() => "bbbbbbb9876543210cd\n");
			// Mock git reset --hard
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock npm install
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock npm run build
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse --short HEAD
			mockedExecSync.mockImplementationOnce(() => "bbbbbbb\n");

			const result = await startupUpdateCheck();

			expect(result).not.toBeNull();
			expect(result).toContain("ai-sync updated");
			expect(result).toContain("aaaaaaa");
			expect(result).toContain("bbbbbbb");
		});

		it("returns null on error (silent failure)", async () => {
			// Stale check timestamp so it proceeds
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, String(Date.now() - 25 * 60 * 60 * 1000));

			// Mock git fetch to throw
			mockedExecSync.mockImplementationOnce(() => {
				throw new Error("Network error");
			});

			const result = await startupUpdateCheck();

			// Should silently swallow errors and return null
			expect(result).toBeNull();
		});

		it("checks when no check file exists", async () => {
			// No check file — should proceed
			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD
			mockedExecSync.mockImplementationOnce(() => "abc123\n");
			// Mock git rev-parse origin/main
			mockedExecSync.mockImplementationOnce(() => "abc123\n");

			const result = await startupUpdateCheck();

			expect(result).toBeNull();

			// Check file should now exist
			const checkFile = path.join(tmpDir, ".last-update-check");
			expect(fs.existsSync(checkFile)).toBe(true);
		});

		it("returns null when check file has invalid content", async () => {
			// Write garbage to check file — shouldCheck returns true, then proceeds
			const checkFile = path.join(tmpDir, ".last-update-check");
			fs.writeFileSync(checkFile, "not-a-number");

			// Mock git fetch
			mockedExecSync.mockImplementationOnce(() => Buffer.from(""));
			// Mock git rev-parse HEAD
			mockedExecSync.mockImplementationOnce(() => "abc123\n");
			// Mock git rev-parse origin/main
			mockedExecSync.mockImplementationOnce(() => "abc123\n");

			const result = await startupUpdateCheck();

			// NaN comparison always triggers a check, should go through and return null (up to date)
			expect(result).toBeNull();
		});
	});
});
