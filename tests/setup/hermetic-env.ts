import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

/**
 * Hermetic test environment. Runs before every test file.
 *
 * Points HOME and every config-dir env var the code reads at a throwaway temp
 * dir, and neutralises the machine's git config, so tests can never read or
 * delete the developer's real ~/.claude, ~/.pi, ~/.codex, ~/.config, ~/.ai-sync.
 */

// os.userInfo() reads the passwd database, independent of $HOME.
const realHome = (() => {
	try {
		return fs.realpathSync(os.userInfo().homedir);
	} catch {
		return undefined;
	}
})();

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ai-sync-test-")));
const home = path.join(tempRoot, "home");
fs.mkdirSync(home, { recursive: true });

const gitConfig = path.join(tempRoot, "gitconfig");
fs.writeFileSync(
	gitConfig,
	"[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n",
);

Object.assign(process.env, {
	HOME: home,
	USERPROFILE: home,
	XDG_CONFIG_HOME: path.join(home, ".config"),
	CODEX_HOME: path.join(home, ".codex"),
	PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
	GIT_CONFIG_GLOBAL: gitConfig,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Test User",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test User",
	GIT_COMMITTER_EMAIL: "test@example.com",
});
for (const key of [
	"AI_SYNC_INSTALL_DIR",
	"CLAUDE_SYNC_INSTALL_DIR",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
]) {
	delete process.env[key];
}

// Hard safety checks: abort the run before any test can touch a real home.
const resolved = fs.realpathSync(os.homedir());
if (realHome && resolved === realHome) {
	throw new Error(`Refusing to run tests: os.homedir() is the real home (${realHome})`);
}
if (!resolved.startsWith(tempRoot + path.sep)) {
	throw new Error(`Refusing to run tests: os.homedir() (${resolved}) is outside ${tempRoot}`);
}
if (fs.existsSync(path.join(resolved, ".claude", "CLAUDE.md"))) {
	throw new Error(`Refusing to run tests: ${resolved} contains .claude/CLAUDE.md`);
}
try {
	const hooks = execFileSync("git", ["config", "--global", "--get", "core.hooksPath"], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	if (hooks) throw new Error(`core.hooksPath leaked into tests: ${hooks}`);
} catch (err) {
	if ((err as { status?: number }).status !== 1) throw err; // status 1 = key unset (good)
}

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});
