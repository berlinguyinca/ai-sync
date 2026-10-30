# `tools/sync-config.json` reference

`tools/sync-config.json` at the root of the sync repo controls what ai-sync
syncs. If the file is absent, defaults apply, so existing setups are unchanged.
It is loaded the same way as `tools/merge-config.json`.

## Schema

| Field     | Type      | Default | Description                                                                 |
| --------- | --------- | ------- | --------------------------------------------------------------------------- |
| `plugins` | `boolean` | `true`  | Sync Claude Code plugin files (`plugins/marketplaces`, `plugins/cache`, `plugins/data`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/blocklist.json`). |
| `verify`  | `boolean` | `false` | After a non-dry-run `ai-sync pull`, run the read-only verifier for each pulled environment and exit non-zero if it finds errors. See [`verify.md`](verify.md). |

Unknown keys are rejected, so a typo does not silently leave plugins syncing.

## Opting out of plugin sync

```json
{ "plugins": false }
```

Commit and push the file. Plugin caches are machine-managed (each machine
installs its own), so syncing them writes thousands of stale files over a
machine's own caches, and a repo without them would make `pull` delete local
ones.

With `plugins` set to `false` the claude environment's plugin patterns are
treated as empty in every code path (push, pull, status, drift, backup,
bootstrap, init, link; v1 and v2 repos):

- `push` never copies anything under `plugins/` into the repo.
- `pull` never writes, overwrites or deletes anything under the local
  `plugins/` directory, even if the repo still contains plugin files or
  removed them.
- Backups taken before a pull skip `plugins/`.
- `link` does not symlink plugin directories.
- `ai-sync status` prints `plugins: not synced (tools/sync-config.json)`.

Files already committed under `<env>/plugins/` stay in the repo; remove them
with git if you no longer want them there.

On `pull`, plugins are synced only if both the config before and after the
pull enable them. Disabling takes effect immediately on the machine that
pulls the change; re-enabling takes effect on the following pull.

## Verifying after pull

```json
{ "verify": true }
```

With `verify` set, `ai-sync pull` checks that the pulled configuration loads
(see [`verify.md`](verify.md)). On errors it prints them, prints where the
pre-pull backup is, and exits 1. It never rolls back automatically. `--dry-run`
never verifies.

## Errors

A malformed or invalid file is an error, never a silent fallback to
`plugins: true`. The message names the file and the problem (for example
`unknown key(s) "plugin"`); fix the JSON or delete the file to restore
defaults.
