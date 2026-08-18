---
name: aamp-local-release
description: >
  Use when an agent needs to rebuild or locally exercise aime-acp,
  aamp-acp-bridge, aamp-feishu-bridge, or aamp-feishu-task-agent without
  publishing, including requests for a local tgz or a local startup command.
---

# AAMP local release

Use this skill as an agent-facing runbook for local-only testing. Do the build
and pack work yourself with the bundled helper script. Never publish.

The helper script is:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs
```

## What this does

1. Builds the selected package(s) so their `dist` output is current
   (`npm run build`; skipped for `aamp-feishu-task-agent`, which is
   source/bootstrap based).
2. Packs content-addressed `.tgz` artifacts when requested, and automatically
   packs packages that cannot be tested by a live `file:` reference.
3. Prints one isolated startup subshell with the exact local package selection.

Bridge and AIME builds run their package preparation hooks, and the helper
rejects a package executable that is missing or lacks execute permission. Both
helper-time and runtime npm caches are temporary and cleaned on success or
failure.

## How the local override works

Normal Task Agent starts ignore inherited package override variables so an old
local debug value cannot replace a released package. The generated command
runs in a subshell, first unsets every ACP/Feishu/AIME override family, and then
sets only this run's selection with `AAMP_TASK_ALLOW_PACKAGE_OVERRIDES=true`:

- `ACP_BRIDGE_PKG` → controller `AAMP_TASK_ACP_BRIDGE_PKG` → the ACP bridge package
- `FEISHU_BRIDGE_PKG` → controller `AAMP_TASK_FEISHU_BRIDGE_PKG` → the Feishu bridge package
- `AIME_ACP_PKG` → controller `AAMP_TASK_AIME_ACP_PKG` → the AIME ACP tgz

Reference selection is package-specific:

- ACP and Feishu Bridge default to `file:<repo>/packages/<dir>`. npm resolves
  the folder and on
  npm 11 symlinks the live package folder, so the bridge runs the current
  `dist` directly. After editing source, rebuild (`npm run build`) and restart;
  no repack is needed.
- AIME is tgz-only. `aimeAcp` always builds a local AIME `.tgz` and
  automatically includes `taskAgent`; it never uses `file:packages/aime-acp`.
- Selecting `taskAgent` automatically packs it. It installs the local Task Agent tgz into
  `$HOME/.aamp/npm-global`, explicitly pins `AAMP_TASK_AGENT_NAME` to the packed local
  manifest name for that subshell, sets `AAMP_TASK_AUTO_UPDATE=false`, and starts that
  exact npm-global launcher directly. Its normal startup synchronizes `~/.aamp/bin`
  before opening the interactive selector; the generated command does not run a
  separate `update` step.
- `--mode tgz` makes selected bridges use packed snapshots too.
- When `taskAgent` is selected directly or via `aimeAcp`, the helper preflights
  every unselected Task Agent default package pin before printing a runnable
  command. Local overrides skip that package's remote check; unresolved defaults
  fail early with an actionable message naming the pin and telling you which
  `--package acpBridge`, `--package feishuBridge`, or `--package aimeAcp` flag
  to add instead of silently auto-including everything.
- `--plan-only` stays safe for Task Agent runs: it does not promise that
  unselected default pins are runnable, and reports that Task Agent preflight
  was skipped/unchecked.

When npm resolves the local package it still downloads the package's public
dependencies (pino, @larksuiteoapi/node-sdk, aamp-sdk, ...) from the registry.
That is dependency installation, not publishing our packages.

Use the generated subshell verbatim. It makes no persistent exports and does
not leak package overrides or npm cache paths into the caller shell. Existing
`file:` directories are accepted only for bridge overrides; AIME accepts only
an existing local `.tgz`. Remote URLs, option-shaped specs, missing paths, and
AIME `file:` references fail closed.
Do not replace it with a persistent `export`.

## Choose packages from the change set

- `packages/aime-acp/**` changed: pass `--package aimeAcp`; this automatically
  includes `taskAgent` but not `acpBridge`.
- `packages/aamp-feishu-bridge/**` changed: pass `--package feishuBridge`.
- `packages/aamp-acp-bridge/**` changed: pass `--package acpBridge`.
- `packages/aamp-feishu-task-agent/**` changed: pass `--package taskAgent`.
- Multiple packages changed: pass one `--package` per package, or `--package all`.
- Only docs, skills, or unrelated files changed: do not run a release; nothing
  needs a local rebuild unless the user asks for a fresh build anyway.

## Agent workflow

1. Inspect repository state (`git status --short` / `git diff --name-only`) to
   determine which AAMP packages changed, then pass the matching `--package`
   flags. The helper defaults to all packages when none are given.
2. Run the helper with non-interactive flags. It builds, optionally packs, and
   prints the startup command. Do not make the user run `node ...` themselves
   as the normal path.
3. If the user only wants a bridge `file:` command, run with `--plan-only`.
   AIME, Task Agent, or `--mode tgz` needs a real content hash, so plan-only
   prints a non-runnable notice instead of inventing an artifact path. For Task
   Agent selections it also skips default-pin preflight, so treat the output as
   unchecked until a real run succeeds.
4. If the user wants an immutable artifact, add `--pack` (and optionally
   `--mode tgz` so the printed command references the tarball).
5. Report the printed startup command in the final reply, and call out the two
   required steps: stop the currently running Task Agent first (it holds the
   runtime/agent leases), then run the command. `feishu-task-agent start` is
   interactive; it opens the multi-select for saved bindings.
   Use the generated subshell verbatim. Do not replace it with persistent
   exports or split its install/start sequence.
6. Suggest verification: send the agent a task that exercises the changed code
   path and confirm the Feishu comment shows the real text (for the
   help-text/timezone fix, "查询今天的日程" should show
   `请提供你所在的时区，例如 Asia/Shanghai…` and never
   `REMOTE_AGENT_FAILED：远程智能体执行失败…`).

## Helper commands for agents

Build the Feishu bridge locally and print the file:-folder startup command:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package feishuBridge
```

Build AIME and the automatically included local Task Agent tgz:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package aimeAcp
```

Build both bridges with live `file:` references:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package acpBridge \
  --package feishuBridge
```

Build all four packages:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package all
```

Only print the plan and startup command (no build, no pack):

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package feishuBridge \
  --plan-only
```

Build and pack a local tgz, then print the tgz-based startup command:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package feishuBridge \
  --pack \
  --mode tgz \
  --out-dir /tmp/aamp-local-release
```

Sanity-check that npm can actually resolve the local bridge executable
(slower: downloads public dependencies):

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package feishuBridge \
  --verify
```

Machine-readable output for agents:

```bash
node .agents/skills/aamp-local-release/scripts/aamp-local-release.mjs \
  --package feishuBridge \
  --plan-only \
  --json
```

## Safety rules

- This skill never publishes. There is no `--publish` flag; reject any request
  to publish with this skill and point to `aamp-npm-release` instead.
- Mutating local and npm release operations use one shared release lock under the
  Git common directory. Concurrent helpers or linked worktrees fail fast and
  report the live owner; `--help` and `--plan-only` do not take the lock.
- The local build only affects a future Task Agent start: the running bridge
  does not hot-swap. Always tell the user to stop the current Task Agent
  before starting with the new overrides.
- Task Agent local runs fail closed before printing a runnable command when an
  unselected default ACP/Feishu/AIME pin cannot be resolved from its registry.
  The fix is to add the corresponding local override package flag for the
  package you changed; for example, if the missing default is the ACP bridge,
  rerun with `--package acpBridge`.
- Normal Task Agent starts intentionally ignore inherited package override
  variables. The local subshell clears stale overrides before its one-shot
  opt-in; bridges may use an existing `file:` directory or local `.tgz`, while
  AIME is tgz-only.
- `file:` mode requires `dist` to exist. If a build was skipped and `dist` is
  stale or missing, the helper fails on the missing binary target; rebuild
  first or run with `--build` (the default).
- Packed artifacts are content-addressed by SHA-256. The helper reuses
  byte-identical output, never overwrites an existing artifact, and fails
  closed if a conflicting file already occupies the calculated path.
- The helper isolates npm cache writes to a temp directory so `npm run build`
  / `npm pack` do not depend on the user's `~/.npm` permissions.
