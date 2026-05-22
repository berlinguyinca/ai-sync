# `tools/merge-config.json` reference

ai-sync uses an opt-out, AI-assisted 3-way merge when pulling a v2 sync repo. The
behavior is controlled by `tools/merge-config.json` at the root of the sync
repo. If the file is absent, schema defaults apply.

AI-assisted merge is **enabled by default**. To turn it off, write
`{ "enabled": false }` into `tools/merge-config.json` and push.

## Schema

| Field            | Type                                    | Default       | Description                                                                                                                                |
| ---------------- | --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`        | `boolean`                               | `true`        | Master switch. When `false`, `ai-sync pull` falls back to the legacy keep-local behavior on conflict.                                      |
| `resolver`       | `"claude" \| "codex" \| "opencode"`     | `"claude"`    | Which local CLI drives the merge prompt. The matching binary must be on `PATH`.                                                            |
| `autoApply`      | `boolean`                               | `false`       | When `true`, merged content is written directly to the live config file. When `false`, merges land in `.ai-sync/pending/` for review.      |
| `timeoutSeconds` | positive integer                        | `60`          | Per-file timeout for the resolver invocation. Hitting the timeout falls back to keep-local for that file.                                  |
| `perType`        | record of glob → strategy               | (see below)   | Strategy override per glob. Strategies: `ai-freeform`, `ai-validated`, `keep-local`. Unmatched files use the `*` entry.                    |

### `perType` defaults

```jsonc
{
  "*.md":   "ai-freeform",   // free-form 3-way merge
  "*.json": "ai-validated",  // 3-way merge + JSON.parse validation
  "*.yaml": "ai-validated",
  "*.yml":  "ai-validated",
  "*.lock": "keep-local",    // never let AI touch lockfiles
  "*":      "keep-local"     // safe default for unknown types
}
```

## Examples

### Disable AI-merge entirely

```jsonc
{
  "enabled": false
}
```

### Enable with auto-apply for Markdown only

```jsonc
{
  "enabled": true,
  "resolver": "claude",
  "autoApply": true,
  "timeoutSeconds": 90,
  "perType": {
    "*.md": "ai-freeform",
    "*": "keep-local"
  }
}
```

### Use Codex as the resolver

```jsonc
{
  "enabled": true,
  "resolver": "codex"
}
```

## How merges land

- `autoApply: false` (default) — merged content is staged under
  `<syncRepoDir>/.ai-sync/pending/<env>/<file>`. Use `ai-sync resolve list` to
  see pending merges, `ai-sync resolve diff <path>` to inspect a single one,
  and `ai-sync resolve accept <path>` / `ai-sync resolve reject <path>`
  (or `--all`) to apply or discard them.
- `autoApply: true` — merged content overwrites the live config file
  immediately. The pre-pull backup under `~/.ai-sync-backups/<timestamp>/`
  is your safety net.

## Related commands

- `ai-sync pull --auto-apply` — one-shot override of `autoApply` for a single pull.
- `ai-sync status --verbose` — shows pending merges and resolver availability.
- `ai-sync status --summarize` — asks the configured resolver for a natural-language drift summary.
- `ai-sync resolve list | diff | accept | reject [--all]` — manage pending merges.
