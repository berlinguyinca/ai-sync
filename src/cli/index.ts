import { Command } from "commander";
import pc from "picocolors";
import { startupUpdateCheck } from "../core/updater.js";
import { registerBootstrapCommand } from "./commands/bootstrap.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInstallSkillsCommand } from "./commands/install-skills.js";
import { registerPullCommand } from "./commands/pull.js";
import { registerPushCommand } from "./commands/push.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpdateCommand } from "./commands/update.js";

const program = new Command();

program
	.name("claude-sync")
	.description(
		"Git-backed sync for ~/.claude — keep your Claude Code configuration identical across machines.\n\n" +
			"Quick start:\n" +
			"  claude-sync init                  Create a sync repo from your local ~/.claude\n" +
			"  claude-sync push                  Push local changes to the remote\n" +
			"  claude-sync pull                  Pull remote changes to local\n" +
			"  claude-sync status                Show what's changed\n" +
			"  claude-sync bootstrap <repo-url>  Set up a new machine from an existing repo\n" +
			"  claude-sync update                Check for and apply tool updates\n" +
			"  claude-sync install-skills        Install /sync and other Claude Code slash commands\n\n" +
			"Auto-update: claude-sync checks for updates once every 24 hours.\n" +
			"Disable with --no-update-check.",
	)
	.version("0.2.0")
	.option("--no-update-check", "Skip automatic update check on startup");

registerInitCommand(program);
registerPushCommand(program);
registerPullCommand(program);
registerStatusCommand(program);
registerBootstrapCommand(program);
registerUpdateCommand(program);
registerInstallSkillsCommand(program);

export { program };

// Only parse when run directly (not imported as a module)
// Check if this file is the entry point
const isDirectRun =
	typeof process !== "undefined" &&
	process.argv[1] &&
	(process.argv[1].endsWith("/cli/index.ts") || process.argv[1].endsWith("/cli.js"));

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
