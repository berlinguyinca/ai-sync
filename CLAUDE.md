# ai-sync

Git-backed sync tool for AI tool configurations (Claude Code, OpenCode) across machines.

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
```

AI-assisted merge is configured via `tools/merge-config.json` in the sync repo
(see `docs/merge-config.md`). It is enabled by default; set `"enabled": false`
to opt out.

## Architecture

- `src/cli/` — Commander.js CLI entry point and commands
- `src/core/` — Sync engine, manifest (allowlist), path rewriter, backups, environments
- `src/core/merge/` — AI-assisted 3-way merge (config, adapters, strategies, staging, orchestrator)
- `src/git/` — Git wrapper (simple-git)
- `src/platform/` — Cross-platform path resolution
- `tests/` — Mirrors src/ structure, uses Vitest + memfs
- `skills/` — Slash command definitions (`.claude.md` / `.opencode.md`)
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
- Path rewriting: absolute paths ↔ `{{HOME}}` tokens for cross-platform portability
