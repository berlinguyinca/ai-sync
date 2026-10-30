# `ai-sync verify`

Proves that the synced tool configuration on this machine actually loads.
It is read-only: it never writes, repairs or deletes anything.

```bash
ai-sync verify                      # every enabled environment
ai-sync verify --env claude         # one environment
ai-sync verify --json               # machine-readable output on stdout
```

Exit codes: `0` ok, `1` errors found, `2` usage or internal failure (for
example an unknown `--env`).

## Claude Code checks

All paths are relative to the Claude config dir (`~/.claude`).

- `skills/`: every directory has a `SKILL.md`. A directory without one that
  contains `SKILL.md` files deeper (such as `skills/synced/`) is a container
  and is not an error. Frontmatter must be valid YAML, `name` must equal the
  directory name, `description` must be a non-empty string.
- `agents/*.md`: frontmatter parses, `name` and `description` are present,
  `model` (if present) is `sonnet`, `opus`, `haiku`, `fable`, `inherit` or
  matches `claude-[a-z0-9.-]+`.
- `commands/**/*.md`: frontmatter, if present, parses.
- Frontmatter that is not strict YAML only because of an unquoted `: ` inside
  a value (for example `description: Ship it: branch, PR`) is accepted with a
  warning, because Claude Code loads such files. A lenient line parser (top-level
  `key: value` lines, value taken verbatim) must recover the required keys
  (`name` and a non-empty `description` for skills and agents; none for
  commands) and every line must be a key line, comment, `- ` item or
  space-indented continuation; unterminated frontmatter and other garbage
  remain errors. Warnings never fail the run. Quote the value to silence it.
- `settings.json`: valid JSON. Every hook `command` and `statusLine.command`
  is scanned for script paths starting with `$HOME/`, `${HOME}/`, `~/`,
  `{{HOME}}/`, the current home directory or
  `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/`. Each referenced file must exist;
  `.sh` files must be executable (unless run as `bash file.sh`);
  `.js/.mjs/.cjs` files must pass `node --check` (10s timeout; if `node` is
  not on `PATH` a warning is reported instead).
- Guarded commands (ending in `|| true`, or prefixed with `[ -f ... ] &&`) are
  still checked, but any problem is only a warning.
- Broken symlinks under `skills/`, `agents/`, `commands/` and `hooks/`.
- `CLAUDE.md` exists and is not empty.

Environments without a dedicated verifier (Codex, OpenCode, Pi, Antigravity)
get a generic check: every synced `*.json` file parses (comments and trailing
commas are tolerated). TOML is not checked because ai-sync has no TOML parser
dependency. Other environments can add a verifier with `registerVerifier` in
`src/core/verify/index.ts`.

## Output

```json
{
  "ok": false,
  "env": "claude",
  "configDir": "/home/me/.claude",
  "checked": { "skills": 12, "agents": 3, "commands": 5, "hooks": 4, "settings": true },
  "errors": [{ "path": "skills/x/SKILL.md", "problem": "missing or empty description" }],
  "warnings": []
}
```

Problems are short fixed strings; file contents and secrets are never
included. At most 200 errors and 200 warnings are reported; when more exist
`"truncated": true` is added. With several environments `--json` prints
`{"ok": bool, "envs": [model, ...]}`. Human output is one summary line per
environment plus up to 20 errors.

## After `pull`

Set `"verify": true` in `tools/sync-config.json` (see
[`sync-config.md`](sync-config.md)). A non-dry-run `ai-sync pull` then
verifies each pulled environment after applying. On failure it prints the
errors and the backup directory path, and exits 1. It does not roll back;
restore from the backup yourself if you want the previous files. `--dry-run`
never verifies. The default is `false`.
