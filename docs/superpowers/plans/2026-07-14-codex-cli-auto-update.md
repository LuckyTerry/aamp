# Codex CLI Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the actually selected Codex CLI before login checks and ACP startup while allowing startup to continue when updating fails.

**Architecture:** Add a focused update helper to the existing one-click bootstrap. It uses the existing Codex resolver, prints and compares the selected/latest versions, invokes the selected CLI's native update command without confirmation only when a newer version exists, logs detailed results, and is called only for Codex before login validation.

**Tech Stack:** Bash, Node.js built-in test runner, npm package scripts.

---

### Task 1: Specify startup ordering and lenient failure

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`
- Test: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`

- [x] Add assertions that `ensure_codex_cli_updated` exists, calls the selected binary's `update` command, records failure without `agent_fail`, and runs after `ensure_agent_cli` but before `ensure_agent_login`.
- [x] Run `node --test test/bootstrap.test.mjs` and verify the new test fails because the helper is absent.

### Task 2: Implement selected Codex CLI update

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`

- [x] Add `CODEX_UPDATE_LOCK_DIR` beside the existing runtime locks.
- [x] Add a version reader that executes the selected binary with `--version` and extracts the first output line.
- [x] Query and display the latest `@openai/codex` version before updating.
- [x] Print the update-start message and update automatically without asking for confirmation only when the latest version is newer.
- [x] Skip both the update-start message and update command when the selected CLI is already latest.
- [x] Add a locked update helper that executes `"$codex_bin" update`, appends output to `ONE_CLICK_LOG`, and returns its status.
- [x] Add the lenient wrapper that logs the selected path/version, attempts the locked update, re-resolves the CLI after success, and logs a warning without returning failure when updating fails.
- [x] Invoke the wrapper after `ensure_agent_cli` and before `ensure_agent_login`.
- [x] Run `node --test test/bootstrap.test.mjs` and verify the regression test passes.

### Task 3: Package and regression verification

**Files:**
- Modify: `packages/aamp-feishu-task-agent/package.json`
- Modify: `packages/aamp-feishu-task-agent/package-lock.json`
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`

- [x] Bump the task-agent prerelease version once.
- [x] Run `npm test` and expect all tests to pass.
- [x] Run `bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh` and expect exit code 0.
- [x] Run `git diff --check` and expect no whitespace errors.
- [x] Run `npm_config_cache=/tmp/aamp-npm-cache npm pack --dry-run` and verify the expected version and four package files.

No commit or push is included because repository policy requires separate user authorization.
