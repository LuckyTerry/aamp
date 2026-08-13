# Trim Install Success Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the two user-identified redundant install success messages while retaining progress, final summary, supervision, and failure output.

**Architecture:** This is a presentation-only change in the Task Agent controller. Add source-level regression assertions for the exact removed and retained messages, then delete only the two `console.log` calls.

**Tech Stack:** Node.js, `node:test`, shell-based CLI controller.

---

### Task 1: Protect the concise install output contract

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`

- [ ] **Step 1: Write the failing regression assertions**

Assert that the controller source does not contain `已完成绑定并启动：` or `已写入 ${result.succeeded.length} 个绑定配置`, while still containing the final `已成功建立绑定并启动` summary, terminal supervision message, and failure-count message.

- [ ] **Step 2: Verify the assertions fail for the current output**

Run: `node --test test/runtime-network.test.mjs`

Expected: FAIL because both redundant success messages are still present.

- [ ] **Step 3: Remove only the two redundant log calls**

Delete the per-binding success log in `runBindingSession()` and the configuration-path success log in `runInstall()`. Do not change binding state, persistence, startup, summary, or error handling.

- [ ] **Step 4: Verify syntax, tests, and package contents**

Run: `node --check bin/feishu-task-agent-controller.mjs && node --test test/runtime-network.test.mjs && npm pack --dry-run --cache /tmp/aamp-npm-cache && git diff --check`

Expected: syntax succeeds, the focused suite passes, the package dry-run succeeds, and the diff has no whitespace errors.

No Git commit or push is authorized for this task.
