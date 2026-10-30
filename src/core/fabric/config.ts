import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSyncRepoDir } from "../../platform/paths.js";

export const FABRIC_URL_ENV = "AI_SYNC_FABRIC_URL";
export const FABRIC_TOKEN_ENV = "AI_SYNC_FABRIC_TOKEN";

/**
 * Validates a fabric endpoint URL: http(s) only, no embedded credentials.
 * Returns the normalized URL without a trailing slash.
 */
export function parseFabricUrl(raw: unknown): string {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error("fabric url must be a non-empty string");
	}
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new Error("fabric url is not a valid URL");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error("fabric url must use http or https");
	}
	if (u.username || u.password) {
		throw new Error("fabric url must not contain credentials; use AI_SYNC_FABRIC_TOKEN");
	}
	return u.toString().replace(/\/+$/, "");
}

/**
 * Resolves the fabric endpoint. Returns null when not configured (the default),
 * in which case callers must make no network calls.
 *
 * Order: env AI_SYNC_FABRIC_URL, then `<syncRepoDir>/tools/fabric.json` {"url": "..."}.
 * A present-but-malformed file throws.
 */
export async function loadFabricConfig(
	syncRepoDir: string = getSyncRepoDir(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ url: string } | null> {
	const fromEnv = env[FABRIC_URL_ENV];
	if (fromEnv !== undefined && fromEnv.trim() !== "") {
		return { url: parseFabricUrl(fromEnv) };
	}
	const configPath = path.join(syncRepoDir, "tools", "fabric.json");
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid ${configPath}: expected an object with a "url" field`);
	}
	return { url: parseFabricUrl((parsed as { url?: unknown }).url) };
}
