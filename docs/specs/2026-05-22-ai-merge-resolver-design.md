# AI-assisted merge resolver for ai-sync

**Date:** 2026-05-22
**Status:** Approved design — ready for issue decomposition
**Repo:** berlinguyinca/ai-sync

## 1. Problem

`ai-sync` keeps AI-tool configs (Claude Code, OpenCode) synced across machines via a git-backed sync repo. The current 3-way merge in `src/core/sync-engine.ts:633-640` falls back to *keep local* whenever both sides of a file change. That silently discards the remote intent, which is the wrong default for users running this across multiple machines where each side legitimately edits `CLAUDE.md`, skills, settings, and agent prompts.

The user also wants better visibility and reconciliation when machines have drifted significantly since the last sync — not just one-file conflicts but the broader "what changed where" question.

## 2. Goals

- Replace *keep local on conflict* with a pluggable AI-driven resolver that proposes a merged version.
- Default to **staged review** — merged output lands in a review area, never overwrites live config until the user accepts.
- Support multiple local AI runtimes via a single resolver interface: **claude**, **codex**, and **opencode** CLI adapters in v1.
- Apply **per-file-type strategies**: markdown free-form, JSON/YAML AI + parse-validate, unknown → keep-local fallback.
- Add a **drift report** (`ai-sync status`) and an AI-assisted **`--summarize`** flag for natural-language summaries of what changed on each side.
- Never abort a pull because the AI failed — resolver failures always fall back to existing keep-local behavior with a warning.

## 3. Non-goals

- Confidence-scored hybrid auto-apply (LLM "confidence" is too fuzzy in v1).
- Schema validation beyond syntactic parse-check.
- Semantic merge of binary or lock files.
- Cloud-API resolvers (the runtime is always a CLI the user already has installed).
- Auto-installation of any AI CLI; if the configured resolver's binary is missing, fall back gracefully.

## 4. Architecture

### 4.1 New module: `src/core/merge/`

```
src/core/merge/
  resolver.ts        # MergeResolver interface + ResolverError types
  strategies.ts      # Per-file-type dispatcher (md / json / yaml / unknown)
  staging.ts         # Write merged output to <sync-repo>/.ai-sync/pending/
  prompts.ts         # Shared prompt templates for adapters
  adapters/
    claude-cli.ts    # Shells out to `claude` (or `claude-code`)
    codex-cli.ts     # Shells out to `codex`
    opencode-cli.ts  # Shells out to `opencode`
    index.ts         # Adapter registry: name → factory
```

### 4.2 Resolver interface

```ts
export interface MergeInput {
  relativePath: string;       // e.g. "CLAUDE.md"
  envName: string;            // e.g. "claude" | "opencode"
  base: string | null;        // last-synced content; null if file is new
  local: string;              // current on-disk content
  remote: string;             // post-pull content from sync repo
  fileType: FileType;         // resolved by strategies.ts
}

export interface MergeOutput {
  mergedContent: string;
  notes?: string;             // adapter rationale, surfaced in status
}

export interface MergeResolver {
  readonly name: string;      // "claude" | "codex" | "opencode"
  available(): Promise<boolean>;          // probe binary exists
  resolve(input: MergeInput): Promise<MergeOutput>;
}

export type FileType =
  | { kind: "markdown" }
  | { kind: "json" }
  | { kind: "yaml" }
  | { kind: "unknown"; extension: string };
```

`available()` lets the orchestrator skip an adapter cleanly when its CLI isn't installed. Adapters mirror the existing `ExecFn` pattern from `src/core/provisioner.ts:7` — they accept an `execFn` parameter so they can be unit-tested without spawning real processes.

### 4.3 Strategy dispatcher

`strategies.ts` exports `mergeWithStrategy(input, resolver) → Promise<StrategyResult>`. It:

1. Classifies the file by extension (and content-sniff for unextensioned files like `Makefile`).
2. For **markdown** (`.md`, `.markdown`, `.txt`): pass to resolver verbatim; return its output unchanged.
3. For **JSON** (`.json`): pass to resolver; on return, run `JSON.parse(mergedContent)`. If parse fails, return `{ ok: false, reason: "json-parse" }` — strategy falls back to keep-local in the caller.
4. For **YAML** (`.yml`, `.yaml`): same as JSON but with a YAML parser (`yaml` package, added to deps).
5. For **unknown**: return `{ ok: false, reason: "unsupported-type" }` — keep-local.

Per-type behavior is overridable via config (see §4.5).

### 4.4 Staging

On a successful merge, `staging.ts` writes:

```
<sync-repo>/.ai-sync/pending/
  manifest.json                 # array of { envName, relativePath, resolver, notes, timestamp }
  <envName>/<relativePath>      # the merged content
```

`.ai-sync/pending/` is added to the sync repo's `.gitignore` so staged merges never propagate via push.

### 4.5 Config surface

A new top-level config file `tools/merge-config.json` in the sync repo, parallel to `tools/config.json` (loaded by `src/core/provision-config.ts`). Schema (validated with `zod`):

```jsonc
{
  "resolver": "claude",                // "claude" | "codex" | "opencode"
  "autoApply": false,                  // CLI --auto-apply overrides this
  "perType": {
    "*.md":   "ai-freeform",
    "*.json": "ai-validated",
    "*.yaml": "ai-validated",
    "*.yml":  "ai-validated",
    "*.lock": "keep-local",
    "*":      "keep-local"             // default
  },
  "timeoutSeconds": 60                 // hard cap per resolver call
}
```

If the file is absent, defaults apply (`resolver: "claude"`, `autoApply: false`, per-type defaults as listed).

An additional `enabled: boolean` field (default `false` in v1, flipped to `true` by issue #8) gates the entire AI-merge path. When `enabled: false`, `tryAiMerge` short-circuits to keep-local on the very first call, preserving exact pre-feature behavior.

### 4.6 Wire-in to `sync-engine.ts`

At `src/core/sync-engine.ts:633-640` (the "Both changed — conflict, keep local version" branch inside `syncPull`), the change is:

```ts
// Before: push to envConflicts and keep local.
// After:
const merge = await tryAiMerge({
  relativePath, envName, base: baseContent, local: localContent, remote: remoteContent,
  resolver, strategies, autoApply, staging, logger
});
if (merge.kind === "staged") {
  envStaged.push(merge.entry);
} else if (merge.kind === "applied") {
  filesApplied++;
  envChanges.push({ ... });
} else {
  // merge.kind === "fallback": original keep-local path
  envConflicts.push({ ... });
  logger.warn(`Resolver fell back: ${merge.reason}`);
}
```

Same shape applied to the delete-conflict branch at lines 669-678 (a deletion staged for review is just a marker entry in the manifest).

### 4.7 CLI surface

- `ai-sync pull` — unchanged ergonomics. Final report adds a "Staged for review" section listing pending merges.
- `ai-sync pull --auto-apply` — skips staging; merged output lands directly. Backups still taken.
- `ai-sync resolve` — list / diff / accept / reject staged merges.
  - `ai-sync resolve list` — table of pending entries.
  - `ai-sync resolve diff <relpath>` — show local-vs-merged diff.
  - `ai-sync resolve accept <relpath>` — copy merged file into the live target, remove from manifest.
  - `ai-sync resolve reject <relpath>` — drop the staged file, remove from manifest.
  - `ai-sync resolve accept --all` / `reject --all` — bulk variants.
- `ai-sync status` — drift report: per-env counts of `local-only`, `remote-only`, `both-changed`, `staged-pending` files; also lists names if `--verbose`.
- `ai-sync status --summarize` — additionally invokes the configured resolver in a "summarize differences" mode (no merge), produces a natural-language summary of what each side changed.

All commands follow the existing `registerXCommand(program)` + `handleX(options)` pattern (see `src/cli/commands/init.ts:186-208`).

### 4.8 Adapter contract

Each adapter receives a structured prompt (built in `prompts.ts`) and is expected to return only the merged content on stdout, no commentary. The adapter is responsible for stripping any framing the CLI adds (e.g., banner lines).

Adapter invocations:

- **claude-cli**: `claude -p <prompt-file>` (one-shot, non-interactive). Probe via `claude --version`.
- **codex-cli**: `codex exec --prompt-file <prompt-file>`. Probe via `codex --version`.
- **opencode-cli**: `opencode run -p <prompt-file>`. Probe via `opencode --version`.

Each adapter writes prompt/base/local/remote to a tempdir under `os.tmpdir()/ai-sync-merge-<pid>-<random>/`, invokes the CLI with stdout captured, and cleans up on completion. The tempdir is preserved on failure for postmortem (path surfaced in the warning).

A hard timeout of `merge.timeoutSeconds` (default 60s) is enforced via `AbortController` + `child_process.execFile`'s `signal` option. On timeout, the strategy reports `fallback: "timeout"`.

## 5. Data flow

```
pull → for each env → for each file →
  3-way diff classify →
    no conflict   → existing path
    conflict      → strategies.mergeWithStrategy
                        ↳ resolver.resolve (claude/codex/opencode)
                        ↳ post-validate (parse for json/yaml)
                        ↳ on success: staging.stage OR live-apply (if --auto-apply)
                        ↳ on any failure: envConflicts.push (keep-local)
→ render report (changes + staged + conflicts)
```

## 6. Error handling

Every failure mode lands the file in keep-local with a single-line warning. None abort the pull.

| Failure | Behavior |
|---|---|
| Configured adapter binary missing | Warn once at pull start; treat as keep-local for all conflicts in this run |
| Adapter returns non-zero | Keep-local for that file; preserve tempdir path in warning |
| Adapter exceeds timeout | Kill subprocess; keep-local |
| JSON/YAML parse fails post-merge | Keep-local; preserve merged-but-invalid output under `.ai-sync/pending/.invalid/` for inspection |
| Staging dir write fails | Keep-local; surface filesystem error |
| Unknown file type with no per-type override | Keep-local (no warning — this is the documented default) |

The `conflicts` field in `SyncPullResult` (currently surfaced in `src/cli/commands/pull.ts:81-96`) stays backward compatible: only true fallbacks land there. Staged merges land in a new `staged` field.

## 7. Testing

Follows the existing pattern in `tests/core/sync-engine.test.ts` — real filesystem in tmpdir, real git via `simple-git`. No mocks for git or fs.

The one thing that IS mocked: the resolver's underlying subprocess call. Adapter tests inject a fake `execFn` (matching the `ExecFn` type from `provisioner.ts`) that returns canned stdout. This mirrors the existing `provisioner` test approach.

Test coverage:

- `tests/core/merge/resolver.test.ts` — adapter contract: probe, success, non-zero, timeout, malformed output. One file per adapter.
- `tests/core/merge/strategies.test.ts` — per-type dispatch: markdown passes through; JSON valid → applied; JSON invalid → fallback; YAML same; unknown → fallback; per-type override respected.
- `tests/core/merge/staging.test.ts` — manifest write/read, directory layout, accept/reject mutate the manifest correctly.
- `tests/core/sync-engine.test.ts` — extend with cases: conflict with resolver succeeds → staged; conflict with resolver fails → still in `conflicts`; `--auto-apply` overrides staging.
- `tests/cli/commands/resolve.test.ts` — list/diff/accept/reject end-to-end.
- `tests/cli/commands/status.test.ts` — drift counts, `--summarize` invokes resolver once per env, never errors fatally.

TDD per AGENTS.md / CLAUDE.md. Coverage target ≥80% on the new module.

## 8. Dependencies to add

- `yaml` (^2.x) — YAML parse-validation. No need to mutate YAML; only need to confirm `parse()` doesn't throw.
- No new subprocess library — reuse the `execFileAsync`/`ExecFn` pattern from `src/core/provisioner.ts:7`.

`zod` is already a dependency and is used for `merge-config.json` validation.

## 9. Decomposition into autospec issues

Anticipated child issues (Phase 3 will refine and file these):

1. **MergeResolver interface + claude-cli adapter + staging skeleton** — core types, `claude-cli.ts`, `staging.ts`, `.ai-sync/pending/` layout, `tools/merge-config.json` loader with defaults. Wire `tryAiMerge` into `sync-engine.ts:633-640` behind a feature flag (off by default). Tests for resolver contract + staging + sync-engine integration.
2. **codex-cli adapter** — mirrors #1's claude adapter; adapter test only.
3. **opencode-cli adapter** — mirrors #1's claude adapter; adapter test only.
4. **Per-type strategy dispatcher** — `strategies.ts`, markdown/JSON/YAML/unknown branches, post-validation, per-type config overrides. Adds `yaml` dep. Tests in `strategies.test.ts`.
5. **`ai-sync resolve` command** — list/diff/accept/reject subcommands following init.ts registration pattern. Manifest mutation. Tests under `tests/cli/commands/resolve.test.ts`.
6. **`ai-sync status` drift report (no AI)** — count local-only / remote-only / both-changed / staged-pending per env; `--verbose` lists names. Tests under `tests/cli/commands/status.test.ts`.
7. **`--summarize` AI drift summary** — reuse the configured resolver in a summarize-only mode; one summary call per env max. Tolerates resolver absence.
8. **Enable by default + docs + config docs** — flip the feature flag from #1 once #1-#7 are merged; update `README.md` and `CLAUDE.md` with the new commands and config; add a one-page reference for `tools/merge-config.json`.

Dependency edges:
- #4 depends on #1 (uses `MergeResolver` and `staging`).
- #2, #3 each depend on #1 (mirror its adapter pattern).
- #5, #6 depend on #1 (manifest contract + staged data).
- #7 depends on #6 (drift report surface) and #1 (resolver registry).
- #8 depends on #1–#7.

## 10. Open questions (none)

All four design hinges were resolved in the brainstorm:
- Runtime → pluggable, three adapters.
- Auto-apply vs. staged → staged default, `--auto-apply` flag.
- Scope of AI resolution → per-type strategies with JSON/YAML parse-validation.
- "Major changes" handling → drift report + `--summarize`.
