import type { Environment } from "../environment.js";

/** A single problem found by a verifier. Never contains file contents. */
export interface VerifyIssue {
	/** Path relative to the environment's config dir. */
	path: string;
	/** Short description of the problem. */
	problem: string;
}

export interface VerifyResult {
	ok: boolean;
	env: string;
	configDir: string;
	checked: Record<string, number | boolean>;
	errors: VerifyIssue[];
	warnings: VerifyIssue[];
	/** Present (true) when errors or warnings were capped. */
	truncated?: boolean;
}

export interface VerifyOptions {
	/** Home directory used to resolve $HOME, ~ and {{HOME}}. Defaults to os.homedir(). */
	homeDir?: string;
	/** PATH used to locate `node` for syntax checks. Defaults to process.env.PATH. */
	pathEnv?: string;
}

/** Verifies that one environment's synced configuration actually loads. Read-only. */
export interface Verifier {
	readonly id: string;
	verify(env: Environment, options?: VerifyOptions): Promise<VerifyResult>;
}

export const MAX_ISSUES = 200;

/** Collects issues and caps them at MAX_ISSUES each. */
export class IssueCollector {
	errors: VerifyIssue[] = [];
	warnings: VerifyIssue[] = [];
	truncated = false;

	error(path: string, problem: string): void {
		this.add(this.errors, { path, problem });
	}

	warn(path: string, problem: string): void {
		this.add(this.warnings, { path, problem });
	}

	private add(list: VerifyIssue[], issue: VerifyIssue): void {
		if (list.length >= MAX_ISSUES) {
			this.truncated = true;
			return;
		}
		list.push(issue);
	}

	result(env: Environment, checked: Record<string, number | boolean>): VerifyResult {
		const result: VerifyResult = {
			ok: this.errors.length === 0,
			env: env.id,
			configDir: env.getConfigDir(),
			checked,
			errors: this.errors,
			warnings: this.warnings,
		};
		if (this.truncated) result.truncated = true;
		return result;
	}
}
