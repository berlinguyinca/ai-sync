# ai-sync

Git-backed sync tool for AI tool configurations (Codex, OpenCode, Pi) across machines.

## Commands

```bash
npm run build          # Build with tsup → dist/
npm test               # Run Vitest tests
npm run test:coverage  # Tests with coverage
npm run lint           # Biome lint
npm run format         # Biome format
npm run typecheck      # tsc --noEmit
```

### CLI surface

```bash
ai-sync init | push | pull [--auto-apply] | status [--verbose] [--summarize]
ai-sync bootstrap <repo-url> | update | install-skills | env | migrate
ai-sync resolve list | diff <path> | accept <path|--all> | reject <path|--all>
ai-sync fabric status [--json] | join [--yes]   # optional; off unless AI_SYNC_FABRIC_URL / tools/fabric.json
```

AI-assisted merge is configured via `tools/merge-config.json` in the sync repo
(see `docs/merge-config.md`). It is enabled by default; set `"enabled": false`
to opt out.

## Architecture

- `src/cli/` — Commander.js CLI entry point and commands
- `src/core/` — Sync engine, manifest (allowlist), path rewriter, backups, environments
- `src/core/merge/` — AI-assisted 3-way merge (config, adapters, strategies, staging, orchestrator)
- `src/core/fabric/` — optional fabric client/config (`docs/fabric.md`). Must stay inert unless configured: nothing outside `src/cli/commands/fabric.ts` and CLI registration may import it; token only from `AI_SYNC_FABRIC_TOKEN`, never logged or stored; no new runtime deps (built-in fetch)
- `src/git/` — Git wrapper (simple-git)
- `src/platform/` — Cross-platform path resolution
- `tests/` — Mirrors src/ structure, uses Vitest + memfs
- `skills/` — Slash command definitions (`.AGENTS.md` / `.opencode.md`)
- `tools/merge-config.json` (in the sync repo, not this repo) — AI-merge config; schema in `src/core/merge/config.ts`

## Conventions

- ESM only (`"type": "module"`), Node.js 22+, TypeScript strict mode
- Node built-ins use `node:` prefix: `import * as fs from "node:fs"`
- Biome for formatting/linting: tabs, 100 char line width
- Commands export `registerXCommand(program)` + `handleX(options)` pattern
- Async/await throughout; errors caught in handlers with `process.exitCode = 1`
- Terminal output via picocolors (green=success, red=error, yellow=warn, cyan=info)
- Tests use `describe`/`it`/`expect` with memfs for filesystem mocking
- Git operations use explicit file paths, never `git add .`
- Allowlist-based sync: only files in `DEFAULT_SYNC_TARGETS` / `PLUGIN_SYNC_PATTERNS` are synced
- Environments (`src/core/environment.ts`): claude, codex, opencode, antigravity, pi. Pi (`~/.pi/agent` or `PI_CODING_AGENT_DIR`) syncs only portable dirs; its ignore patterns (`auth.json`, `models.json`, ...) win over targets and match file names at any depth (see README, "Pi — Excluded"). Pi also sets the optional `Environment.followExternalSymlinks()` to false: the scanner skips symlinks resolving outside the config root (reported via `skippedLinks`); absent = follow (all other envs)
- Path rewriting: absolute paths ↔ `{{HOME}}` tokens for cross-platform portability

## Auto-merge authority for auto-implement PRs

Admin-merge `auto-implement` PRs (`gh pr merge <#> --admin --squash --delete-branch`) when:
(a) all required CI checks pass — slow optional checks like TeamCity may be pending and that's acceptable;
(b) the self-review subagent returned `LGTM`;
(c) the PR closes an `auto-implement` issue from a `feat/*` branch.

TDD non-negotiable. Real services in tests (real fs in tmpdir + simple-git per existing `tests/core/sync-engine.test.ts` pattern), no DB mocks. Conventional commits. No force-push. No hook bypass.

## Testing safety

Tests build real environments (`~/.claude`, `~/.pi`, ...) and a pull deletes local files absent from the repo, so running them against a real HOME can wipe a user's config (this happened on 2026-10-30).
`tests/setup/hermetic-env.ts` (vitest `setupFiles`) points HOME, USERPROFILE, XDG_CONFIG_HOME, CODEX_HOME and PI_CODING_AGENT_DIR at a temp dir, replaces global git config, and aborts the run if `os.homedir()` is the real home. Do not remove it. Still prefer `HOME=$(mktemp -d) npx vitest run`.
