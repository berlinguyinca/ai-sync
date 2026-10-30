import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Environment } from "../environment.js";
import { parseFrontmatter } from "./frontmatter.js";
import { exists, isBrokenSymlink, listDir, rel, walk } from "./fs-utils.js";
import { IssueCollector, type Verifier, type VerifyOptions, type VerifyResult } from "./types.js";

const execFileAsync = promisify(execFile);

const AGENT_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "inherit"]);
const AGENT_MODEL_ID = /^claude-[a-z0-9.-]+$/;
const MAX_SKILL_DEPTH = 5;
const NODE_CHECK_TIMEOUT_MS = 10_000;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

async function isDir(p: string): Promise<boolean> {
	try {
		return (await fs.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function readText(p: string): Promise<string | null> {
	try {
		return await fs.readFile(p, "utf-8");
	} catch {
		return null;
	}
}

/** True if a SKILL.md exists somewhere below `dir` (following symlinks to dirs). */
async function containsSkill(dir: string, depth: number): Promise<boolean> {
	if (depth < 0) return false;
	for (const entry of await listDir(dir)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (!(await isDir(full))) continue;
		if ((await exists(path.join(full, "SKILL.md"))) || (await containsSkill(full, depth - 1))) {
			return true;
		}
	}
	return false;
}

/** Finds the absolute `node` on the given PATH, or null. */
async function findNode(pathEnv: string | undefined): Promise<string | null> {
	for (const dir of (pathEnv ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
		try {
			await fs.access(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return null;
}

function collectCommands(value: unknown, out: string[]): void {
	if (Array.isArray(value)) {
		for (const v of value) collectCommands(v, out);
	} else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			if (k === "command" && typeof v === "string") out.push(v);
			else collectCommands(v, out);
		}
	}
}

const GUARDED_SUFFIX = /\|\|\s*true\s*$/;
const GUARDED_PREFIX = /^\s*(?:\[\s+-[a-z]\s+[^\]]*\]|test\s+-[a-z]\s+\S+)\s*&&/;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ScriptRef {
	file: string;
	/** True when invoked through an interpreter such as `bash file.sh`. */
	viaShell: boolean;
}

/** Extracts script paths under the home dir or config dir from a hook command. */
function extractScripts(command: string, home: string, configDir: string): ScriptRef[] {
	const expanded = command
		.replace(/\$\{CLAUDE_CONFIG_DIR:-[^}]*\}/g, configDir)
		.replace(/\$\{HOME\}|\$HOME|\{\{HOME\}\}/g, home)
		.replace(/(^|[\s"'=:])~\//g, (_m, p: string) => `${p}${home}/`);
	const prefixes = [...new Set([home, configDir])]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp)
		.join("|");
	const re = new RegExp(`(?<![\\w/.~-])((?:${prefixes})/[^\\s"'|;&<>()\`$]+)`, "g");
	const refs: ScriptRef[] = [];
	for (const m of expanded.matchAll(re)) {
		const file = (m[1] as string).replace(/[\\,:]+$/, "");
		const before = expanded.slice(0, m.index).trim().split(/\s+/).pop() ?? "";
		refs.push({ file, viaShell: /^(?:ba|z|da)?sh$/.test(path.basename(before)) });
	}
	return refs;
}

export const claudeVerifier: Verifier = {
	id: "claude",
	async verify(env: Environment, options: VerifyOptions = {}): Promise<VerifyResult> {
		const configDir = env.getConfigDir();
		const home = options.homeDir ?? os.homedir();
		const pathEnv = options.pathEnv ?? process.env.PATH;
		const issues = new IssueCollector();
		const checked = { skills: 0, agents: 0, commands: 0, hooks: 0, settings: false };
		const r = (p: string) => rel(configDir, p);

		// --- broken symlinks ---
		for (const sub of ["skills", "agents", "commands", "hooks"]) {
			for await (const p of walk(path.join(configDir, sub))) {
				if (await isBrokenSymlink(p)) issues.error(r(p), "broken symlink");
			}
		}

		// --- skills ---
		const checkSkill = async (dir: string) => {
			const file = path.join(dir, "SKILL.md");
			checked.skills++;
			const text = await readText(file);
			if (text === null) return issues.error(r(file), "cannot read SKILL.md");
			const fm = parseFrontmatter(text);
			if (fm.kind === "none") return issues.error(r(file), "missing frontmatter");
			if (fm.kind === "invalid") return issues.error(r(file), fm.problem);
			if (!isNonEmptyString(fm.data.name)) issues.error(r(file), "missing name");
			else if (fm.data.name !== path.basename(dir)) {
				issues.error(r(file), "name does not match directory name");
			}
			if (!isNonEmptyString(fm.data.description)) {
				issues.error(r(file), "missing or empty description");
			}
		};
		const walkSkills = async (dir: string, depth: number) => {
			for (const entry of await listDir(dir)) {
				if (entry.name.startsWith(".")) continue;
				const full = path.join(dir, entry.name);
				if (!(await isDir(full))) continue;
				if (await exists(path.join(full, "SKILL.md"))) await checkSkill(full);
				else if (depth < MAX_SKILL_DEPTH && (await containsSkill(full, MAX_SKILL_DEPTH - depth))) {
					await walkSkills(full, depth + 1);
				} else if (!(await isBrokenSymlink(full))) {
					issues.error(r(path.join(full, "SKILL.md")), "missing SKILL.md");
				}
			}
		};
		await walkSkills(path.join(configDir, "skills"), 0);

		// --- agents ---
		const agentsDir = path.join(configDir, "agents");
		for (const entry of await listDir(agentsDir)) {
			if (!entry.name.endsWith(".md")) continue;
			const file = path.join(agentsDir, entry.name);
			const text = await readText(file);
			if (text === null) continue; // unreadable or broken symlink (already reported)
			checked.agents++;
			const fm = parseFrontmatter(text);
			if (fm.kind === "none") {
				issues.error(r(file), "missing frontmatter");
				continue;
			}
			if (fm.kind === "invalid") {
				issues.error(r(file), fm.problem);
				continue;
			}
			if (!isNonEmptyString(fm.data.name)) issues.error(r(file), "missing name");
			if (!isNonEmptyString(fm.data.description)) {
				issues.error(r(file), "missing or empty description");
			}
			const model = fm.data.model;
			if (
				model !== undefined &&
				!(
					typeof model === "string" &&
					(AGENT_MODEL_ALIASES.has(model) || AGENT_MODEL_ID.test(model))
				)
			) {
				issues.error(r(file), "invalid model");
			}
		}

		// --- commands ---
		for await (const file of walk(path.join(configDir, "commands"))) {
			if (!file.endsWith(".md")) continue;
			const text = await readText(file);
			if (text === null) continue;
			checked.commands++;
			const fm = parseFrontmatter(text);
			if (fm.kind === "invalid") issues.error(r(file), fm.problem);
		}

		// --- settings.json hooks / statusLine ---
		const settingsFile = path.join(configDir, "settings.json");
		const settingsText = await readText(settingsFile);
		if (settingsText !== null) {
			checked.settings = true;
			let settings: unknown;
			try {
				settings = JSON.parse(settingsText);
			} catch {
				issues.error("settings.json", "invalid JSON");
			}
			if (settings && typeof settings === "object") {
				const s = settings as Record<string, unknown>;
				const commands: string[] = [];
				collectCommands(s.hooks, commands);
				collectCommands(s.statusLine, commands);
				checked.hooks = commands.length;
				let nodePath: string | null | undefined;
				const seen = new Set<string>();
				const display = (p: string) => {
					if (p.startsWith(configDir + path.sep)) return r(p);
					if (p.startsWith(home + path.sep))
						return `~/${path.relative(home, p).split(path.sep).join("/")}`;
					return p;
				};
				for (const command of commands) {
					const guarded = GUARDED_SUFFIX.test(command) || GUARDED_PREFIX.test(command);
					const report = (file: string, problem: string) =>
						guarded ? issues.warn(display(file), problem) : issues.error(display(file), problem);
					for (const ref of extractScripts(command, home, configDir)) {
						const key = `${guarded}:${ref.file}`;
						if (seen.has(key)) continue;
						seen.add(key);
						let st: Awaited<ReturnType<typeof fs.stat>>;
						try {
							st = await fs.stat(ref.file);
						} catch {
							report(ref.file, "referenced script does not exist");
							continue;
						}
						if (!st.isFile()) continue;
						if (ref.file.endsWith(".sh") && !ref.viaShell && (st.mode & 0o111) === 0) {
							report(ref.file, "script is not executable");
						} else if (/\.(?:js|mjs|cjs)$/.test(ref.file)) {
							if (nodePath === undefined) {
								nodePath = await findNode(pathEnv);
								if (nodePath === null) {
									issues.warn("settings.json", "node not found on PATH; JS syntax checks skipped");
								}
							}
							if (nodePath === null) continue;
							try {
								await execFileAsync(nodePath, ["--check", ref.file], {
									timeout: NODE_CHECK_TIMEOUT_MS,
									env: { ...process.env, PATH: pathEnv },
								});
							} catch (err) {
								const killed = (err as { killed?: boolean }).killed;
								report(ref.file, killed ? "syntax check timed out" : "JS syntax error");
							}
						}
					}
				}
			}
		}

		// --- CLAUDE.md ---
		const claudeMd = await readText(path.join(configDir, "CLAUDE.md"));
		if (claudeMd === null) issues.error("CLAUDE.md", "missing");
		else if (claudeMd.trim().length === 0) issues.error("CLAUDE.md", "empty");

		return issues.result(env, checked);
	},
};
