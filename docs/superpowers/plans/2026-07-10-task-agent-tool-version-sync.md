# Task Agent Tool Version Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `feishu-task-agent`, the npm-global task-agent package, and `aamp-logs` on the same exact version.

**Architecture:** Read the canonical package version from the task-agent installation under the one-click npm prefix. Repair mismatches with one exact-version npm install protected by a filesystem lock, then expose the package binaries through stable local commands.

**Tech Stack:** Bash, Node.js ESM, Node test runner, npm global prefix.

---

### Task 1: Reproduce stale global package reuse

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`

- [ ] Add a bootstrap test fixture whose short launcher version is newer than the package version under a temporary npm-global prefix.
- [ ] Assert that the bootstrap requests an exact-version package installation even when the old global `aamp-logs` executable exists.
- [ ] Run `node --test packages/aamp-feishu-task-agent/test/bootstrap.test.mjs` and verify the new assertion fails because the current code checks only file existence.

### Task 2: Synchronize the canonical package and stable commands

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`

- [ ] Add a helper that reads `$NPM_GLOBAL_PREFIX/lib/node_modules/@zengxingyuan/aamp-feishu-task-agent/package.json` and returns its version.
- [ ] Add an exact-version consistency helper that checks the package version and required binaries before deciding whether npm installation is necessary.
- [ ] Protect package installation with a PID-bearing lock directory and re-check state after acquiring the lock.
- [ ] Change normal startup and explicit update to synchronize the complete package before exposing `aamp-logs`.
- [ ] Replace the independent copied `~/.aamp/bin/aamp-logs` implementation with a stable link to `$NPM_GLOBAL_PREFIX/bin/aamp-logs` using a temporary link and rename.
- [ ] Run the bootstrap test and verify it passes.

### Task 3: Expose the log tool version

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/aamp-logs.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/aamp-logs.test.mjs`

- [ ] Add a failing test for `aamp-logs --version` using the package version from `package.json`.
- [ ] Run `node --test packages/aamp-feishu-task-agent/test/aamp-logs.test.mjs` and verify the command currently fails as unknown.
- [ ] Implement `--version` by reading the package metadata adjacent to the real script.
- [ ] Run the focused test and verify it passes.

### Task 4: Verify the integrated update flow

**Files:**
- Modify: `packages/aamp-feishu-task-agent/package.json`
- Modify: `packages/aamp-feishu-task-agent/package-lock.json`

- [ ] Bump the task-agent prerelease version once all behavior is green.
- [ ] Run `bash -n packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`.
- [ ] Run `node --test --test-concurrency=1 "test/**/*.test.mjs"` from `packages/aamp-feishu-task-agent`.
- [ ] Run `git diff --check` and `npm pack --dry-run`.
- [ ] Confirm no commit or push is performed without explicit user authorization.
