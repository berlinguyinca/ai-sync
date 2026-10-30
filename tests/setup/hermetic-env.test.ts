import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeEnvironment } from "../../src/core/environment.js";
import { getClaudeDir, getCodexConfigDir, getPiConfigDir } from "../../src/platform/paths.js";

describe("hermetic test environment", () => {
	const tmp = path.join(os.tmpdir(), "ai-sync-test-");

	it("keeps ClaudeEnvironment config dir inside the temp home", () => {
		const dir = new ClaudeEnvironment().getConfigDir();
		expect(dir.startsWith(tmp)).toBe(true);
		expect(dir).toBe(path.join(os.homedir(), ".claude"));
	});

	it("keeps other config dirs inside the temp home", () => {
		for (const dir of [getClaudeDir(), getCodexConfigDir(), getPiConfigDir()]) {
			expect(dir.startsWith(tmp)).toBe(true);
		}
	});
});
