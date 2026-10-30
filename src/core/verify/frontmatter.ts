import { parse } from "yaml";

export type FrontmatterResult =
	| { kind: "none" }
	| { kind: "invalid"; problem: string }
	| { kind: "ok"; data: Record<string, unknown>; lenient?: true };

export const LENIENT_WARNING =
	'frontmatter is not strict YAML (unquoted ": " in value); tolerated by Claude Code — quote the value to be portable';

function stripQuotes(v: string): string {
	const q = v[0];
	if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) return v.slice(1, -1);
	return v;
}

/** A value that opens a quote or flow collection must close it. */
function isBalanced(v: string): boolean {
	const c = v[0];
	if (c === '"' || c === "'") return v.length >= 2 && v.endsWith(c);
	if (c === "[") return v.endsWith("]");
	if (c === "{") return v.endsWith("}");
	return true;
}

/**
 * Line-based fallback mirroring how Claude Code reads frontmatter: top-level
 * `key: rest-of-line` pairs, value taken verbatim. Returns null on anything
 * that is not a key line, a comment, a blank, a `-` item or a space-indented
 * continuation.
 */
function parseLenient(body: string): Record<string, unknown> | null {
	const data: Record<string, unknown> = {};
	for (const line of body.split(/\r?\n/)) {
		if (line.trim() === "" || line.startsWith("#") || line.startsWith("- ")) continue;
		if (line.startsWith(" ")) continue;
		const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/.exec(line);
		if (!m) return null;
		const raw = (m[2] ?? "").trim();
		if (!isBalanced(raw)) return null;
		data[m[1] as string] = stripQuotes(raw);
	}
	return data;
}

/**
 * Parses YAML frontmatter delimited by `---` lines at the very start of a file.
 * Error messages are generic: they never echo file content. If strict YAML
 * fails, a lenient line parser is tried; it is accepted only when every
 * `required` key is a non-empty string (result is flagged `lenient`).
 */
export function parseFrontmatter(text: string, required: string[] = []): FrontmatterResult {
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
		const lenient = parseLenient(match[1] ?? "");
		if (lenient && required.every((k) => typeof lenient[k] === "string" && lenient[k] !== "")) {
			return { kind: "ok", data: lenient, lenient: true };
		}
		return { kind: "invalid", problem: "frontmatter is not valid YAML" };
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		return { kind: "invalid", problem: "frontmatter is not a mapping" };
	}
	return { kind: "ok", data: data as Record<string, unknown> };
}
