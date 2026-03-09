import type { Command } from "commander";
import pc from "picocolors";
import { performUpdate } from "../../core/updater.js";

/**
 * Registers the "update" subcommand on the CLI program.
 */
export function registerUpdateCommand(program: Command): void {
	program
		.command("update")
		.description("Check for and apply claude-sync updates")
		.option("--force", "Force check even if checked recently", false)
		.action(async (opts) => {
			try {
				console.log(pc.dim("Checking for updates..."));
				const result = await performUpdate(opts.force);

				if (result.updated) {
					console.log(pc.green(result.message));
				} else {
					console.log(pc.yellow(result.message));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Update failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
