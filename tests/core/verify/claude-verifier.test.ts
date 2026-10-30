import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeEnvironment, CodexEnvironment } from "../../../src/core/environment.js";
import { verifyEnvironment } from "../../../src/core/verify/index.js";
import { MAX_ISSUES } from "../../../src/core/verify/types.js";

class TestClaude extends ClaudeEnvironment {
	constructor(private readonly dir: string) {
		super();
	}
	override getConfigDir(): string {
		return this.dir;
	}
}

let base: string;
let home: string;
let cfg: string;
let env: TestClaude;

async function write(rel: string, content: string, mode?: number) {
	const full = path.join(cfg, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content);
	if (mode !== undefined) await fs.chmod(full, mode);
}

const skill = (name: string, desc = "does things") =>
	`---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`;

async function validTree() {
	await write("CLAUDE.md", "# hello\n");
	await write("skills/alpha/SKILL.md", skill("alpha"));
	await write("skills/synced/beta/SKILL.md", skill("beta"));
	await write(
		"agents/reviewer.md",
		"---\nname: reviewer\ndescription: reviews\nmodel: opus\n---\n",
	);
	await write("commands/plain.md", "no frontmatter\n");
	await write("commands/sub/fm.md", "---\ndescription: x\n---\n");
	await write("hooks/run.sh", "#!/bin/sh\nexit 0\n", 0o755);
	await write("hooks/tool.js", "console.log('ok');\n");
	await write(
		"settings.json",
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{ type: "command", command: `${cfg}/hooks/run.sh` },
							{
								type: "command",
								command: `node \${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/tool.js`,
							},
						],
					},
				],
			},
			statusLine: { type: "command", command: "bash ~/.claude/status.sh" },
		}),
	);
	// ~/.claude/status.sh lives under the fake home, config dir is elsewhere
	await fs.mkdir(path.join(home, ".claude"), { recursive: true });
	await fs.writeFile(path.join(home, ".claude", "status.sh"), "echo hi\n");
}

const verify = (pathEnv?: string) => verifyEnvironment(env, { homeDir: home, pathEnv });

beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "ai-sync-verify-"));
	home = path.join(base, "home");
	cfg = path.join(base, "cfg");
	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(cfg, { recursive: true });
	env = new TestClaude(cfg);
});

afterEach(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

describe("claude verifier", () => {
	it("passes a valid tree with the documented output shape", async () => {
		await validTree();
		const r = await verify();
		expect(r).toEqual({
			ok: true,
			env: "claude",
			configDir: cfg,
			checked: { skills: 2, agents: 1, commands: 2, hooks: 3, settings: true },
			errors: [],
			warnings: [],
		});
	});

	it("flags a skill dir without SKILL.md", async () => {
		await validTree();
		await fs.mkdir(path.join(cfg, "skills/empty"), { recursive: true });
		await write("skills/empty/notes.txt", "x");
		const r = await verify();
		expect(r.errors).toEqual([{ path: "skills/empty/SKILL.md", problem: "missing SKILL.md" }]);
		expect(r.ok).toBe(false);
	});

	it("flags name/dir mismatch", async () => {
		await validTree();
		await write("skills/alpha/SKILL.md", skill("other"));
		const r = await verify();
		expect(r.errors).toEqual([
			{ path: "skills/alpha/SKILL.md", problem: "name does not match directory name" },
		]);
	});

	it("flags bad YAML without echoing contents", async () => {
		await validTree();
		await write("skills/alpha/SKILL.md", "---\nname: [unclosed\nSECRET-TOKEN: x\n---\n");
		const r = await verify();
		expect(r.errors).toEqual([
			{ path: "skills/alpha/SKILL.md", problem: "frontmatter is not valid YAML" },
		]);
		expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
	});

	it("flags missing description", async () => {
		await validTree();
		await write("skills/alpha/SKILL.md", "---\nname: alpha\n---\n");
		const r = await verify();
		expect(r.errors).toEqual([
			{ path: "skills/alpha/SKILL.md", problem: "missing or empty description" },
		]);
	});

	it("flags a bad agent model", async () => {
		await validTree();
		await write("agents/reviewer.md", "---\nname: reviewer\ndescription: d\nmodel: gpt-4\n---\n");
		const r = await verify();
		expect(r.errors).toEqual([{ path: "agents/reviewer.md", problem: "invalid model" }]);
		await write(
			"agents/reviewer.md",
			"---\nname: reviewer\ndescription: d\nmodel: claude-opus-4.1\n---\n",
		);
		expect((await verify()).ok).toBe(true);
	});

	it("flags invalid command frontmatter", async () => {
		await validTree();
		await write("commands/bad.md", "---\na: [\n---\n");
		const r = await verify();
		expect(r.errors).toEqual([
			{ path: "commands/bad.md", problem: "frontmatter is not valid YAML" },
		]);
	});

	it("flags bad settings.json", async () => {
		await validTree();
		await write("settings.json", "{ nope");
		const r = await verify();
		expect(r.errors).toEqual([{ path: "settings.json", problem: "invalid JSON" }]);
	});

	it("flags a missing hook script", async () => {
		await validTree();
		await fs.rm(path.join(cfg, "hooks/run.sh"));
		const r = await verify();
		expect(r.errors).toEqual([
			{ path: "hooks/run.sh", problem: "referenced script does not exist" },
		]);
	});

	it("flags a non-executable .sh hook", async () => {
		await validTree();
		await fs.chmod(path.join(cfg, "hooks/run.sh"), 0o644);
		const r = await verify();
		expect(r.errors).toEqual([{ path: "hooks/run.sh", problem: "script is not executable" }]);
	});

	it("flags a JS syntax error", async () => {
		await validTree();
		await write("hooks/tool.js", "const = ;\n");
		const r = await verify();
		expect(r.errors).toEqual([{ path: "hooks/tool.js", problem: "JS syntax error" }]);
	});

	it("flags a broken symlink", async () => {
		await validTree();
		await fs.symlink(path.join(base, "nowhere"), path.join(cfg, "hooks/dangling"));
		const r = await verify();
		expect(r.errors).toEqual([{ path: "hooks/dangling", problem: "broken symlink" }]);
	});

	it("flags an empty CLAUDE.md", async () => {
		await validTree();
		await write("CLAUDE.md", "  \n");
		const r = await verify();
		expect(r.errors).toEqual([{ path: "CLAUDE.md", problem: "empty" }]);
	});

	it("flags a missing CLAUDE.md", async () => {
		await validTree();
		await fs.rm(path.join(cfg, "CLAUDE.md"));
		expect((await verify()).errors).toEqual([{ path: "CLAUDE.md", problem: "missing" }]);
	});

	it("downgrades guarded missing hook scripts to warnings", async () => {
		await validTree();
		await write(
			"settings.json",
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{ type: "command", command: `${cfg}/hooks/gone.sh || true` },
								{
									type: "command",
									command: `[ -f ${cfg}/hooks/gone2.sh ] && ${cfg}/hooks/gone2.sh`,
								},
							],
						},
					],
				},
			}),
		);
		const r = await verify();
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.warnings.map((w) => w.path).sort()).toEqual(["hooks/gone.sh", "hooks/gone2.sh"]);
	});

	it("warns (does not crash) when node is not on PATH", async () => {
		await validTree();
		const emptyBin = path.join(base, "emptybin");
		await fs.mkdir(emptyBin);
		const r = await verify(emptyBin);
		expect(r.ok).toBe(true);
		expect(r.warnings).toEqual([
			{ path: "settings.json", problem: "node not found on PATH; JS syntax checks skipped" },
		]);
	});

	it("caps errors at 200 and sets truncated", async () => {
		await validTree();
		for (let i = 0; i < MAX_ISSUES + 5; i++) {
			await fs.mkdir(path.join(cfg, `skills/s${i}`), { recursive: true });
		}
		const r = await verify();
		expect(r.errors).toHaveLength(MAX_ISSUES);
		expect(r.truncated).toBe(true);
	});

	it("does not set truncated when under the cap", async () => {
		await validTree();
		expect((await verify()).truncated).toBeUndefined();
	});
});

describe("generic verifier", () => {
	it("is used for environments without a verifier and checks JSON files", async () => {
		const codex = new (class extends CodexEnvironment {
			override getConfigDir() {
				return cfg;
			}
			override getSyncTargets() {
				return ["good.json", "automations/", "missing.json"];
			}
		})();
		await write("good.json", '{"a":1}');
		await write("automations/bad.json", "{oops");
		await write("automations/commented.json", '{\n // c\n "a": 1,\n}');
		await write("automations/note.toml", "not = [valid");
		const r = await verifyEnvironment(codex, { homeDir: home });
		expect(r.env).toBe("codex");
		expect(r.errors).toEqual([{ path: "automations/bad.json", problem: "invalid JSON" }]);
		expect(r.checked).toEqual({ files: 3 });
	});
});
