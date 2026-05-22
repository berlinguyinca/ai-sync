# ai-sync

Git-backed sync for AI tool configuration across macOS, Linux, and Windows/WSL.

Keeps your skills, commands, hooks, settings, and tool config identical on every machine. Supports **Claude Code** (`~/.claude`), **Codex** (`~/.codex` or `$CODEX_HOME`), and **OpenCode** (`~/.config/opencode/`).

## Why

`~/.claude` is 1.6GB but only ~15MB is your actual config. Generic dotfile managers (chezmoi, yadm) don't know which files matter. ai-sync ships with an opinionated allowlist, rewrites hardcoded paths for cross-platform portability, and backs up your config before every pull.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/berlinguyinca/ai-sync/main/install.sh | bash
```

The installer will:
1. Clone, build, and link the `ai-sync` binary
2. Ask which environments to sync (Claude Code, Codex, OpenCode, or any combination)
3. Ask for a GitHub repo name (default: `ai-config`) and visibility
4. Create the repo via `gh`, run `ai-sync init`, and push your config

Run it again to update an existing installation.

Requires: git, [GitHub CLI](https://cli.github.com/) (`gh`) for automatic repo creation. Node.js 22+ is installed automatically if missing (via fnm, nvm, Homebrew, apt, yum, or direct binary download).

### Manual

```bash
git clone https://github.com/berlinguyinca/ai-sync.git
cd ai-sync
npm install
npm run build
npm link

ai-sync init
cd ~/.ai-sync && git remote add origin git@github.com:you/ai-config.git
ai-sync push
```

## Quick Start

### First machine (where your config already lives)

The one-liner installer handles everything — init, repo creation, and first push.
If you installed manually, see the manual steps above.

### Every other machine

```bash
# One command — clones the repo and applies config to local directories
ai-sync bootstrap git@github.com:you/ai-config.git
```

Done. Your config is now identical across machines.

### Keeping in sync

```bash
# After changing config on any machine
ai-sync push

# On other machines, pull the changes
ai-sync pull     # backs up current state first

# Check what's changed
ai-sync status
```

### Adding Codex support

By default, ai-sync only syncs Claude Code. To also sync Codex (`~/.codex` or `$CODEX_HOME`):

```bash
# 1. Enable the Codex environment
ai-sync env enable codex

# 2. Push to include portable Codex config in the sync repo
ai-sync push

# 3. On other machines, enable Codex there too
ai-sync env enable codex
ai-sync pull
```

Codex sync is intentionally narrow: it includes portable user config such as `config.toml` and saved automations, while excluding machine-local auth, session history, sqlite state, caches, and logs.

### Adding OpenCode support

By default, ai-sync only syncs Claude Code. To also sync OpenCode (`~/.config/opencode/`):

```bash
# 1. Enable the OpenCode environment
ai-sync env enable opencode

# 2. Push to include OpenCode config in the sync repo
ai-sync push

# 3. On other machines, enable OpenCode there too
ai-sync env enable opencode
ai-sync pull
```

Claude Code, Codex, and OpenCode configs are kept strictly isolated in per-environment subdirectories and are never mixed.

## Migration

### Migrating from claude-sync to ai-sync

If you previously used `claude-sync`, the installer automatically handles the rename:

- Renames `~/.claude-sync-cli` → `~/.ai-sync-cli`
- Renames `~/.claude-sync` → `~/.ai-sync`
- Removes old `claude-sync` symlinks

Just re-run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/berlinguyinca/ai-sync/main/install.sh | bash
```

### Migrating from v1 (flat) to v2 (multi-environment)

If you set up ai-sync before multi-environment support was added, your sync repo uses the v1 flat format where all files sit at the root. The v2 format organizes files into per-environment subdirectories (`claude/`, `codex/`, `opencode/`).

**Check your current format:**

```bash
# If this file exists, you're already on v2
cat ~/.ai-sync/.sync-version
```

**Migrate to v2:**

```bash
# Moves all root-level files into claude/ and writes .sync-version
ai-sync migrate
```

This is safe — it:
1. Verifies the repo is clean (no uncommitted changes)
2. Moves all allowlisted files into a `claude/` subdirectory
3. Writes `.sync-version` with content `2`
4. Commits and pushes the change

After migrating, pull on your other machines so they pick up the new structure:

```bash
# On each other machine
ai-sync pull
```

**Important:** All machines should run the same version of ai-sync. Update all machines before or after migrating:

```bash
ai-sync update
```

### Migrating other machines after format change

If you migrate on one machine, other machines need to update and pull:

```bash
# 1. Update ai-sync to the latest version
ai-sync update

# 2. Pull the migrated repo structure
ai-sync pull
```

If a machine was set up with an older ai-sync that doesn't understand v2, re-run the installer to update:

```bash
curl -fsSL https://raw.githubusercontent.com/berlinguyinca/ai-sync/main/install.sh | bash
```

## Commands

### `ai-sync init`

Creates a git-backed sync repo at `~/.ai-sync` from your existing config directories.

- Scans enabled environments through their allowlist manifests
- Copies only config files (skips ephemeral data)
- Rewrites absolute paths in `settings.json`, `opencode.json`, and `config.toml` to portable `{{HOME}}` tokens
- Creates `.gitattributes` enforcing LF line endings
- Makes an initial commit

```bash
ai-sync init                    # default location ~/.ai-sync
ai-sync init --repo-path ~/my-sync  # custom location
ai-sync init --force            # re-initialize existing repo
```

### `ai-sync push`

Scans config directories for changes, copies updated files to the sync repo with path rewriting, commits, and pushes to the remote.

```bash
ai-sync push
ai-sync push -v               # show detailed file changes
```

### `ai-sync pull`

Fetches remote changes and applies them to local config directories. Always
creates a timestamped backup first. On 3-way merge conflicts, ai-sync uses the
[AI-assisted merge](#ai-assisted-merge) flow.

```bash
ai-sync pull
ai-sync pull -v               # show detailed file changes
ai-sync pull --auto-apply     # apply AI merges directly instead of staging them
```

### `ai-sync status`

Shows local modifications, remote drift, and excluded file count. With
`--summarize`, asks the configured AI resolver for a natural-language summary
of the drift (see [AI-assisted merge](#ai-assisted-merge) below).

```bash
ai-sync status
ai-sync status -v             # include branch, tracking info, synced file count, pending merges
ai-sync status --summarize    # AI-generated summary of local/remote drift
```

### `ai-sync resolve`

Manage pending AI merges produced by `ai-sync pull`. See
[AI-assisted merge](#ai-assisted-merge) below.

```bash
ai-sync resolve list                # list pending merges
ai-sync resolve diff <path>         # show the staged merge vs the live file
ai-sync resolve accept <path>       # apply a staged merge
ai-sync resolve accept --all        # apply every pending merge
ai-sync resolve reject <path>       # discard a staged merge
ai-sync resolve reject --all        # discard every pending merge
```

### `ai-sync bootstrap <repo-url>`

Sets up a new machine from an existing remote sync repo. Clones the repo, applies files to config directories with path expansion, backs up any existing config, and installs skills.

```bash
ai-sync bootstrap git@github.com:you/ai-config.git
ai-sync bootstrap https://github.com/you/ai-config.git
ai-sync bootstrap <url> --force   # re-clone if sync repo exists
```

### `ai-sync update`

Checks for and applies tool updates. ai-sync also checks automatically once every 24 hours on startup (disable with `--no-update-check`).

```bash
ai-sync update
ai-sync update --force        # check even if checked recently
```

### `ai-sync install-skills`

Installs slash commands (like `/sync`) into config directories for all enabled environments. This runs automatically during `init` and `bootstrap`, but you can run it manually after updating.

```bash
ai-sync install-skills
```

### `ai-sync env`

Manage which tool environments are synced.

```bash
ai-sync env list              # show all environments and their status
ai-sync env enable codex      # enable Codex syncing
ai-sync env enable opencode   # enable OpenCode syncing
ai-sync env disable codex     # disable Codex syncing
ai-sync env disable opencode  # disable OpenCode syncing
```

### `ai-sync migrate`

Migrates a v1 (flat, Claude-only) sync repo to v2 (subdirectory, multi-environment) format. This moves all root-level files into a `claude/` subdirectory and writes a `.sync-version` marker.

```bash
ai-sync migrate
```

### The `/sync` skill

After installation, you can type `/sync` inside Claude Code or OpenCode to pull, push, and check status in one step — no need to leave the conversation.

Each tool gets its own version of the skill — they are not interchangeable. Skill files use a naming convention to target specific environments:

| Skill file | Installed as | Target |
|------------|-------------|--------|
| `sync.claude.md` | `sync.md` | Claude Code only |
| `sync.opencode.md` | `sync.md` | OpenCode only |
| `utils.md` | `utils.md` | All environments |

The convention is `<name>.<envId>.md` for environment-specific skills, or `<name>.md` for skills shared across all environments.

### Global options

```bash
ai-sync --no-update-check <command>   # skip the auto-update check
ai-sync --version                      # show version
ai-sync --help                         # show help
```

## AI-assisted merge

When `ai-sync pull` finds that the same file was modified locally and remotely,
it can ask a local AI CLI (`claude`, `codex`, or `opencode`) to produce a
3-way merge instead of dropping back to keep-local. The feature is
**enabled by default**.

By default, merges are staged under `<syncRepoDir>/.ai-sync/pending/<env>/<path>`
so you can review them with `ai-sync resolve` before applying. Set
`autoApply: true` (or pass `ai-sync pull --auto-apply`) to skip staging.

### Configuration: `tools/merge-config.json`

Drop a `tools/merge-config.json` at the root of your sync repo to tune the
behavior. All fields are optional.

```jsonc
{
  "enabled": true,            // master switch — set to false to disable AI merge
  "resolver": "claude",       // "claude" | "codex" | "opencode"
  "autoApply": false,         // false = stage under .ai-sync/pending/, true = write through
  "timeoutSeconds": 60,       // per-file resolver timeout
  "perType": {
    "*.md":   "ai-freeform",
    "*.json": "ai-validated",
    "*.yaml": "ai-validated",
    "*.yml":  "ai-validated",
    "*.lock": "keep-local",
    "*":      "keep-local"
  }
}
```

To disable AI-merge entirely, write:

```jsonc
{ "enabled": false }
```

See [`docs/merge-config.md`](docs/merge-config.md) for the full schema reference.

### Reviewing pending merges

```bash
ai-sync resolve list                # show pending merges
ai-sync resolve diff <path>         # diff the staged merge against the live file
ai-sync resolve accept <path>       # apply one staged merge
ai-sync resolve accept --all        # apply all pending merges
ai-sync resolve reject <path>       # discard one staged merge
ai-sync resolve reject --all        # discard all pending merges
```

`ai-sync status --verbose` also lists pending merges, and
`ai-sync status --summarize` asks the configured resolver for a natural-language
description of what differs between local, remote, and base.

## Environments

ai-sync supports multiple AI tool environments:

| Environment | Config Dir | Skills Dir | Path Rewrite |
|-------------|-----------|------------|-------------|
| Claude Code | `~/.claude` | `commands/` | `settings.json` |
| Codex | `~/.codex` or `$CODEX_HOME` | n/a | `config.toml` |
| OpenCode | `~/.config/opencode/` | `command/` | `opencode.json` |

By default, only Claude Code is enabled. Use `ai-sync env enable codex` or `ai-sync env enable opencode` to add more environments.

### Repo structure

**v1 (legacy, flat):**
```
~/.ai-sync/
├── CLAUDE.md
├── settings.json
├── commands/
└── ...
```

**v2 (multi-environment):**
```
~/.ai-sync/
├── .sync-version          # contains "2"
├── claude/
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── commands/
│   └── ...
├── codex/
│   ├── config.toml
│   └── automations/
└── opencode/
    ├── opencode.json
    ├── settings.json
    ├── command/
    └── ...
```

Use `ai-sync migrate` to move from v1 to v2 format.

## What syncs (and what doesn't)

### Claude Code — Synced (~15MB)

| Path | What it is |
|------|-----------|
| `CLAUDE.md` | Global instructions and preferences |
| `settings.json` | Permissions, hooks, effort level (paths auto-rewritten) |
| `commands/` | Custom slash commands |
| `agents/` | Agent definitions |
| `hooks/` | Hook scripts |
| `get-shit-done/` | GSD framework |
| `package.json` | Dependencies |
| `gsd-file-manifest.json` | Framework state |
| `plugins/blocklist.json` | Plugin blocklist |
| `plugins/known_marketplaces.json` | Marketplace registry |
| `plugins/marketplaces/` | Marketplace configs |

### OpenCode — Synced

| Path | What it is |
|------|-----------|
| `opencode.json` | Main config (paths auto-rewritten) |
| `settings.json` | Settings |
| `agents/` | Agent definitions |
| `command/` | Custom slash commands (singular!) |
| `hooks/` | Hook scripts |
| `get-shit-done/` | GSD framework |
| `package.json` | Dependencies |
| `gsd-file-manifest.json` | Framework state |

### Codex — Synced

| Path | What it is |
|------|-----------|
| `config.toml` | Main Codex configuration (paths auto-rewritten) |
| `automations/` | Saved recurring tasks and automation definitions |

### Codex — Excluded (machine-local)

`auth.json`, `.codex-global-state.json`, `sessions/`, `session_index.jsonl`, `logs*.sqlite`, `state*.sqlite`, `sqlite/`, `tmp/`, `shell_snapshots/`, `models_cache.json`, `vendor_imports/`

### Claude Code — Excluded (machine-local — ~1.6GB)

`projects/`, `history.jsonl`, `debug/`, `telemetry/`, `session-env/`, `shell-snapshots/`, `statsig/`, `file-history/`, `todos/`, `plans/`, `paste-cache/`, `ide/`, `cache/`, `backups/`, `downloads/`, `tasks/`, `plugins/install-counts-cache.json`

These are session data, caches, and logs that regenerate automatically and would cause constant merge conflicts.

## Path portability

`settings.json`, `opencode.json`, and `config.toml` can contain absolute paths that break on other machines. ai-sync handles this transparently:

- **On push/init:** Rewrites `/Users/you` to `{{HOME}}` in the sync repo
- **On pull/bootstrap:** Expands `{{HOME}}` back to the local machine's home directory
- **Windows support:** Handles both forward-slash and backslash path variants, including JSON-escaped `\\` sequences

You never see the tokens — they exist only in the git repo.

## Safety

- **Backup before pull/bootstrap:** Current config state is saved to a timestamped directory in `~/.ai-sync-backups/` before any destructive operation
- **Line endings:** `.gitattributes` enforces LF everywhere — hook scripts won't break when synced from macOS to Linux
- **Clear errors:** Every operation reports user-friendly success/failure messages. No raw stack traces for expected errors (missing remote, auth failure, etc.)
- **No secrets:** The allowlist excludes everything except config files. No credentials, tokens, or session data are synced.

## How it works

```
~/.claude (1.6GB)                    ~/.ai-sync (git repo)
├── CLAUDE.md          ──sync──►     ├── .sync-version
├── settings.json      ──rewrite──►  ├── claude/
├── commands/          ──sync──►     │   ├── CLAUDE.md
├── agents/            ──sync──►     │   ├── settings.json ({{HOME}} tokens)
├── hooks/             ──sync──►     │   ├── commands/
├── projects/          ✗ excluded    │   └── ...
├── history.jsonl      ✗ excluded    ├── codex/
├── debug/             ✗ excluded    │   ├── config.toml ({{HOME}} tokens)
├── telemetry/         ✗ excluded    │   └── automations/
├── sessions/          ✗ excluded    ├── opencode/
│                                   │   ├── opencode.json ({{HOME}} tokens)
│                                   │   ├── command/
└── ... (16 more)      ✗ excluded    │   └── ...
                                     ├── .gitattributes
                                     └── .git/ → remote
```

The sync repo is a standard git repository. You can inspect it, view history, and resolve conflicts with normal git tools.

## Development

```bash
git clone https://github.com/berlinguyinca/ai-sync.git
cd ai-sync
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Build
npm run build
```

### Project structure

```
src/
├── cli/
│   ├── index.ts              # Commander.js entry point
│   ├── format.ts             # Colored output formatting
│   └── commands/
│       ├── init.ts           # ai-sync init
│       ├── push.ts           # ai-sync push
│       ├── pull.ts           # ai-sync pull
│       ├── status.ts         # ai-sync status
│       ├── bootstrap.ts      # ai-sync bootstrap
│       ├── update.ts         # ai-sync update
│       ├── install-skills.ts # ai-sync install-skills
│       ├── env.ts            # ai-sync env list|enable|disable
│       └── migrate.ts        # ai-sync migrate
├── core/
│   ├── manifest.ts           # Allowlist of sync targets
│   ├── scanner.ts            # Directory scanner filtered by manifest
│   ├── path-rewriter.ts      # {{HOME}} token rewriting
│   ├── backup.ts             # Timestamped backup creation
│   ├── sync-engine.ts        # Push/pull/status orchestration
│   ├── updater.ts            # Auto-update mechanism
│   ├── skills.ts             # Skill installation (/sync command)
│   ├── environment.ts        # Environment definitions (Claude, OpenCode)
│   ├── env-config.ts         # Per-machine environment preferences
│   ├── env-helpers.ts        # Shared helpers (allowlist, path rewrite checks)
│   ├── migration.ts          # v1→v2 repo migration
│   └── merge/                # AI-assisted 3-way merge (adapters, strategies, staging)
├── git/
│   └── repo.ts               # Git operations wrapper (simple-git)
├── platform/
│   └── paths.ts              # Cross-platform path resolution
└── index.ts                  # Library exports

skills/
├── sync.claude.md            # /sync for Claude Code (installs as sync.md)
└── sync.opencode.md          # /sync for OpenCode (installs as sync.md)
```

## License

MIT
