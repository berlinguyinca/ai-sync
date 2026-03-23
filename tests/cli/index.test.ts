import { describe, expect, it } from "vitest";
import { program } from "../../src/cli/index.js";

describe("cli/index", () => {
	it("exports a Commander program", () => {
		expect(program).toBeDefined();
		expect(program.name()).toBe("ai-sync");
	});

	it("has a version set", () => {
		const version = program.version();
		expect(version).toBeDefined();
		expect(version).not.toBe("0.0.0");
	});

	it("has all expected commands registered", () => {
		const commandNames = program.commands.map((c) => c.name());
		expect(commandNames).toContain("init");
		expect(commandNames).toContain("push");
		expect(commandNames).toContain("pull");
		expect(commandNames).toContain("status");
		expect(commandNames).toContain("bootstrap");
		expect(commandNames).toContain("update");
		expect(commandNames).toContain("install-skills");
		expect(commandNames).toContain("env");
		expect(commandNames).toContain("link");
		expect(commandNames).toContain("unlink");
		expect(commandNames).toContain("migrate");
	});

	it("has the --no-update-check option", () => {
		const opts = program.options.map((o) => o.long);
		expect(opts).toContain("--no-update-check");
	});
});
