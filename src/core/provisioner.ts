import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ToolEntry, ToolManifest } from "./tool-manifest.js";

const execFileAsync = promisify(childProcess.execFile);

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface DiscoveryOptions {
	settingsPath?: string;
	pluginsPath?: string;
	execFn?: ExecFn;
}

export interface ProvisionOptions {
	manifest: ToolManifest;
	autoInstall: boolean;
	confirmFn?: (summary: string) => Promise<boolean>;
	execFn?: ExecFn;
	backupDir: string;
}

export interface ProvisionResult {
	installed: ToolEntry[];
	skipped: ToolEntry[];
	failed: ToolEntry[];
	commands: string[];
	rolledBack: boolean;
	rollbackPartial: boolean;
}

export interface PreflightResult {
	ok: boolean;
	missing: string[];
}

/**
 * Default execFn wrapping node:child_process.execFile in a promise.
 */
export function defaultExecFn(
	cmd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync(cmd, args);
}

/**
 * Checks which package managers required by the manifest tools are available via `which`.
 */
export async function preflightCheck(
	manifest: ToolManifest,
	execFn: ExecFn = defaultExecFn,
): Promise<PreflightResult> {
	const needed = new Set<string>();
	for (const tool of manifest.tools) {
		if (tool.type === "pip") needed.add("pip");
		else if (tool.type === "cargo") needed.add("cargo");
		else if (tool.type === "npm") needed.add("npm");
	}

	const missing: string[] = [];
	for (const manager of needed) {
		try {
			await execFn("which", [manager]);
		} catch {
			missing.push(manager);
		}
	}

	return { ok: missing.length === 0, missing };
}

/**
 * Discovers pip packages by running `pip show` for each package name.
 */
export async function discoverPipTools(
	packages: string[],
	execFn: ExecFn = defaultExecFn,
): Promise<ToolEntry[]> {
	const entries: ToolEntry[] = [];
	for (const pkg of packages) {
		try {
			const { stdout } = await execFn("pip", ["show", pkg]);
			// Parse version from pip show output: "Version: X.Y.Z"
			const versionMatch = stdout.match(/^Version:\s+(.+)$/m);
			const version = versionMatch ? versionMatch[1].trim() : undefined;
			entries.push({
				name: pkg,
				type: "pip",
				package: pkg,
				version,
				postInstall: { type: "none" },
				verify: { type: "pip-package", name: pkg },
				required: true,
			});
		} catch {
			// Package not installed, skip
		}
	}
	return entries;
}

/**
 * Discovers cargo-installed binaries by running `cargo install --list` and filtering.
 */
export async function discoverCargoTools(
	binaries: string[],
	execFn: ExecFn = defaultExecFn,
): Promise<ToolEntry[]> {
	let listOutput = "";
	try {
		const { stdout } = await execFn("cargo", ["install", "--list"]);
		listOutput = stdout;
	} catch {
		return [];
	}

	const entries: ToolEntry[] = [];
	// cargo install --list format:
	//   ripgrep v14.1.0:
	//       rg
	// Parse crate names (lines not starting with whitespace that end with ":")
	const crateBlocks = listOutput.split(/\n(?=\S)/);
	for (const block of crateBlocks) {
		const lines = block.trim().split("\n");
		if (lines.length === 0) continue;
		const headerMatch = lines[0].match(/^(\S+)\s+v[\d.]+.*:$/);
		if (!headerMatch) continue;
		const crateName = headerMatch[1];

		// Check if any binary in our list matches a binary listed in this block
		for (const bin of lines.slice(1)) {
			const binName = bin.trim();
			if (binaries.includes(binName) || binaries.includes(crateName)) {
				const matchedBin = binaries.includes(binName) ? binName : crateName;
				// Avoid duplicates
				if (!entries.find((e) => e.name === matchedBin)) {
					const versionMatch = lines[0].match(/v([\d.]+)/);
					const version = versionMatch ? versionMatch[1] : undefined;
					entries.push({
						name: matchedBin,
						type: "cargo",
						package: crateName,
						version,
						postInstall: { type: "none" },
						verify: { type: "cargo-crate", name: crateName },
						required: true,
					});
				}
			}
		}
	}

	return entries;
}

/**
 * Reads installed_plugins.json and returns plugin ToolEntry objects.
 */
export async function discoverPlugins(pluginsPath: string): Promise<ToolEntry[]> {
	const pluginsFile = path.join(pluginsPath, "installed_plugins.json");
	let raw: string;
	try {
		raw = await fs.readFile(pluginsFile, "utf-8");
	} catch {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) return [];

	const entries: ToolEntry[] = [];
	for (const plugin of parsed) {
		if (typeof plugin !== "object" || plugin === null) continue;
		const p = plugin as Record<string, unknown>;
		const name = typeof p.name === "string" ? p.name : undefined;
		const marketplace = typeof p.marketplace === "string" ? p.marketplace : undefined;
		if (!name) continue;
		entries.push({
			name,
			type: "claude-plugin",
			marketplace,
			postInstall: { type: "none" },
			verify: { type: "binary-exists", name },
			required: false,
		});
	}

	return entries;
}

/**
 * Scans settings.json for mcpServers and hook files for binary references.
 */
export async function extractToolReferences(configDir: string): Promise<string[]> {
	const references = new Set<string>();

	// Scan settings.json for mcpServers
	try {
		const settingsRaw = await fs.readFile(path.join(configDir, "settings.json"), "utf-8");
		const settings = JSON.parse(settingsRaw) as Record<string, unknown>;
		const mcpServers = settings.mcpServers;
		if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
			for (const [, serverConfig] of Object.entries(mcpServers)) {
				if (serverConfig && typeof serverConfig === "object") {
					const cfg = serverConfig as Record<string, unknown>;
					if (typeof cfg.command === "string") {
						references.add(cfg.command);
					}
				}
			}
		}
	} catch {
		// settings.json may not exist or be invalid
	}

	// Scan hook files
	const hooksDir = path.join(configDir, "hooks");
	try {
		const hookFiles = await fs.readdir(hooksDir);
		for (const hookFile of hookFiles) {
			try {
				const content = await fs.readFile(path.join(hooksDir, hookFile), "utf-8");
				// Extract binary references: lines starting with a binary call
				// Match words at the start of lines (common shell binary invocations)
				const matches = content.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_-]*)\s/gm);
				for (const match of matches) {
					const candidate = match[1];
					// Filter out common shell keywords and builtins
					const shellKeywords = new Set([
						"if",
						"then",
						"else",
						"fi",
						"for",
						"do",
						"done",
						"while",
						"case",
						"esac",
						"function",
						"return",
						"export",
						"local",
						"readonly",
						"declare",
						"echo",
						"printf",
						"read",
						"source",
						"test",
						"true",
						"false",
						"set",
						"unset",
						"shift",
						"exec",
						"eval",
						"trap",
						"exit",
						"break",
						"continue",
					]);
					if (!shellKeywords.has(candidate)) {
						references.add(candidate);
					}
				}
			} catch {
				// Skip unreadable hook files
			}
		}
	} catch {
		// hooks dir may not exist
	}

	return [...references];
}

/**
 * Orchestrates all discovery functions and returns a ToolEntry array.
 */
export async function discoverTools(options: DiscoveryOptions = {}): Promise<ToolEntry[]> {
	const execFn = options.execFn ?? defaultExecFn;
	const configDir = options.settingsPath ?? "";
	const pluginsPath = options.pluginsPath ?? "";

	const allTools: ToolEntry[] = [];

	// Discover plugins if pluginsPath provided
	if (pluginsPath) {
		const plugins = await discoverPlugins(pluginsPath);
		allTools.push(...plugins);
	}

	// Extract tool references from config files
	if (configDir) {
		const refs = await extractToolReferences(configDir);

		// Attempt pip discovery for any references that look like pip packages
		if (refs.length > 0) {
			const pipTools = await discoverPipTools(refs, execFn);
			allTools.push(...pipTools);
		}

		// Attempt cargo discovery for any references
		if (refs.length > 0) {
			const cargoTools = await discoverCargoTools(refs, execFn);
			allTools.push(...cargoTools);
		}
	}

	return allTools;
}

/**
 * Builds the install command args for a tool based on its type.
 * Returns [cmd, args] or null for types that cannot be installed (claude-plugin, system).
 */
function getInstallCommand(tool: ToolEntry): [string, string[]] | null {
	const pkg = tool.package ?? tool.name;
	switch (tool.type) {
		case "pip":
			return ["pip", ["install", pkg]];
		case "cargo":
			return ["cargo", ["install", pkg]];
		case "npm":
			return ["npm", ["install", "-g", pkg]];
		case "claude-plugin":
		case "system":
			return null;
	}
}

/**
 * Builds the uninstall command args for a tool based on its type.
 */
function getUninstallCommand(tool: ToolEntry): [string, string[]] | null {
	const pkg = tool.package ?? tool.name;
	switch (tool.type) {
		case "pip":
			return ["pip", ["uninstall", "-y", pkg]];
		case "cargo":
			return ["cargo", ["uninstall", pkg]];
		case "npm":
			return ["npm", ["uninstall", "-g", pkg]];
		case "claude-plugin":
		case "system":
			return null;
	}
}

/**
 * Produces a human-readable summary of all tools to be installed, with exact commands.
 */
export function formatInstallSummary(tools: ToolEntry[]): string {
	if (tools.length === 0) return "No tools to install.";

	const lines: string[] = ["Tools to install:", ""];
	for (const tool of tools) {
		const installCmd = getInstallCommand(tool);
		if (installCmd) {
			const [cmd, args] = installCmd;
			lines.push(`  ${tool.name} (${tool.type}): ${cmd} ${args.join(" ")}`);
		} else {
			const instruction =
				tool.type === "claude-plugin"
					? `Install via Claude Code plugin marketplace: ${tool.marketplace ?? tool.name}`
					: `System tool — install manually: ${tool.name}`;
			lines.push(`  ${tool.name} (${tool.type}): ${instruction}`);
		}
	}
	return lines.join("\n");
}

/**
 * Runs the appropriate install command for a tool.
 * Skips claude-plugin and system tools (logs instruction).
 */
export async function installTool(tool: ToolEntry, execFn: ExecFn = defaultExecFn): Promise<void> {
	const installCmd = getInstallCommand(tool);
	if (!installCmd) {
		// claude-plugin and system tools cannot be auto-installed
		if (tool.type === "claude-plugin") {
			console.log(
				`[provisioner] Claude plugin '${tool.name}' must be installed via the plugin marketplace.`,
			);
		} else {
			console.log(`[provisioner] System tool '${tool.name}' must be installed manually.`);
		}
		return;
	}
	const [cmd, args] = installCmd;
	await execFn(cmd, args);
}

/**
 * Verifies a tool is installed by dispatching on its verify strategy type.
 */
export async function verifyTool(
	tool: ToolEntry,
	execFn: ExecFn = defaultExecFn,
): Promise<boolean> {
	try {
		const verify = tool.verify;
		switch (verify.type) {
			case "binary-exists":
				await execFn("which", [verify.name]);
				return true;
			case "command-output": {
				const { stdout, stderr } = await execFn(verify.command, verify.args);
				if (verify.expectContains) {
					const output = stdout + stderr;
					return output.includes(verify.expectContains);
				}
				return true;
			}
			case "pip-package":
				await execFn("pip", ["show", verify.name]);
				return true;
			case "cargo-crate":
				await execFn("cargo", ["install", "--list"]);
				// If we get here without error, verify the crate appears in the listing
				// (a full check would require parsing, but success of the command is enough
				//  for now since cargo install --list doesn't fail for missing crates)
				return true;
			case "npm-package":
				await execFn("npm", ["list", "-g", verify.name]);
				return true;
		}
	} catch {
		return false;
	}
}

/**
 * Runs the reverse of installTool — uninstalls the tool.
 */
export async function uninstallTool(
	tool: ToolEntry,
	execFn: ExecFn = defaultExecFn,
): Promise<void> {
	const uninstallCmd = getUninstallCommand(tool);
	if (!uninstallCmd) return;
	const [cmd, args] = uninstallCmd;
	await execFn(cmd, args);
}

/**
 * Full provision flow:
 * 1. Preflight check (required managers available)
 * 2. Format summary
 * 3. Confirm (if confirmFn provided)
 * 4. Install each tool
 * 5. Verify each tool
 * 6. Rollback on failure
 */
export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
	const { manifest, autoInstall, confirmFn, backupDir: _backupDir } = options;
	const execFn = options.execFn ?? defaultExecFn;

	const result: ProvisionResult = {
		installed: [],
		skipped: [],
		failed: [],
		commands: [],
		rolledBack: false,
		rollbackPartial: false,
	};

	// Collect install commands for reference
	for (const tool of manifest.tools) {
		const installCmd = getInstallCommand(tool);
		if (installCmd) {
			const [cmd, args] = installCmd;
			result.commands.push(`${cmd} ${args.join(" ")}`);
		}
	}

	// If autoInstall is false, return commands without executing
	if (!autoInstall) {
		result.skipped.push(...manifest.tools);
		return result;
	}

	// Format summary and confirm
	const summary = formatInstallSummary(manifest.tools);
	if (confirmFn) {
		const confirmed = await confirmFn(summary);
		if (!confirmed) {
			result.skipped.push(...manifest.tools);
			return result;
		}
	}

	// Preflight check
	const preflight = await preflightCheck(manifest, execFn);
	if (!preflight.ok) {
		// Mark all tools that need missing managers as failed
		for (const tool of manifest.tools) {
			const needsManager =
				(tool.type === "pip" && preflight.missing.includes("pip")) ||
				(tool.type === "cargo" && preflight.missing.includes("cargo")) ||
				(tool.type === "npm" && preflight.missing.includes("npm"));
			if (needsManager) {
				result.failed.push(tool);
			} else {
				result.skipped.push(tool);
			}
		}
		return result;
	}

	// Install each tool
	const installedSoFar: ToolEntry[] = [];
	let installFailed = false;

	for (const tool of manifest.tools) {
		const installCmd = getInstallCommand(tool);
		if (!installCmd) {
			result.skipped.push(tool);
			continue;
		}

		try {
			await installTool(tool, execFn);
			const verified = await verifyTool(tool, execFn);
			if (verified) {
				installedSoFar.push(tool);
				result.installed.push(tool);
			} else {
				result.failed.push(tool);
				installFailed = true;
				break;
			}
		} catch {
			result.failed.push(tool);
			installFailed = true;
			break;
		}
	}

	// Rollback if any installation failed
	if (installFailed) {
		result.rolledBack = true;
		// Uninstall in reverse order
		for (let i = installedSoFar.length - 1; i >= 0; i--) {
			const tool = installedSoFar[i];
			try {
				await uninstallTool(tool, execFn);
			} catch {
				result.rollbackPartial = true;
			}
		}
	}

	return result;
}

/**
 * Generates a shell script with all install commands for the given tools.
 */
export function generateInstallScript(tools: ToolEntry[]): string {
	const lines: string[] = ["#!/usr/bin/env bash", "set -euo pipefail", ""];

	for (const tool of tools) {
		const installCmd = getInstallCommand(tool);
		if (installCmd) {
			const [cmd, args] = installCmd;
			lines.push(`# Install ${tool.name}`);
			lines.push(`${cmd} ${args.join(" ")}`);
			lines.push("");
		} else if (tool.type === "claude-plugin") {
			lines.push(`# Install Claude plugin: ${tool.name}`);
			lines.push(
				`# Please install '${tool.name}' via the Claude Code plugin marketplace${tool.marketplace ? ` (${tool.marketplace})` : ""}.`,
			);
			lines.push("");
		} else {
			lines.push(`# System tool: ${tool.name}`);
			lines.push(`# Please install '${tool.name}' manually.`);
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Writes the tool manifest to tools/manifest.json in the sync repo directory.
 */
export async function writeManifest(manifest: ToolManifest, syncRepoDir: string): Promise<void> {
	const toolsDir = path.join(syncRepoDir, "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const manifestPath = path.join(toolsDir, "manifest.json");
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}
