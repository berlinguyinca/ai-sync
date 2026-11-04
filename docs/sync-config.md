# `tools/sync-config.json` reference

`tools/sync-config.json` at the root of the sync repo controls what ai-sync
syncs. If the file is absent, defaults apply, so existing setups are unchanged.
It is loaded the same way as `tools/merge-config.json`.

## Schema

| Field     | Type      | Default | Description                                                                 |
| --------- | --------- | ------- | --------------------------------------------------------------------------- |
| `plugins` | `boolean` | `true`  | Sync Claude Code plugin files (`plugins/marketplaces`, `plugins/cache`, `plugins/data`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, `plugins/blocklist.json`). |
| `verify`  | `boolean` | `false` | After a non-dry-run `ai-sync pull`, run the read-only verifier for each pulled environment and exit non-zero if it finds errors. See [`verify.md`](verify.md). |

| `exclude` | `string[]` | (none) | Glob patterns for paths that are never synced. See [Excluding paths](#excluding-paths). |

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

## Excluding paths

Use `exclude` when another tool owns files under the config dir (for example
skills that a tool's own installer puts in `~/.claude/skills/`):

```json
{ "exclude": ["skills/autospec*"] }
```

Patterns are relative to each environment's config root (`~/.claude` for the
claude environment), **not** to the sync repo, so write `skills/autospec*`, not
`claude/skills/autospec*`. They use the same glob rules as the built-in ignore
patterns: case-insensitive, `*` matches within one path segment only, and a
pattern containing `/` is anchored at the root.

- `skills/autospec*` excludes every skill directory starting with `autospec`
  and everything inside it (a pattern naming a path also covers its children).
  `skills/autospec*/` is equivalent; a leading `/` is an explicit root anchor.
- A pattern without `/` (`secret.json`, `*.bak*`) matches a file or directory of
  that name at any depth.
- Patterns apply to every environment; one that matches nothing in an
  environment is harmless.

Effect, in every code path (push, pull, status, drift, backup, bootstrap, init):

- `push` does not collect matching files, so they are never added to the repo.
- `pull` does not apply matching files from the repo, and never overwrites or
  deletes a matching file that is installed locally, even with `--force` or when
  the repo removed it.
- `status` and drift reports show no entries for them.
- `link` keeps a directory target such as `skills/` as a copy (not a symlink)
  when an exclude pattern lives under it, because a directory symlink would
  expose the excluded children.

Files already committed under an excluded path stay in the repo until you
remove them with git (`git rm -r claude/skills/autospec-run`). A newly added
exclusion protects local files on the same pull that brings it; a removed
exclusion takes effect on the following pull.

### Rollout order (old CLIs reject `exclude`)

`tools/sync-config.json` is validated with a strict schema and `exclude` is
checked by the CLI release that introduced it. There is no repo-version bump
(`.sync-version` stays 2/3) and no capability negotiation. An older `ai-sync`
that reads a config containing `exclude` fails every command that loads the
config (push, pull, status, link, init, bootstrap) with:

```
Invalid .../tools/sync-config.json: unknown key(s) "exclude" (allowed: "plugins", "verify"). Fix the file ...
```

It fails closed: nothing is pushed or applied. Roll out in this order:

1. Release and install the new CLI on **every** host that syncs the repo
   (`ai-sync update`, then check `ai-sync --version`).
2. Only then add `exclude` to `tools/sync-config.json` and push.

If a host was missed, either update its CLI or remove `exclude` from the config.

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
