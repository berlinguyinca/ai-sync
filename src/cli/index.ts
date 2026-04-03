import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import { startupUpdateCheck } from "../core/updater.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
import { registerEnvCommand } from "./commands/env.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInstallSkillsCommand } from "./commands/install-skills.js";
import { registerLinkCommand } from "./commands/link.js";
import { registerMigrateCommand } from "./commands/migrate.js";
import { registerPullCommand } from "./commands/pull.js";
import { registerPushCommand } from "./commands/push.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpdateCommand } from "./commands/update.js";

/** Read version from package.json so it stays in sync automatically. */
function getVersion(): string {
	const thisFile = fileURLToPath(import.meta.url);
	let dir = path.dirname(thisFile);
	for (let i = 0; i < 5; i++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				if (pkg.version) return pkg.version;
			} catch {
				// keep searching
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "0.0.0";
}

const program = new Command();

program
	.name("ai-sync")
	.description(
		"Git-backed sync for AI tool configuration — keep your Claude Code and OpenCode config identical across machines.\n\n" +
			"Quick start:\n" +
			"  ai-sync init                  Create a sync repo from your local config\n" +
			"  ai-sync push                  Push local changes to the remote\n" +
			"  ai-sync pull                  Pull remote changes to local\n" +
			"  ai-sync status                Show what's changed\n" +
			"  ai-sync bootstrap <repo-url>  Set up a new machine from an existing repo\n" +
			"  ai-sync update                Check for and apply tool updates\n" +
			"  ai-sync install-skills        Install /sync and other slash commands\n" +
			"  ai-sync env list|enable|disable  Manage synced environments\n" +
			"  ai-sync link                  Symlink config to sync repo (single source of truth)\n" +
			"  ai-sync unlink                Revert symlinks back to regular files\n" +
			"  ai-sync migrate               Migrate v1 repo to v2 multi-env format\n\n" +
			"Update check: ai-sync notifies you of available updates once every 24 hours.\n" +
			"Run 'ai-sync update' to apply. Disable notifications with --no-update-check.",
	)
	.version(getVersion())
	.option("--no-update-check", "Skip automatic update check on startup");

registerInitCommand(program);
registerPushCommand(program);
registerPullCommand(program);
registerStatusCommand(program);
registerBootstrapCommand(program);
registerUpdateCommand(program);
registerInstallSkillsCommand(program);
registerEnvCommand(program);
registerLinkCommand(program);
registerMigrateCommand(program);

export { program };

// Only parse when run directly (not imported as a module)
// Check if this file is the entry point
const isDirectRun =
	typeof process !== "undefined" &&
	process.argv[1] &&
	(process.argv[1].endsWith("/cli/index.ts") ||
		process.argv[1].endsWith("/cli.js") ||
		process.argv[1].endsWith("/ai-sync"));

if (isDirectRun) {
	// Run startup update check before parsing commands
	// (unless --no-update-check is present)
	const skipUpdate = process.argv.includes("--no-update-check");
	const isUpdateCommand = process.argv.includes("update");

	if (!skipUpdate && !isUpdateCommand) {
		startupUpdateCheck().then((msg) => {
			if (msg) console.log(pc.cyan(msg));
			program.parseAsync();
		});
	} else {
		program.parseAsync();
	}
}
