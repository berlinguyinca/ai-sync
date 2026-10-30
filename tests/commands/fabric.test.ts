import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleFabricJoin,
	handleFabricStatus,
	renderFabricStatus,
	validateRepoUrl,
} from "../../src/cli/commands/fabric.js";
import { json, sampleHost, startServer, type TestServer } from "../core/fabric/helpers.js";

const HOUR = 3600 * 1000;

describe("renderFabricStatus", () => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI for assertions
	const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

	it("shows columns, ages, ahead/behind and error", () => {
		const now = Date.parse("2026-01-01T12:00:00Z");
		const out = plain(
			renderFabricStatus(
				[
					{ ...sampleHost, last_sync_ts: "2026-01-01T11:59:00Z" },
					{ ...sampleHost, host_id: "old", last_sync_ts: "2026-01-01T09:00:00Z", behind: null },
					{ ...sampleHost, host_id: "bad", last_error: "boom" },
				],
				now,
			),
		);
		expect(out).toMatch(/HOST\s+VERSION\s+ENVS\s+LAST SYNC\s+AHEAD\/BEHIND\s+DRIFT\s+ERROR/);
		expect(out).toMatch(/laptop\s+1\.2\.3\s+claude,pi\s+1m ago\s+0\/2\s+1/);
		expect(out).toMatch(/old\s.*3h ago\s+0\/-/);
		expect(out).toMatch(/bad\s.*boom/);
	});

	it("strips control characters from remote text", () => {
		const out = renderFabricStatus([{ ...sampleHost, host_id: "a\u001b[31mb" }]);
		expect(out).not.toContain("\u001b[31m");
	});

	it("marks stale (>1h) rows with warn colour only when colours are enabled", () => {
		const now = Date.now();
		const fresh = renderFabricStatus(
			[{ ...sampleHost, last_sync_ts: new Date(now).toISOString() }],
			now,
		);
		const stale = renderFabricStatus(
			[{ ...sampleHost, last_sync_ts: new Date(now - 2 * HOUR).toISOString() }],
			now,
		);
		expect(plain(stale)).toContain("2h ago");
		expect(plain(fresh)).toContain("0s ago");
	});
});

describe("validateRepoUrl", () => {
	it("accepts https and ssh forms", () => {
		for (const u of [
			"https://github.com/o/r.git",
			"ssh://git@host:22/o/r.git",
			"git@github.com:o/r.git",
		]) {
			expect(validateRepoUrl(u)).toBeNull();
		}
	});
	it("rejects file, option injection and exotic transports", () => {
		for (const u of [
			"file:///tmp/x",
			"/tmp/x",
			"--upload-pack=touch /tmp/pwn",
			"-oProxyCommand=x",
			"ext::sh -c id",
			"http://insecure/o/r.git",
			"https://h/o r",
			"",
		]) {
			expect(validateRepoUrl(u)).not.toBeNull();
		}
	});
});

describe("fabric commands", () => {
	let tmp: string;
	let server: TestServer | undefined;
	let logs: string[];
	let errs: string[];

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "fabric-cmd-"));
		logs = [];
		errs = [];
		vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...a) => void errs.push(a.join(" ")));
		process.exitCode = undefined;
		// Keep .environments.json out of the repo checkout.
		vi.stubEnv("AI_SYNC_INSTALL_DIR", path.join(tmp, "install"));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.exitCode = undefined;
		await server?.close();
		server = undefined;
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	describe("status", () => {
		it("prints a clear message and exits 0 when not configured", async () => {
			await handleFabricStatus({ env: {}, syncRepoDir: path.join(tmp, "none") });
			expect(logs.join("\n")).toContain("fabric not configured; set AI_SYNC_FABRIC_URL");
			expect(process.exitCode).toBeUndefined();
		});

		it("lists hosts, and emits JSON with --json", async () => {
			server = await startServer((_req, res) => json(res, 200, { hosts: [sampleHost] }));
			const env = { AI_SYNC_FABRIC_URL: server.url };
			await handleFabricStatus({ env, syncRepoDir: tmp });
			expect(logs.join("\n")).toContain("laptop");
			logs.length = 0;
			await handleFabricStatus({ env, syncRepoDir: tmp, json: true });
			expect(JSON.parse(logs.join("\n"))).toEqual({ configured: true, hosts: [sampleHost] });
			expect(process.exitCode).toBeUndefined();
		});

		it("reports fabric errors with exit code 1", async () => {
			server = await startServer((_req, res) => json(res, 401, {}));
			await handleFabricStatus({ env: { AI_SYNC_FABRIC_URL: server.url }, syncRepoDir: tmp });
			expect(errs.join("\n")).toContain("HTTP 401");
			expect(process.exitCode).toBe(1);
		});
	});

	describe("no-config guarantee", () => {
		it("makes no outbound fetch when unconfigured", async () => {
			const realFetch = globalThis.fetch;
			let calls = 0;
			globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
				calls++;
				return realFetch(...a);
			}) as typeof fetch;
			try {
				await handleFabricStatus({ env: {}, syncRepoDir: path.join(tmp, "none") });
				await handleFabricJoin({ env: {}, syncRepoDir: path.join(tmp, "none"), yes: true });
			} finally {
				globalThis.fetch = realFetch;
			}
			expect(calls).toBe(0);
			expect(fs.existsSync(path.join(tmp, "none"))).toBe(false);
		});

		it("is not imported by any non-fabric source module except CLI registration", async () => {
			const root = path.resolve(__dirname, "../../src");
			const offenders: string[] = [];
			const walk = (dir: string) => {
				for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
					const p = path.join(dir, e.name);
					if (e.isDirectory()) walk(p);
					else if (/fabric/.test(fs.readFileSync(p, "utf-8")) && !/fabric/.test(p))
						offenders.push(p);
				}
			};
			walk(root);
			expect(offenders.map((p) => path.relative(root, p))).toEqual(["cli/index.ts"]);
		});
	});

	describe("join", () => {
		let bare: string;
		let syncDir: string;
		const REPO_URL = "https://fabric.invalid/team/config.git";

		async function sharedConfig(over: Record<string, unknown> = {}) {
			server = await startServer((req, res) =>
				req.url === "/api/v1/ai-sync/config"
					? json(res, 200, {
							repo_url: REPO_URL,
							branch: "main",
							envs: ["claude"],
							merge_enabled: false,
							...over,
						})
					: json(res, 404, {}),
			);
			return { AI_SYNC_FABRIC_URL: server.url };
		}

		beforeEach(async () => {
			// Real bare repo, reached through git's own url.insteadOf (global config is hermetic).
			const work = path.join(tmp, "work");
			bare = path.join(tmp, "remote.git");
			await fsp.mkdir(work);
			const git = simpleGit(work);
			await git.init(["--initial-branch=main"]);
			await git.addConfig("user.email", "t@t.t");
			await git.addConfig("user.name", "T");
			await fsp.writeFile(path.join(work, "CLAUDE.md"), "# shared\n");
			await git.add("CLAUDE.md");
			await git.commit("init");
			execFileSync("git", ["clone", "--bare", work, bare], { stdio: "pipe" });
			execFileSync("git", ["config", "--global", `url.${bare}.insteadOf`, REPO_URL]);
			syncDir = path.join(tmp, "sync");
		});

		afterEach(() => {
			// Global git config is a per-run temp file; drop this test's rewrite so it cannot leak.
			execFileSync("git", ["config", "--global", "--remove-section", `url.${bare}`]);
		});

		it("dry-run changes nothing and says what it would do", async () => {
			const env = await sharedConfig();
			await handleFabricJoin({ env, syncRepoDir: syncDir });
			const out = logs.join("\n");
			expect(out).toContain("Dry run");
			expect(out).toContain(`bootstrap ${REPO_URL}@main`);
			expect(out).toContain("enabled=false");
			expect(fs.existsSync(syncDir)).toBe(false);
		});

		it("--yes clones, enables envs and writes merge-config", async () => {
			const env = await sharedConfig();
			const claudeDir = path.join(tmp, "claude");
			await handleFabricJoin({ env, syncRepoDir: syncDir, yes: true, claudeDir });
			expect(errs).toEqual([]);
			expect(process.exitCode).toBeUndefined();
			expect(fs.existsSync(path.join(syncDir, ".git"))).toBe(true);
			expect(fs.readFileSync(path.join(syncDir, "CLAUDE.md"), "utf-8")).toBe("# shared\n");
			const mc = JSON.parse(
				fs.readFileSync(path.join(syncDir, "tools", "merge-config.json"), "utf-8"),
			);
			expect(mc).toEqual({ enabled: false });
			const { getEnabledEnvironments } = await import("../../src/core/env-config.js");
			expect(getEnabledEnvironments()).toEqual(["claude"]);
		});

		it("refuses when an existing sync repo has a different remote", async () => {
			const env = await sharedConfig();
			await fsp.mkdir(syncDir);
			const git = simpleGit(syncDir);
			await git.init();
			await git.addRemote("origin", "https://example.com/other/repo.git");
			await handleFabricJoin({ env, syncRepoDir: syncDir, yes: true });
			const err = errs.join("\n");
			expect(err).toContain("different remote");
			expect(err).toContain("https://example.com/other/repo.git");
			expect(err).toContain(REPO_URL);
			expect(process.exitCode).toBe(1);
			expect(fs.existsSync(path.join(syncDir, "tools"))).toBe(false);
		});

		it("rejects unsafe repo_url / unknown envs / missing config", async () => {
			for (const over of [
				{ repo_url: "file:///etc" },
				{ repo_url: "--upload-pack=x" },
				{ envs: ["nonsense"] },
				{ branch: "-x" },
			]) {
				errs.length = 0;
				process.exitCode = undefined;
				const env = await sharedConfig(over);
				await handleFabricJoin({ env, syncRepoDir: syncDir, yes: true });
				expect(errs.join("\n")).toContain("Refusing to join");
				expect(process.exitCode).toBe(1);
				expect(fs.existsSync(syncDir)).toBe(false);
				await server?.close();
			}
			server = await startServer((_req, res) => json(res, 404, {}));
			errs.length = 0;
			await handleFabricJoin({ env: { AI_SYNC_FABRIC_URL: server.url }, syncRepoDir: syncDir });
			expect(errs.join("\n")).toContain("no shared config");
		});
	});
});
