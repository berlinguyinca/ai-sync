import type { Command } from "commander";
import pc from "picocolors";
import { installSkills } from "../../core/skills.js";
import { getClaudeDir } from "../../platform/paths.js";

/**
 * Registers the "install-skills" subcommand on the CLI program.
 */
export function registerInstallSkillsCommand(program: Command): void {
	program
		.command("install-skills")
		.description("Install Claude Code slash commands (e.g., /sync) into ~/.claude/commands/")
		.option("--claude-dir <path>", "Custom ~/.claude path", getClaudeDir())
		.action(async (opts) => {
			try {
				const result = await installSkills(opts.claudeDir);

				if (result.installed.length > 0) {
					console.log(pc.green(`Installed skills: ${result.installed.join(", ")}`));
				}
				if (result.skipped.length > 0) {
					console.log(pc.dim(`Already up to date: ${result.skipped.join(", ")}`));
				}
				if (result.installed.length === 0 && result.skipped.length === 0) {
					console.log(pc.yellow("No skill files found"));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(pc.red(`Install skills failed: ${message}`));
				process.exitCode = 1;
			}
		});
}
