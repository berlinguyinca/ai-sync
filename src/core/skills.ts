import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getClaudeDir } from "../platform/paths.js";

/**
 * Finds the skills source directory by walking up from the running module.
 */
async function findSkillsDir(): Promise<string> {
	const thisFile = fileURLToPath(import.meta.url);
	let dir = path.dirname(thisFile);

	for (let i = 0; i < 5; i++) {
		const candidate = path.join(dir, "skills");
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) return candidate;
		} catch {
			// not here, keep going up
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	throw new Error("Could not find skills/ directory in claude-sync installation");
}

export interface InstallSkillsResult {
	installed: string[];
	skipped: string[];
}

/**
 * Installs claude-sync skill files into ~/.claude/commands/.
 * Overwrites existing files to ensure they stay up to date.
 */
export async function installSkills(claudeDir?: string): Promise<InstallSkillsResult> {
	const targetBase = path.join(claudeDir ?? getClaudeDir(), "commands");
	const skillsDir = await findSkillsDir();

	await fs.mkdir(targetBase, { recursive: true });

	const entries = await fs.readdir(skillsDir);
	const mdFiles = entries.filter((f) => f.endsWith(".md"));

	const installed: string[] = [];
	const skipped: string[] = [];

	for (const file of mdFiles) {
		const src = path.join(skillsDir, file);
		const dest = path.join(targetBase, file);

		const srcContent = await fs.readFile(src, "utf-8");

		// Check if file already exists with same content
		try {
			const destContent = await fs.readFile(dest, "utf-8");
			if (destContent === srcContent) {
				skipped.push(file);
				continue;
			}
		} catch {
			// file doesn't exist yet
		}

		await fs.writeFile(dest, srcContent);
		installed.push(file);
	}

	return { installed, skipped };
}
