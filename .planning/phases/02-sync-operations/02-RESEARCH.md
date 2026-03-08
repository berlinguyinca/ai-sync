# Phase 2: Sync Operations - Research

**Researched:** 2026-03-08
**Domain:** Git-backed push/pull/status sync operations with backup safety
**Confidence:** HIGH

## Summary

Phase 2 builds on the Phase 1 foundation (manifest, scanner, path-rewriter, git repo init, CLI scaffold) to deliver the three core sync commands: `push`, `pull`, and `status`. The existing codebase provides file scanning, allowlist filtering, path rewriting, and basic git operations (init, add, commit). What Phase 2 must add is: (1) git remote management and network operations (fetch, pull, push), (2) a sync engine that orchestrates copying files between `~/.claude` and the sync repo in both directions, (3) a backup mechanism that snapshots current `~/.claude` state before applying remote changes, and (4) a status command that compares local state, repo state, and remote state to show drift.

The simple-git library already installed (v3.32.3) provides typed APIs for all required git operations: `pull()`, `push()`, `fetch()`, `status()`, `addRemote()`, `getRemotes()`, `stash()`, `diff()`, and `diffSummary()`. The `StatusResult` type includes `ahead`/`behind` counts, `current`/`tracking` branch info, and file-level change tracking -- exactly what the status command needs. The `PullResult` type includes `files`, `created`, `deleted`, and `summary` -- providing the data needed for clear pull reporting.

The primary risk is the pull direction: applying remote changes to `~/.claude` requires reading files from the sync repo, expanding `{{HOME}}` tokens in settings.json, and copying them to the right locations -- essentially the reverse of what `init` does. The backup requirement (SAFE-01) means this must be preceded by a timestamped snapshot. The secondary risk is error handling: every git network operation can fail (auth, network, conflicts), and SAFE-03 requires clear reporting for all outcomes.

**Primary recommendation:** Build a bidirectional sync engine module (`src/core/sync-engine.ts`) that orchestrates the copy-and-transform pipeline in both directions, with `push` and `pull` as its two entry points. Extend `src/git/repo.ts` with remote/network operations. Add a backup module (`src/core/backup.ts`) for pre-pull snapshots. Wire everything through three new CLI commands.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SYNC-03 | User can push local config changes to remote with one command | Sync engine push direction: scan ~/.claude, copy to repo with path rewriting, git add/commit/push. simple-git `push()` API returns typed `PushResult`. |
| SYNC-04 | User can pull remote changes and apply them to local ~/.claude with one command | Sync engine pull direction: git fetch/pull, read repo files, expand {{HOME}} tokens, copy to ~/.claude. simple-git `pull()` returns typed `PullResult` with files/created/deleted. |
| SYNC-05 | User can view sync status (local changes, remote drift, excluded items) | simple-git `status()` returns `StatusResult` with ahead/behind counts, modified/created/deleted lists. Compare scanner output against repo contents for local drift. |
| SAFE-01 | Tool backs up current ~/.claude state before applying remote changes | Backup module: copy all allowlisted files from ~/.claude to timestamped directory before pull. Use `~/.claude-sync/backups/YYYY-MM-DDTHH-MM-SS/` structure. |
| SAFE-03 | Tool reports sync health/errors clearly after each operation | Structured result types for each command. picocolors for colored output. Error catch with descriptive messages for git failures (auth, network, conflicts). |
</phase_requirements>

## Standard Stack

### Core (already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| simple-git | 3.32.3 | Git operations (push, pull, fetch, status, remote) | Already in use from Phase 1. Typed promise API wrapping native git. 6M+ weekly downloads. |
| commander | 14.x | CLI commands (push, pull, status) | Already scaffolded in Phase 1. Add three new subcommands. |
| picocolors | 1.x | Colored terminal output for status/error reporting | Already used in init command. Lightweight, fast. |

### Supporting (already installed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 4.x | Validate backup metadata, sync config | Optional: validate backup manifest structure |
| vitest | 4.x | Testing all new modules | Same test patterns as Phase 1 |

### No New Dependencies Needed

Phase 2 requires no new npm packages. All functionality is covered by simple-git (git operations), node:fs/promises (file copy/backup), node:path (path manipulation), node:crypto (file hashing for status comparison), and the existing CLI stack.

## Architecture Patterns

### Recommended New Files

```
src/
├── core/
│   ├── sync-engine.ts      # NEW: Orchestrates push and pull operations
│   └── backup.ts           # NEW: Pre-pull backup of ~/.claude state
├── git/
│   └── repo.ts             # EXTEND: Add push, pull, fetch, status, remote operations
├── cli/
│   └── commands/
│       ├── push.ts          # NEW: Push command handler
│       ├── pull.ts          # NEW: Pull command handler
│       └── status.ts        # NEW: Status command handler
tests/
├── core/
│   ├── sync-engine.test.ts  # NEW
│   └── backup.test.ts       # NEW
├── git/
│   └── repo.test.ts         # EXTEND
└── commands/
    ├── push.test.ts         # NEW
    ├── pull.test.ts         # NEW
    └── status.test.ts       # NEW
```

### Pattern 1: Bidirectional Sync Engine

**What:** A sync engine module with two primary operations: `pushToRemote()` and `pullFromRemote()`, each orchestrating the full pipeline.

**When to use:** Every push and pull command delegates to this engine.

**Push flow:**
```typescript
// Source: Architecture analysis of existing init.ts pattern
async function pushToRemote(options: SyncOptions): Promise<PushResult> {
  const { claudeDir, syncRepoDir, homeDir } = resolvePaths(options);

  // 1. Scan ~/.claude for current allowlisted files
  const localFiles = await scanDirectory(claudeDir);

  // 2. Copy files from ~/.claude -> sync repo (with path rewriting)
  for (const relativePath of localFiles) {
    let content = await fs.readFile(path.join(claudeDir, relativePath), "utf-8");
    if (path.basename(relativePath) === "settings.json") {
      content = rewritePathsForRepo(content, homeDir);
    }
    const destPath = path.join(syncRepoDir, relativePath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content);
  }

  // 3. Handle deleted files: files in repo but not in local scan
  const repoFiles = await scanDirectory(syncRepoDir); // scan repo too
  for (const repoFile of repoFiles) {
    if (!localFiles.includes(repoFile)) {
      await fs.rm(path.join(syncRepoDir, repoFile));
    }
  }

  // 4. Git add, commit, push
  const git = simpleGit(syncRepoDir);
  const status = await git.status();
  if (!status.isClean()) {
    await git.add(".");  // safe here because repo only contains allowlisted files
    await git.commit("sync: update claude config");
    await git.push("origin", "main");
  }

  return { filesUpdated: localFiles.length, pushed: !status.isClean() };
}
```

**Pull flow:**
```typescript
async function pullFromRemote(options: SyncOptions): Promise<PullResult> {
  const { claudeDir, syncRepoDir, homeDir } = resolvePaths(options);

  // 1. Create backup BEFORE any changes
  const backupDir = await createBackup(claudeDir);

  // 2. Git pull
  const git = simpleGit(syncRepoDir);
  const pullResult = await git.pull("origin", "main");

  // 3. Copy files from sync repo -> ~/.claude (with path expansion)
  const repoFiles = await scanDirectory(syncRepoDir);
  for (const relativePath of repoFiles) {
    let content = await fs.readFile(path.join(syncRepoDir, relativePath), "utf-8");
    if (path.basename(relativePath) === "settings.json") {
      content = expandPathsForLocal(content, homeDir);
    }
    const destPath = path.join(claudeDir, relativePath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content);
  }

  return { pullResult, backupDir, filesApplied: repoFiles.length };
}
```

### Pattern 2: Timestamped Backup

**What:** Before applying remote changes, copy all allowlisted files from `~/.claude` to a timestamped backup directory.

**When to use:** Every pull operation, before any files are modified.

**Example:**
```typescript
// Backup location: ~/.claude-sync/backups/2026-03-08T12-30-45/
async function createBackup(claudeDir: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(getSyncRepoDir(), "backups", timestamp);
  await fs.mkdir(backupDir, { recursive: true });

  const files = await scanDirectory(claudeDir);
  for (const relativePath of files) {
    const src = path.join(claudeDir, relativePath);
    const dest = path.join(backupDir, relativePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  return backupDir;
}
```

**Key design decision:** Backups should NOT be inside the git repo working tree. Store them in `~/.claude-sync/backups/` but add `backups/` to `.gitignore` so they never get committed. Alternatively, store at `~/.claude-backups/` completely outside the sync repo.

### Pattern 3: Status Comparison (Three-Way)

**What:** The status command compares three states: (1) current `~/.claude` files, (2) sync repo working tree, (3) remote tracking branch.

**When to use:** The `status` command.

**Example:**
```typescript
async function getSyncStatus(options: SyncOptions): Promise<SyncStatusResult> {
  const { claudeDir, syncRepoDir } = resolvePaths(options);
  const git = simpleGit(syncRepoDir);

  // Fetch to update remote tracking info (without merging)
  await git.fetch("origin");

  // Git status gives us repo-vs-remote comparison
  const gitStatus = await git.status();

  // Compare ~/.claude vs sync repo for local changes
  const localFiles = await scanDirectory(claudeDir);
  const localChanges: FileChange[] = [];

  for (const relativePath of localFiles) {
    const localContent = await fs.readFile(path.join(claudeDir, relativePath), "utf-8");
    const repoPath = path.join(syncRepoDir, relativePath);
    try {
      const repoContent = await fs.readFile(repoPath, "utf-8");
      if (localContent !== repoContent) {
        localChanges.push({ path: relativePath, type: "modified" });
      }
    } catch {
      localChanges.push({ path: relativePath, type: "added" });
    }
  }

  return {
    localModifications: localChanges,
    remoteDrift: { ahead: gitStatus.ahead, behind: gitStatus.behind },
    excludedCount: /* total files in ~/.claude minus allowlisted */,
    branch: gitStatus.current,
    tracking: gitStatus.tracking,
    isClean: localChanges.length === 0 && gitStatus.isClean(),
  };
}
```

### Anti-Patterns to Avoid

- **Using `git add -A` in the sync repo without understanding contents:** The sync repo should only contain allowlisted files, but `.gitignore` is needed for safety. Adding `backups/` to `.gitignore` is essential if backups are stored inside the sync repo directory.
- **Pushing without pulling first:** Always fetch/pull before push to avoid non-fast-forward rejections. The push command should pull first (or at minimum fetch to check for drift and warn the user).
- **Modifying `~/.claude` without backup:** Every pull must create a backup first. This is a hard requirement (SAFE-01), not an optimization.
- **Silently swallowing git errors:** SAFE-03 requires clear error reporting. Catch `GitResponseError` from simple-git and translate to user-friendly messages.
- **Comparing file contents with path rewriting applied inconsistently:** When comparing `~/.claude/settings.json` to the repo version, remember the repo has `{{HOME}}` tokens. Apply rewriting before comparison, or compare after expansion.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git push/pull/fetch | Shell exec of `git` commands with string parsing | `simpleGit().push()`, `.pull()`, `.fetch()` | Typed results, error handling, cross-platform |
| Git status parsing | Parse `git status --porcelain` output manually | `simpleGit().status()` -> `StatusResult` | Returns typed object with ahead/behind/files/isClean() |
| Remote management | Manual `.git/config` editing | `simpleGit().addRemote()`, `.getRemotes()` | Handles edge cases, returns typed results |
| File hashing | Manual crypto.createHash pipeline | `node:crypto` `createHash('sha256')` or just string comparison | String comparison is sufficient for text config files |
| Timestamp generation | Custom date formatting | `new Date().toISOString()` with character replacement | ISO format is unambiguous and sorts correctly |

**Key insight:** simple-git already provides typed wrappers for every git operation Phase 2 needs. The custom code should focus on the sync engine orchestration (file copying, path rewriting, backup), not git operations.

## Common Pitfalls

### Pitfall 1: Push Fails with Non-Fast-Forward

**What goes wrong:** User pushes but the remote has changes from another machine. `git push` rejects with "non-fast-forward" error.
**Why it happens:** User edited on machine B, pushed, then tries to push from machine A without pulling first.
**How to avoid:** The push command should fetch first and check `behind` count. If behind > 0, warn the user to pull first (or automatically pull-then-push). simple-git `status()` after `fetch()` gives `behind` count.
**Warning signs:** `GitResponseError` with message containing "rejected" or "non-fast-forward".

### Pitfall 2: Pull Overwrites Local Changes Without Backup

**What goes wrong:** Remote changes are applied to `~/.claude` and local-only changes are lost.
**Why it happens:** Backup step was skipped or failed silently.
**How to avoid:** Backup is the first step of pull, with a hard failure if backup cannot be created (e.g., disk full). Never proceed to apply if backup fails.
**Warning signs:** User reports "my local changes disappeared after pull".

### Pitfall 3: Remote Not Configured

**What goes wrong:** User runs `push` or `pull` but no remote is set up. simple-git throws an unhelpful error.
**Why it happens:** User ran `claude-sync init` (which creates a local repo) but never added a remote.
**How to avoid:** Check for remote existence before push/pull. Provide clear error: "No remote configured. Run: claude-sync remote add <url>".
**Warning signs:** `git push` fails with "No configured push destination".

### Pitfall 4: Status Command Confuses Repo State with Local State

**What goes wrong:** `git status` in the sync repo shows the repo is clean, but `~/.claude` has changes that haven't been copied into the repo yet.
**Why it happens:** The git status only reflects the sync repo, not the actual `~/.claude` directory. The status command must compare both.
**How to avoid:** Status must do TWO comparisons: (1) `~/.claude` vs sync repo (are there unsync'd local changes?), and (2) sync repo vs remote (is the remote ahead/behind?).
**Warning signs:** Status shows "up to date" but user knows they made changes.

### Pitfall 5: Path Rewriting Comparison Mismatch

**What goes wrong:** Status shows settings.json as "modified" even when nothing changed, because the local version has `/Users/wohlgemuth/` but the repo version has `{{HOME}}`.
**Why it happens:** Comparing raw file contents without accounting for path rewriting.
**How to avoid:** When comparing settings.json (or any file that undergoes path rewriting), apply `rewritePathsForRepo()` to the local content before comparing to the repo content.
**Warning signs:** settings.json always shows as modified in status output.

### Pitfall 6: Backup Directory Grows Without Bounds

**What goes wrong:** Every pull creates a backup. Over months, the backup directory accumulates hundreds of snapshots.
**Why it happens:** No cleanup/rotation policy.
**How to avoid:** Keep the last N backups (e.g., 10) and delete older ones. Or let the user manage cleanup manually in v1 and add auto-cleanup in v2. At minimum, warn about backup size.
**Warning signs:** Disk usage growing steadily from backup accumulation.

## Code Examples

### Extending git/repo.ts with Network Operations

```typescript
// Source: simple-git typings analysis (installed v3.32.3)
import { simpleGit } from "simple-git";
import type { StatusResult, PullResult, PushResult, FetchResult } from "simple-git";

export async function getStatus(repoPath: string): Promise<StatusResult> {
  return simpleGit(repoPath).status();
}

export async function pullFromRemote(
  repoPath: string,
  remote = "origin",
  branch = "main"
): Promise<PullResult> {
  return simpleGit(repoPath).pull(remote, branch);
}

export async function pushToRemote(
  repoPath: string,
  remote = "origin",
  branch = "main"
): Promise<PushResult> {
  return simpleGit(repoPath).push(remote, branch);
}

export async function fetchRemote(
  repoPath: string,
  remote = "origin"
): Promise<FetchResult> {
  return simpleGit(repoPath).fetch(remote);
}

export async function addRemote(
  repoPath: string,
  name: string,
  url: string
): Promise<void> {
  await simpleGit(repoPath).addRemote(name, url);
}

export async function getRemotes(
  repoPath: string
): Promise<{ name: string; refs: { fetch: string; push: string } }[]> {
  return simpleGit(repoPath).getRemotes(true);
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  const remotes = await simpleGit(repoPath).getRemotes();
  return remotes.length > 0;
}
```

### CLI Command Pattern (consistent with init.ts)

```typescript
// Source: Existing src/cli/commands/init.ts pattern
import type { Command } from "commander";
import pc from "picocolors";

export interface PushResult {
  filesUpdated: number;
  pushed: boolean;
  commitMessage?: string;
}

export async function handlePush(options: PushOptions): Promise<PushResult> {
  // Core logic extracted for testability (same pattern as handleInit)
  // ...
}

export function registerPushCommand(program: Command): void {
  program
    .command("push")
    .description("Push local ~/.claude changes to the remote repo")
    .option("--repo-path <path>", "Custom sync repo path", getSyncRepoDir())
    .action(async (opts) => {
      try {
        const result = await handlePush(opts);
        if (result.pushed) {
          console.log(pc.green(`Pushed ${result.filesUpdated} files to remote`));
        } else {
          console.log(pc.yellow("No changes to push -- already up to date"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(`Push failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
```

### Error Handling for Git Network Operations

```typescript
// Source: simple-git GitResponseError pattern
import { GitResponseError } from "simple-git";

async function safePush(repoPath: string): Promise<{ success: boolean; message: string }> {
  try {
    const result = await simpleGit(repoPath).push("origin", "main");
    return { success: true, message: `Pushed to ${result.repo}` };
  } catch (error) {
    if (error instanceof GitResponseError) {
      // Non-fast-forward, auth failure, network error
      if (error.message.includes("non-fast-forward")) {
        return { success: false, message: "Remote has changes. Run 'claude-sync pull' first." };
      }
      if (error.message.includes("Authentication") || error.message.includes("403")) {
        return { success: false, message: "Git authentication failed. Check your credentials." };
      }
      return { success: false, message: `Git error: ${error.message}` };
    }
    throw error; // Re-throw unexpected errors
  }
}
```

### StatusResult Usage for Status Command

```typescript
// Source: simple-git StatusResult type (installed v3.32.3)
interface SyncStatusDisplay {
  branch: string | null;
  tracking: string | null;
  localChanges: { path: string; type: "modified" | "added" | "deleted" }[];
  remoteAhead: number;
  remoteBehind: number;
  excludedCount: number;
  isClean: boolean;
}

// StatusResult fields used:
// - .current: current branch name (string | null)
// - .tracking: remote tracking branch (string | null)
// - .ahead: commits ahead of tracking (number)
// - .behind: commits behind tracking (number)
// - .modified: modified file paths (string[])
// - .created: created file paths (string[])
// - .deleted: deleted file paths (string[])
// - .isClean(): whether working tree is clean (boolean)
// - .files: detailed file status (FileStatusResult[])
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `simpleGit` default import | `{ simpleGit }` named import | simple-git v3 | Phase 1 already uses named import correctly |
| `CommitSummary` type | `CommitResult` type | simple-git v3 | Use `CommitResult` for commit return types |
| `MergeSummary` type | `MergeResult` type | simple-git v3 | Use `MergeResult` for merge return types |
| `git add -A` for staging | Explicit file paths with `.add(files)` | Project convention | Phase 1 established this pattern in repo.ts |

**Deprecated/outdated:**
- `CommitSummary`: Renamed to `CommitResult` in simple-git v3
- `MergeSummary`: Renamed to `MergeResult` in simple-git v3
- `BranchDeletionSummary`: Renamed to `BranchSingleDeleteResult`

## Open Questions

1. **Should push auto-pull first?**
   - What we know: Pushing without pulling first fails if remote has changes (non-fast-forward).
   - What's unclear: Should `claude-sync push` automatically pull first (like `git sync` pattern), or should it fail and tell the user to pull first (like standard git)?
   - Recommendation: For v1, fail with a clear message ("Remote has changes. Run claude-sync pull first."). Auto-pull-then-push adds conflict resolution complexity that belongs in the auto-sync daemon (v2), not manual commands.

2. **Where should backups be stored?**
   - What we know: Backups must not be committed to git. They should be easily discoverable.
   - What's unclear: Inside `~/.claude-sync/backups/` (with `.gitignore`) or outside at `~/.claude-backups/`?
   - Recommendation: `~/.claude-sync/backups/` with `.gitignore` entry. Keeps everything under one directory. The `.gitignore` was not created by Phase 1's init, so it must be added.

3. **Should scanDirectory be reused for repo scanning?**
   - What we know: `scanDirectory()` uses `isPathAllowed()` to filter files. It works on any directory, not just `~/.claude`.
   - What's unclear: When scanning the sync repo, should we use `isPathAllowed()` filtering or list all tracked files via git?
   - Recommendation: Reuse `scanDirectory()` for consistency. The repo should only contain allowlisted files anyway. But also handle `.gitattributes` and `.gitignore` which are in the repo but not in the allowlist -- exclude them from sync-back operations.

4. **How to handle files deleted locally?**
   - What we know: If a user deletes an agent file locally, push should remove it from the repo too.
   - What's unclear: How to detect deletions (file in repo but not in local scan)?
   - Recommendation: During push, scan both `~/.claude` and the sync repo. Files present in repo but absent from local are deletions -- `git rm` them. This is straightforward since both directories should only contain allowlisted files.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.x |
| Config file | `vitest.config.ts` (exists from Phase 1) |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SYNC-03 | Push copies local changes to repo and pushes to remote | integration | `npx vitest run tests/commands/push.test.ts -t "push" --reporter=verbose` | Wave 0 |
| SYNC-03 | Push rewrites paths in settings.json before committing | unit | `npx vitest run tests/core/sync-engine.test.ts -t "rewrite" --reporter=verbose` | Wave 0 |
| SYNC-03 | Push detects and stages deleted files | unit | `npx vitest run tests/core/sync-engine.test.ts -t "deleted" --reporter=verbose` | Wave 0 |
| SYNC-04 | Pull fetches remote changes and applies to ~/.claude | integration | `npx vitest run tests/commands/pull.test.ts -t "pull" --reporter=verbose` | Wave 0 |
| SYNC-04 | Pull expands {{HOME}} tokens in settings.json | unit | `npx vitest run tests/core/sync-engine.test.ts -t "expand" --reporter=verbose` | Wave 0 |
| SYNC-05 | Status shows local modifications vs repo | integration | `npx vitest run tests/commands/status.test.ts -t "local" --reporter=verbose` | Wave 0 |
| SYNC-05 | Status shows ahead/behind remote drift | integration | `npx vitest run tests/commands/status.test.ts -t "drift" --reporter=verbose` | Wave 0 |
| SYNC-05 | Status shows excluded item count | unit | `npx vitest run tests/commands/status.test.ts -t "excluded" --reporter=verbose` | Wave 0 |
| SAFE-01 | Backup is created before pull applies changes | integration | `npx vitest run tests/core/backup.test.ts -t "backup" --reporter=verbose` | Wave 0 |
| SAFE-01 | Backup contains all allowlisted files from ~/.claude | unit | `npx vitest run tests/core/backup.test.ts -t "allowlisted" --reporter=verbose` | Wave 0 |
| SAFE-03 | Push reports clear success message with file count | integration | `npx vitest run tests/commands/push.test.ts -t "success" --reporter=verbose` | Wave 0 |
| SAFE-03 | Pull reports clear success message with backup location | integration | `npx vitest run tests/commands/pull.test.ts -t "success" --reporter=verbose` | Wave 0 |
| SAFE-03 | Commands report clear error on missing remote | unit | `npx vitest run tests/core/sync-engine.test.ts -t "no remote" --reporter=verbose` | Wave 0 |
| SAFE-03 | Commands report clear error on network failure | unit | `npx vitest run tests/core/sync-engine.test.ts -t "network" --reporter=verbose` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `tests/core/sync-engine.test.ts` -- covers SYNC-03, SYNC-04, SAFE-03 (sync engine logic)
- [ ] `tests/core/backup.test.ts` -- covers SAFE-01 (backup creation and contents)
- [ ] `tests/commands/push.test.ts` -- covers SYNC-03, SAFE-03 (push command integration)
- [ ] `tests/commands/pull.test.ts` -- covers SYNC-04, SAFE-01, SAFE-03 (pull command integration)
- [ ] `tests/commands/status.test.ts` -- covers SYNC-05 (status command integration)
- [ ] `tests/git/repo.test.ts` -- EXTEND with tests for push, pull, fetch, remote operations

**Testing strategy note:** Git network operations (push/pull/fetch) require a remote. For integration tests, create two local git repos (one as "remote" using `--bare`), link them with `addRemote`, and test the full push/pull cycle locally. This is the established pattern for testing git sync tools without network access. Phase 1's test pattern of using `fs.mkdtemp` for real temp directories should be continued.

## Sources

### Primary (HIGH confidence)
- [simple-git npm package](https://www.npmjs.com/package/simple-git) - API surface, version 3.32.3
- [simple-git TypeScript definitions](https://github.com/steveukx/git-js/blob/main/simple-git/typings/simple-git.d.ts) - Method signatures for push, pull, fetch, status, addRemote, getRemotes
- [simple-git response types](https://github.com/steveukx/git-js/blob/main/simple-git/typings/response.d.ts) - StatusResult, PullResult, PushResult, FetchResult, DiffResult type definitions
- Installed `node_modules/simple-git/dist/typings/response.d.ts` - Verified type definitions from installed package
- Existing Phase 1 source code (src/core/, src/git/, src/cli/) - Established patterns for file operations, path rewriting, CLI commands, and testing

### Secondary (MEDIUM confidence)
- [simple-git GitHub repository](https://github.com/steveukx/git-js) - Usage examples, method chaining patterns
- Phase 1 architecture research (`.planning/research/ARCHITECTURE.md`) - Sync engine design, pull-before-push pattern, data flow diagrams
- Phase 1 pitfalls research (`.planning/research/PITFALLS.md`) - Conflict handling, backup strategies, error reporting patterns

### Tertiary (LOW confidence)
- Backup rotation strategy (keep last N) - Common pattern but optimal N not determined; recommend starting with no auto-cleanup in v1

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already installed and verified in Phase 1. No new dependencies.
- Architecture: HIGH - Sync engine follows established patterns from init.ts. simple-git API verified from installed type definitions.
- Pitfalls: HIGH - Derived from Phase 1 research findings and analysis of simple-git error types.

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- all dependencies are mature, no breaking changes expected)
