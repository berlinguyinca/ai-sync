import type { Environment } from "../environment.js";
import { claudeVerifier } from "./claude.js";
import { genericVerifier } from "./generic.js";
import type { Verifier, VerifyOptions, VerifyResult } from "./types.js";

export type { Verifier, VerifyIssue, VerifyOptions, VerifyResult } from "./types.js";

/** Verifiers keyed by environment id. Environments without one use the generic check. */
const VERIFIERS = new Map<string, Verifier>([[claudeVerifier.id, claudeVerifier]]);

export function registerVerifier(verifier: Verifier): void {
	VERIFIERS.set(verifier.id, verifier);
}

export function getVerifier(envId: string): Verifier {
	return VERIFIERS.get(envId) ?? genericVerifier;
}

export async function verifyEnvironment(
	env: Environment,
	options?: VerifyOptions,
): Promise<VerifyResult> {
	return getVerifier(env.id).verify(env, options);
}
