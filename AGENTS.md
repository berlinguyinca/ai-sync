# ai-sync

Git-backed sync tool for AI tool configurations (Codex, OpenCode) across machines.

## Commands

```bash
npm run build          # Build with tsup → dist/
npm test               # Run Vitest tests
npm run test:coverage  # Tests with coverage
npm run lint           # Biome lint
npm run format         # Biome format
npm run typecheck      # tsc --noEmit
```

## Architecture

- `src/cli/` — Commander.js CLI entry point and commands
- `src/core/` — Sync engine, manifest (allowlist), path rewriter, backups, environments
- `src/git/` — Git wrapper (simple-git)
- `src/platform/` — Cross-platform path resolution
- `tests/` — Mirrors src/ structure, uses Vitest + memfs
- `skills/` — Slash command definitions (`.AGENTS.md` / `.opencode.md`)

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

## Auto-merge authority for auto-implement PRs

Admin-merge `auto-implement` PRs (`gh pr merge <#> --admin --squash --delete-branch`) when:
(a) all required CI checks pass — slow optional checks like TeamCity may be pending and that's acceptable;
(b) the self-review subagent returned `LGTM`;
(c) the PR closes an `auto-implement` issue from a `feat/*` branch.

TDD non-negotiable. Real services in tests (real fs in tmpdir + simple-git per existing `tests/core/sync-engine.test.ts` pattern), no DB mocks. Conventional commits. No force-push. No hook bypass.
