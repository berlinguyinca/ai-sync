import { FABRIC_TOKEN_ENV } from "./config.js";

export const FABRIC_TIMEOUT_MS = 5_000;
export const FABRIC_MAX_BYTES = 1_000_000;

export interface FabricHost {
	host_id: string;
	ai_sync_version: string | null;
	envs_enabled: string[];
	last_sync_ts: string | null;
	ahead: number | null;
	behind: number | null;
	drifted_files_count: number | null;
	last_error: string | null;
	checked_at: string;
}

export interface FabricSharedConfig {
	repo_url: string;
	branch: string;
	envs: string[];
	merge_enabled: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isIntOrNull = (v: unknown): v is number | null => v === null || Number.isInteger(v);
const isStrArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

export function isFabricHost(v: unknown): v is FabricHost {
	return (
		isObj(v) &&
		typeof v.host_id === "string" &&
		isStrOrNull(v.ai_sync_version) &&
		isStrArray(v.envs_enabled) &&
		isStrOrNull(v.last_sync_ts) &&
		isIntOrNull(v.ahead) &&
		isIntOrNull(v.behind) &&
		isIntOrNull(v.drifted_files_count) &&
		isStrOrNull(v.last_error) &&
		typeof v.checked_at === "string"
	);
}

export function isFabricSharedConfig(v: unknown): v is FabricSharedConfig {
	return (
		isObj(v) &&
		typeof v.repo_url === "string" &&
		typeof v.branch === "string" &&
		isStrArray(v.envs) &&
		typeof v.merge_enabled === "boolean"
	);
}

export class FabricError extends Error {
	constructor(
		message: string,
		readonly kind: "http" | "timeout" | "oversize" | "invalid" | "network",
		readonly status?: number,
	) {
		super(message);
		this.name = "FabricError";
	}
}

async function readCapped(res: Response): Promise<string> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > FABRIC_MAX_BYTES) {
		await res.body?.cancel();
		throw new FabricError("fabric response too large", "oversize");
	}
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > FABRIC_MAX_BYTES) {
			await reader.cancel();
			throw new FabricError("fabric response too large", "oversize");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/** GET {baseUrl}{path}; returns parsed JSON, or null on 404. Never logs the token. */
async function fabricGet(
	baseUrl: string,
	apiPath: string,
	env: NodeJS.ProcessEnv,
): Promise<unknown | null> {
	const headers: Record<string, string> = { Accept: "application/json" };
	const token = env[FABRIC_TOKEN_ENV];
	if (token) headers["X-API-Key"] = token;
	// One signal covers connect, headers and body read.
	const signal = AbortSignal.timeout(FABRIC_TIMEOUT_MS);
	try {
		// redirect: "error" so the token is never forwarded to another origin.
		const res = await fetch(`${baseUrl}${apiPath}`, { headers, signal, redirect: "error" });
		if (res.status === 404) {
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new FabricError(`fabric returned HTTP ${res.status}`, "http", res.status);
		}
		const text = await readCapped(res);
		try {
			return JSON.parse(text);
		} catch {
			throw new FabricError("fabric returned invalid JSON", "invalid");
		}
	} catch (err) {
		if (err instanceof FabricError) throw err;
		if (signal.aborted) throw new FabricError("fabric request timed out", "timeout");
		throw new FabricError("could not reach fabric endpoint", "network");
	}
}

export async function fetchFabricHosts(
	baseUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<FabricHost[]> {
	const body = await fabricGet(baseUrl, "/api/v1/ai-sync", env);
	if (!isObj(body) || !Array.isArray(body.hosts) || !body.hosts.every(isFabricHost)) {
		throw new FabricError("fabric hosts response failed validation", "invalid");
	}
	return body.hosts;
}

/** Returns null when the fabric has no shared config (404). */
export async function fetchFabricConfig(
	baseUrl: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<FabricSharedConfig | null> {
	const body = await fabricGet(baseUrl, "/api/v1/ai-sync/config", env);
	if (body === null) return null;
	if (!isFabricSharedConfig(body)) {
		throw new FabricError("fabric config response failed validation", "invalid");
	}
	return body;
}
