# Requirements: Claude Config Sync

**Defined:** 2026-03-08
**Core Value:** Changes to the Claude environment on any machine automatically propagate to all other machines -- zero manual sync effort.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Sync

- [x] **SYNC-01**: User can initialize a git repo from existing ~/.claude config with one command
- [x] **SYNC-02**: Tool ships with Claude-aware default manifest (allowlist of ~8 sync targets, excludes ~18 ephemeral items)
- [x] **SYNC-03**: User can push local config changes to remote with one command
- [x] **SYNC-04**: User can pull remote changes and apply them to local ~/.claude with one command
- [x] **SYNC-05**: User can view sync status (local changes, remote drift, excluded items)

### Setup

- [ ] **SETUP-01**: User can bootstrap a new machine from an existing remote repo with one command
- [ ] **SETUP-02**: Tool works identically on macOS, Linux, and Windows/WSL

### Safety

- [x] **SAFE-01**: Tool backs up current ~/.claude state before applying remote changes
- [x] **SAFE-02**: Tool rewrites absolute paths in settings.json to portable tokens (~/.claude/...) in the repo, expands on apply
- [x] **SAFE-03**: Tool reports sync health/errors clearly after each operation

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Automation

- **AUTO-01**: Background daemon watches ~/.claude for changes and syncs automatically
- **AUTO-02**: Daemon integrates with OS service managers (launchd, systemd, Task Scheduler)
- **AUTO-03**: Debounced file watching batches rapid changes before syncing

### Enhanced UX

- **UX-01**: Dry-run / preview mode shows what would change before applying
- **UX-02**: Conflict detection with clear resolution UX (show diff, pick version)
- **UX-03**: Smart auto-merge for non-conflicting additive changes (new skills on different machines)

### Integration

- **INTG-01**: Hook into Claude Code session start/end for auto-pull/push
- **INTG-02**: Sync validation / integrity checks before applying (JSON schema validation)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-machine config overrides / templates | All machines are identical per user requirement |
| Secret/credential encryption | No secrets in ~/.claude per user confirmation |
| LLM-powered semantic merge | Adds cost, latency, non-determinism for no benefit on config files |
| GUI / web dashboard | CLI-only tool -- best sync tool is invisible |
| Session/history sync | Large, append-only, machine-specific files (history.jsonl, projects/) |
| Plugin marketplace state sync | Machine-specific caches that regenerate automatically |
| Multi-repo support | Single remote covers the use case |
| Migration from chezmoi/claude-brain | Users can manually export; not worth building tooling |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SYNC-01 | Phase 1 | Complete |
| SYNC-02 | Phase 1 | Complete |
| SYNC-03 | Phase 2 | Complete |
| SYNC-04 | Phase 2 | Complete |
| SYNC-05 | Phase 2 | Complete |
| SETUP-01 | Phase 3 | Pending |
| SETUP-02 | Phase 3 | Pending |
| SAFE-01 | Phase 2 | Complete |
| SAFE-02 | Phase 1 | Complete |
| SAFE-03 | Phase 2 | Complete |

**Coverage:**
- v1 requirements: 10 total
- Mapped to phases: 10
- Unmapped: 0

---
*Requirements defined: 2026-03-08*
*Last updated: 2026-03-08 after plan 01-01 completion*
