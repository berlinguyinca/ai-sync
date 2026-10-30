# Fabric (optional)

A "fabric" is a control plane that knows about all of your machines. ai-sync can
query it to show what the other machines are doing and to join the same sync repo
consistently. It is **off by default**: with no endpoint configured, ai-sync makes
no network calls for fabric and no existing command changes.

## Configuration

The endpoint comes from config only (never from other apps' files):

1. env `AI_SYNC_FABRIC_URL`, or
2. `<sync repo>/tools/fabric.json` (default `~/.ai-sync/tools/fabric.json`):

```json
{ "url": "https://fabric.example.com" }
```

The URL must be `http` or `https` and must not embed credentials. If an API key is
needed, set env `AI_SYNC_FABRIC_TOKEN`; it is sent as the `X-API-Key` header, is
never written to disk and never printed. Redirects are not followed, so the key
cannot be forwarded to another origin.

## Commands

```bash
ai-sync fabric status [--json]   # table of hosts; stale (>1h) rows yellow, errors red
ai-sync fabric join [--yes]      # dry run by default; --yes applies
```

`join` fetches the shared config and, with `--yes`: bootstraps `repo_url`@`branch`
into the sync repo dir, enables the listed environments, and sets `enabled` in
`tools/merge-config.json` (other keys are preserved; the file is left uncommitted).
It refuses to touch an existing sync repo whose `origin` differs from `repo_url`,
and rejects `repo_url` values that are not `https://`, `ssh://` or `user@host:path`
(so `file://`, `ext::` and values starting with `-` are refused).

## Protocol (for other implementations)

Limits enforced by the client: 5 s total timeout, 1 MB response cap, strict shape
validation (unknown extra fields are ignored; wrong types are rejected).

### `GET {url}/api/v1/ai-sync`

```json
{
  "hosts": [
    {
      "host_id": "laptop",
      "ai_sync_version": "1.2.3",
      "envs_enabled": ["claude", "pi"],
      "last_sync_ts": "2026-01-01T12:00:00Z",
      "ahead": 0,
      "behind": 2,
      "drifted_files_count": 1,
      "last_error": null,
      "checked_at": "2026-01-01T12:05:00Z"
    }
  ]
}
```

`ai_sync_version`, `last_sync_ts`, `ahead`, `behind`, `drifted_files_count` and
`last_error` may be `null`; the rest are required.

### `GET {url}/api/v1/ai-sync/config`

```json
{ "repo_url": "https://github.com/me/ai-config.git", "branch": "main", "envs": ["claude", "pi"], "merge_enabled": true }
```

Return `404` if the fabric has no shared config. `envs` must be ai-sync environment
ids (`claude`, `codex`, `opencode`, `antigravity`, `pi`).
