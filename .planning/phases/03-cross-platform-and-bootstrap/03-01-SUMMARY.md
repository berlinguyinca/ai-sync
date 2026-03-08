---
phase: 03-cross-platform-and-bootstrap
plan: 01
subsystem: platform
tags: [cross-platform, windows, path-normalization, posix]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: scanner, path-rewriter, paths.ts utility module
provides:
  - normalizePath utility function for consistent POSIX-style paths
  - Windows-aware path rewriting with JSON-escaped backslash handling
  - Cross-platform scanner output contract (forward-slash relative paths)
affects: [03-02-bootstrap, sync-engine]

# Tech tracking
tech-stack:
  added: []
  patterns: [replaceAll-based path normalization, regex path cleanup after token replacement]

key-files:
  created:
    - tests/platform/paths.test.ts
  modified:
    - src/platform/paths.ts
    - src/core/scanner.ts
    - src/core/path-rewriter.ts
    - src/core/sync-engine.ts
    - src/index.ts
    - tests/core/scanner.test.ts
    - tests/core/path-rewriter.test.ts

key-decisions:
  - "Used replaceAll('\\\\', '/') instead of split(path.sep).join('/') so normalizePath works as a universal normalizer regardless of runtime OS"
  - "Handle JSON-escaped double-backslash Windows paths in rewritePathsForRepo since settings.json content has escaped backslashes"
  - "Used regex capture group after {{HOME}} token to normalize all backslashes in path suffix, not just the first one"

patterns-established:
  - "normalizePath wrapping: Always wrap path.relative() output with normalizePath() before allowlist checks or Set comparisons"
  - "Token path normalization: After replacing homeDir with {{HOME}}, normalize remaining separators to forward slashes"

requirements-completed: [SETUP-02]

# Metrics
duration: 5min
completed: 2026-03-08
---

# Phase 3 Plan 1: Cross-Platform Path Normalization Summary

**normalizePath utility with backslash-to-forward-slash conversion, scanner fix for Windows path.relative output, and path-rewriter Windows home directory handling with JSON-escaped backslash support**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-08T20:43:01Z
- **Completed:** 2026-03-08T20:48:01Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Added normalizePath() utility to src/platform/paths.ts that converts all backslashes to forward slashes for consistent cross-platform path handling
- Fixed scanner.ts to wrap path.relative() output with normalizePath(), ensuring allowlist matching works on Windows where path.relative returns backslash-separated paths
- Enhanced rewritePathsForRepo to handle Windows home directories including JSON-escaped double-backslash variants and mixed-separator content
- Added 11 new test cases across 3 test files covering Windows-style paths, mixed separators, and cross-platform roundtrips
- Exported normalizePath from src/index.ts for external consumers

## Task Commits

Each task was committed atomically:

1. **Task 1: Add normalizePath utility and fix scanner** - `130c9f5` (feat)
2. **Task 2: Enhance path-rewriter and sync-engine, update exports** - `c11f9cd` (feat)

_Note: TDD tasks had RED (failing tests) then GREEN (implementation) within single commits._

## Files Created/Modified
- `src/platform/paths.ts` - Added normalizePath() utility function
- `src/core/scanner.ts` - Wrapped path.relative() with normalizePath() for cross-platform paths
- `src/core/path-rewriter.ts` - Added Windows backslash handling: JSON-escaped paths, mixed separators, regex path normalization after {{HOME}} token
- `src/core/sync-engine.ts` - Added cross-platform dependency comment documenting scanner normalization contract
- `src/index.ts` - Added normalizePath to public API exports
- `tests/platform/paths.test.ts` - 7 unit tests for normalizePath covering backslash, mixed, empty inputs
- `tests/core/scanner.test.ts` - 1 new cross-platform contract test for forward-slash output
- `tests/core/path-rewriter.test.ts` - 3 new Windows backslash handling tests including roundtrip

## Decisions Made
- Used `replaceAll("\\", "/")` instead of `split(path.sep).join("/")` so normalizePath works as a universal normalizer regardless of runtime OS -- the path.sep approach only converts on Windows, but using literal backslash ensures any backslash input is normalized
- Added JSON-escaped double-backslash replacement in rewritePathsForRepo because JSON file content on Windows stores paths with escaped backslashes (e.g., `C:\\Users\\bob`) while os.homedir() returns single backslashes
- Used regex capture group `{{HOME}}([^"'\s,}]*)` to normalize ALL backslashes in the path suffix after the {{HOME}} token, not just the immediately adjacent one

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed JSON-escaped backslash handling in rewritePathsForRepo**
- **Found during:** Task 2 (path-rewriter enhancement)
- **Issue:** Plan's implementation only handled single-backslash homeDir replacement, but JSON content contains double-backslash escaped paths that don't match the single-backslash homeDir from os.homedir()
- **Fix:** Added replaceAll for JSON-escaped variant (homeDir with `\\` doubled to `\\\\`) before forward-slash variant replacement
- **Files modified:** src/core/path-rewriter.ts
- **Verification:** All 3 Windows backslash tests pass including roundtrip
- **Committed in:** c11f9cd (Task 2 commit)

**2. [Rule 1 - Bug] Fixed regex to normalize all backslashes after {{HOME}} token**
- **Found during:** Task 2 (path-rewriter enhancement)
- **Issue:** Plan's approach of `replaceAll("{{HOME}}\\", "{{HOME}}/")` only replaces the first backslash after the token, leaving subsequent backslashes in the path
- **Fix:** Used regex with capture group to find and normalize all backslashes in the entire path suffix after {{HOME}}
- **Files modified:** src/core/path-rewriter.ts
- **Verification:** Mixed separator test verifies both `\\.claude\\y` segments are normalized
- **Committed in:** c11f9cd (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs in plan's proposed implementation)
**Impact on plan:** Both fixes essential for correctness of Windows path handling. No scope creep.

## Issues Encountered
- Test for scanner cross-platform contract initially included `plugins/marketplace/` path not in the allowlist -- fixed to use `hooks/` directory which is allowlisted

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Cross-platform path normalization complete, ready for Plan 03-02 (Bootstrap command)
- All 101 tests pass, TypeScript compiles clean
- normalizePath exported and available for bootstrap implementation

---
*Phase: 03-cross-platform-and-bootstrap*
*Completed: 2026-03-08*
