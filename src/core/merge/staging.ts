import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

export const StagedEntrySchema = z.object({
	envName: z.string(),
	relativePath: z.string(),
	resolver: z.string(),
	notes: z.string().optional(),
	timestamp: z.string(),
});
export type StagedEntry = z.infer<typeof StagedEntrySchema>;

const ManifestSchema = z.object({
	version: z.literal(1).default(1),
	entries: z.array(StagedEntrySchema).default(() => []),
});
type Manifest = z.infer<typeof ManifestSchema>;

const PENDING_DIR = ".ai-sync/pending";

function pendingDir(syncRepoDir: string): string {
	return path.join(syncRepoDir, PENDING_DIR);
}

function manifestPath(syncRepoDir: string): string {
	return path.join(pendingDir(syncRepoDir), "manifest.json");
}

async function readManifest(syncRepoDir: string): Promise<Manifest> {
	try {
		const raw = await fs.readFile(manifestPath(syncRepoDir), "utf-8");
		return ManifestSchema.parse(JSON.parse(raw));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { version: 1, entries: [] };
		throw err;
	}
}

async function writeManifest(syncRepoDir: string, manifest: Manifest): Promise<void> {
	await fs.mkdir(pendingDir(syncRepoDir), { recursive: true });
	await fs.writeFile(manifestPath(syncRepoDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Appends `.ai-sync/pending/` to the sync repo's `.gitignore` exactly once.
 * Idempotent: scans existing entries before writing.
 */
export async function ensureGitignoreEntry(syncRepoDir: string): Promise<void> {
	const gitignorePath = path.join(syncRepoDir, ".gitignore");
	let existing = "";
	try {
		existing = await fs.readFile(gitignorePath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const lines = existing.split("\n").map((l) => l.trim());
	const wanted = ".ai-sync/pending/";
	const wantedAlt = ".ai-sync/pending";
	if (lines.includes(wanted) || lines.includes(wantedAlt)) return;
	const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	await fs.writeFile(gitignorePath, `${existing}${sep}${wanted}\n`, "utf-8");
}

export interface StageInput {
	envName: string;
	relativePath: string;
	mergedContent: string;
	resolver: string;
	notes?: string;
}

/**
 * Writes the merged content under `<syncRepoDir>/.ai-sync/pending/<env>/<rel>`
 * and appends a manifest entry. Idempotent on (envName, relativePath):
 * a second call overwrites the file and updates the existing manifest entry.
 */
export async function stage(syncRepoDir: string, input: StageInput): Promise<StagedEntry> {
	await fs.mkdir(pendingDir(syncRepoDir), { recursive: true });
	await ensureGitignoreEntry(syncRepoDir);

	const filePath = path.join(pendingDir(syncRepoDir), input.envName, input.relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, input.mergedContent, "utf-8");

	const entry: StagedEntry = {
		envName: input.envName,
		relativePath: input.relativePath,
		resolver: input.resolver,
		notes: input.notes,
		timestamp: new Date().toISOString(),
	};

	const manifest = await readManifest(syncRepoDir);
	const idx = manifest.entries.findIndex(
		(e) => e.envName === input.envName && e.relativePath === input.relativePath,
	);
	if (idx >= 0) manifest.entries[idx] = entry;
	else manifest.entries.push(entry);
	await writeManifest(syncRepoDir, manifest);
	return entry;
}

/** Returns the list of staged merge entries, or an empty array. */
export async function listStaged(syncRepoDir: string): Promise<StagedEntry[]> {
	const manifest = await readManifest(syncRepoDir);
	return manifest.entries;
}
