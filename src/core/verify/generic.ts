import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Environment } from "../environment.js";
import { exists, rel, walk } from "./fs-utils.js";
import { IssueCollector, type Verifier, type VerifyResult } from "./types.js";

/** Strips // and block comments plus trailing commas (JSONC) outside of strings. */
function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i] as string;
		const n = text[i + 1];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && n === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && n === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parsesAsJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		try {
			JSON.parse(stripJsonc(text));
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Fallback verifier: every synced *.json file parses. No TOML parser is a
 * dependency of ai-sync, so TOML files are not checked.
 */
export const genericVerifier: Verifier = {
	id: "generic",
	async verify(env: Environment): Promise<VerifyResult> {
		const configDir = env.getConfigDir();
		const issues = new IssueCollector();
		let files = 0;
		const check = async (file: string) => {
			if (!file.endsWith(".json")) return;
			files++;
			let text: string;
			try {
				text = await fs.readFile(file, "utf-8");
			} catch {
				issues.error(rel(configDir, file), "cannot read file");
				return;
			}
			if (!parsesAsJson(text)) issues.error(rel(configDir, file), "invalid JSON");
		};
		for (const target of env.getSyncTargets()) {
			const full = path.join(configDir, target);
			if (target.endsWith("/")) {
				for await (const f of walk(full)) await check(f);
			} else {
				if (await exists(full)) await check(full);
			}
		}
		return issues.result(env, { files });
	},
};
