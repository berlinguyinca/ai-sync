# Roadmap: Claude Config Sync

## Overview

This roadmap delivers a Git-backed CLI tool that synchronizes ~/.claude across macOS, Linux, and Windows/WSL. The work flows from foundation (what to sync and how to make it portable) through sync operations (push, pull, status with safety guarantees) to cross-platform support and new machine bootstrap. Every phase builds on the previous one, and every phase delivers a verifiable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Project scaffolding, init command, default manifest, and path portability
- [ ] **Phase 2: Sync Operations** - Push, pull, status commands with backup safety and error reporting
- [ ] **Phase 3: Cross-Platform and Bootstrap** - macOS/Linux/WSL support and one-command new machine setup

## Phase Details

### Phase 1: Foundation
**Goal**: User can initialize a sync repo from their existing ~/.claude config, with an opinionated manifest that selects the right files and rewrites paths for portability
**Depends on**: Nothing (first phase)
**Requirements**: SYNC-01, SYNC-02, SAFE-02
**Success Criteria** (what must be TRUE):
  1. User can run a single command to create a git-backed sync repo from their existing ~/.claude directory
  2. The sync repo contains only user-authored config files (skills, plugins, hooks, CLAUDE.md, settings) and excludes all ephemeral data (projects/, debug/, telemetry/, history)
  3. Absolute paths in settings.json are rewritten to portable tokens (e.g., {{HOME}}) in the repo, so the repo content is machine-independent
  4. A .gitattributes file enforcing LF line endings is present as the first commit artifact
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md -- Scaffold project and implement core modules (manifest, scanner, path-rewriter)
- [x] 01-02-PLAN.md -- Git wrapper, CLI entry point, init command, and integration tests

### Phase 2: Sync Operations
**Goal**: User can push local changes, pull remote changes, and view sync status -- with automatic backup and clear error reporting on every operation
**Depends on**: Phase 1
**Requirements**: SYNC-03, SYNC-04, SYNC-05, SAFE-01, SAFE-03
**Success Criteria** (what must be TRUE):
  1. User can push local ~/.claude changes to the remote repo with one command
  2. User can pull remote changes and apply them to local ~/.claude with one command
  3. Before applying remote changes, the tool creates a backup of the current ~/.claude state that can be restored
  4. User can view sync status showing local modifications, remote drift, and which items are excluded by the manifest
  5. Every sync operation (push, pull, status) reports clear success/failure messages including any errors encountered
**Plans**: 2 plans

Plans:
- [ ] 02-01-PLAN.md -- Core sync infrastructure: extend git/repo.ts, backup module, bidirectional sync engine
- [ ] 02-02-PLAN.md -- Push, pull, status CLI commands and CLI wiring

### Phase 3: Cross-Platform and Bootstrap
**Goal**: The tool works identically on macOS, Linux, and Windows/WSL, and a user can set up a new machine from an existing remote repo with one command
**Depends on**: Phase 2
**Requirements**: SETUP-01, SETUP-02
**Success Criteria** (what must be TRUE):
  1. User can bootstrap a brand new machine by running a single command with a repo URL, and end up with a fully populated ~/.claude directory
  2. The tool produces identical behavior on macOS, Linux, and Windows/WSL -- same commands, same output, same file results
  3. Settings.json path tokens expand correctly to the local platform's home directory and path separators
  4. Hook scripts synced across platforms execute without line-ending issues
**Plans**: 2 plans

Plans:
- [x] 03-01-PLAN.md -- Cross-platform path normalization (normalizePath utility, scanner fix, path-rewriter enhancement)
- [ ] 03-02-PLAN.md -- Bootstrap command (clone remote repo, apply files to ~/.claude, backup existing config)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 2/2 | Complete | 2026-03-08 |
| 2. Sync Operations | 2/2 | Complete | 2026-03-08 |
| 3. Cross-Platform and Bootstrap | 1/2 | In progress | - |
