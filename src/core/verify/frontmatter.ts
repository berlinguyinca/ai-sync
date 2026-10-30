import { parse } from "yaml";

export type FrontmatterResult =
	| { kind: "none" }
	| { kind: "invalid"; problem: string }
	| { kind: "ok"; data: Record<string, unknown> };

/**
 * Parses YAML frontmatter delimited by `---` lines at the very start of a file.
 * Error messages are generic: they never echo file content.
 */
export function parseFrontmatter(text: string): FrontmatterResult {
	const normalized = text.replace(/^﻿/, "");
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
	if (!match) {
		if (/^---[ \t]*\r?\n/.test(normalized)) {
			return { kind: "invalid", problem: "unterminated frontmatter" };
		}
		return { kind: "none" };
	}
	let data: unknown;
	try {
		data = parse(match[1] ?? "", { strict: true, uniqueKeys: true });
	} catch {
		return { kind: "invalid", problem: "frontmatter is not valid YAML" };
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		return { kind: "invalid", problem: "frontmatter is not a mapping" };
	}
	return { kind: "ok", data: data as Record<string, unknown> };
}
