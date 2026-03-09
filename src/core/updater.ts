import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 30_000;

/**
 * Resolves the claude-sync install directory by walking up from the
 * currently running script until we find a directory that is both
 * a git repo and contains a package.json with name "claude-sync".
 */
export function getInstallDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	let dir = path.dirname(thisFile);

	for (let i = 0; i < 5; i++) {
		const pkgPath = path.join(dir, "package.json");
		const gitDir = path.join(dir, ".git");
		if (fs.existsSync(pkgPath) && fs.existsSync(gitDir)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.name === "claude-sync") return dir;
			} catch {
				// malformed package.json, keep searching
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	throw new Error("Could not find claude-sync install directory");
}

function getCheckFile(installDir: string): string {
	return path.join(installDir, ".last-update-check");
}

function shouldCheck(installDir: string): boolean {
	const checkFile = getCheckFile(installDir);
	try {
		const content = fs.readFileSync(checkFile, "utf-8").trim();
		const lastCheck = Number.parseInt(content, 10);
		return Date.now() - lastCheck > CHECK_INTERVAL_MS;
	} catch {
		return true; // no file or parse error → check now
	}
}

function recordCheck(installDir: string): void {
	fs.writeFileSync(getCheckFile(installDir), String(Date.now()));
}

export interface UpdateResult {
	updated: boolean;
	message: string;
	fromRef?: string;
	toRef?: string;
}

/**
 * Checks for updates and applies them if available.
 * Used by the explicit `claude-sync update` command.
 */
export async function performUpdate(force = false): Promise<UpdateResult> {
	const installDir = getInstallDir();

	if (!force && !shouldCheck(installDir)) {
		return { updated: false, message: "Skipped — checked recently (use --force to override)" };
	}

	recordCheck(installDir);

	// Fetch latest from remote
	execSync("git fetch --depth 1 origin main", {
		cwd: installDir,
		stdio: "pipe",
		timeout: FETCH_TIMEOUT_MS,
	});

	const localHead = execSync("git rev-parse HEAD", {
		cwd: installDir,
		encoding: "utf-8",
	}).trim();

	const remoteHead = execSync("git rev-parse origin/main", {
		cwd: installDir,
		encoding: "utf-8",
	}).trim();

	if (localHead === remoteHead) {
		return { updated: false, message: "Already up to date" };
	}

	const fromRef = localHead.slice(0, 7);

	// Apply update
	execSync("git reset --hard origin/main", {
		cwd: installDir,
		stdio: "pipe",
	});

	execSync("npm install --no-fund --no-audit --loglevel=error", {
		cwd: installDir,
		stdio: "pipe",
		timeout: INSTALL_TIMEOUT_MS,
	});

	execSync("npm run build --silent", {
		cwd: installDir,
		stdio: "pipe",
		timeout: BUILD_TIMEOUT_MS,
	});

	const toRef = execSync("git rev-parse --short HEAD", {
		cwd: installDir,
		encoding: "utf-8",
	}).trim();

	return {
		updated: true,
		message: `Updated ${fromRef} → ${toRef}`,
		fromRef,
		toRef,
	};
}

/**
 * Silent startup check — runs on every CLI invocation but only
 * actually checks the remote once per CHECK_INTERVAL_MS.
 * Auto-updates if a new version is found.
 * Never throws — any error is silently swallowed.
 */
export async function startupUpdateCheck(): Promise<string | null> {
	try {
		const installDir = getInstallDir();
		if (!shouldCheck(installDir)) return null;

		recordCheck(installDir);

		execSync("git fetch --depth 1 origin main", {
			cwd: installDir,
			stdio: "pipe",
			timeout: FETCH_TIMEOUT_MS,
		});

		const localHead = execSync("git rev-parse HEAD", {
			cwd: installDir,
			encoding: "utf-8",
		}).trim();

		const remoteHead = execSync("git rev-parse origin/main", {
			cwd: installDir,
			encoding: "utf-8",
		}).trim();

		if (localHead === remoteHead) return null;

		const fromRef = localHead.slice(0, 7);

		execSync("git reset --hard origin/main", {
			cwd: installDir,
			stdio: "pipe",
		});

		execSync("npm install --no-fund --no-audit --loglevel=error", {
			cwd: installDir,
			stdio: "pipe",
			timeout: INSTALL_TIMEOUT_MS,
		});

		execSync("npm run build --silent", {
			cwd: installDir,
			stdio: "pipe",
			timeout: BUILD_TIMEOUT_MS,
		});

		const toRef = execSync("git rev-parse --short HEAD", {
			cwd: installDir,
			encoding: "utf-8",
		}).trim();

		return `claude-sync updated: ${fromRef} → ${toRef}`;
	} catch {
		return null; // silent failure
	}
}
