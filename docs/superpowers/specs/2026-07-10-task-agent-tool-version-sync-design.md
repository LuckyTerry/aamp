# Task Agent Tool Version Sync Design

## Problem

The short `feishu-task-agent` launcher can be newer than the globally installed
`@zengxingyuan/aamp-feishu-task-agent` package. The launcher currently reuses
`$NPM_GLOBAL_PREFIX/bin/aamp-logs` whenever that file exists, without checking
the owning package version. This can restore an old `aamp-logs` after the local
copy is removed.

## Design

Treat the task-agent package installed under `$NPM_GLOBAL_PREFIX` as the
canonical source for package tools. Before reusing `aamp-logs`, read the global
package version from its `package.json` and compare it with the expected task
agent version. Install the exact expected package version when the package is
missing, stale, or does not expose the expected binaries.

The update flow installs the latest complete package first, then atomically
refreshes the stable launcher and log command. Normal startup performs a local
consistency check on every run but keeps the existing 24-hour network update
cache. A filesystem lock serializes package updates across concurrent terminal
sessions.

Expose `aamp-logs --version` by resolving the package version next to the real
global script. The stable `~/.aamp/bin/aamp-logs` entry points to the canonical
global binary so there is no independently copied implementation to become
stale.

## Failure Handling

Do not replace the stable launcher or log command until the exact package
version has installed and its files have been validated. Do not refresh the
update cache on failure. If another process owns the update lock, wait for it
to finish and then re-check local state.

## Verification

- A stale global package is upgraded even when its `aamp-logs` file exists.
- A missing global `aamp-logs` is repaired.
- An already consistent installation does not invoke npm.
- Explicit update refreshes the full package and both stable commands.
- Concurrent update attempts serialize through the update lock.
- `aamp-logs --version` matches the task-agent package version.
