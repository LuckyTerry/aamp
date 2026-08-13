# Task Agent Type Display and Coco Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display canonical Task Agent types verbatim and replace the canonical internal legacy type `trae` with the intentionally incompatible type `coco`.

**Architecture:** Change the Bootstrap and Controller allowlists to the same six canonical values, return `coco` from internal-Coco discovery, and keep the existing Coco-to-Traex preparation flow under the new key. Make display helpers identity functions so menus, saved bindings, and logs render raw types without product aliases.

**Tech Stack:** Bash, Node.js ESM, `node:test`, npm.

## Global Constraints

- Canonical types are exactly `codex`, `cursor`, `coco`, `traex`, `traecli`, and `workbuddy`.
- Display canonical types verbatim in selection menus, binding lists, start/remove menus, and logs.
- Reject `--agent trae` and reject stored `agent_type: trae`; do not migrate either value.
- Preserve automatic Trae-family discovery order `traex -> coco -> traecli`.
- Preserve the existing Coco upgrade, cancellation, pending normalization, native ACP, login, and TraeCode doctor behavior.
- Keep the repository npm release helper aligned so generated startup commands default to `coco` and reject `trae`.
- Do not modify ACP Bridge native profiles, package versions, npm publications, or branch remote state.

---

### Task 1: Specify the Breaking Canonical Type Contract

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`

**Interfaces:**
- Consumes: Bootstrap `validate_agent_name`, `agent_display_name`, discovery helpers; Controller `AGENT_TYPES`, display helpers, store validation, and preparation normalization.
- Produces: failing assertions for the six new raw types and rejection of the removed `trae` type.

- [ ] Add assertions that both display helpers return each of the six canonical values unchanged.
- [ ] Add a Bootstrap display-helper assertion for the same six values.
- [ ] Change Coco discovery expectations from `trae` to `coco`.
- [ ] Add a Bootstrap validation fixture proving `coco` succeeds and `trae` fails.
- [ ] Add a Controller list fixture proving old `agent_type: trae` fails validation.
- [ ] Run `node --test test/traecode-one-click.test.mjs test/trae-one-click.test.mjs test/bootstrap.test.mjs test/workbuddy-one-click.test.mjs` and confirm failures are caused by the old canonical contract.

### Task 2: Implement the Canonical Rename and Identity Display

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`

**Interfaces:**
- Produces: Bootstrap and Controller accept only the six new canonical values; Coco discovery/preparation uses `coco`; display helpers return their argument unchanged.

- [ ] Replace the Bootstrap `trae` type branches with `coco` in validation, detection, preparation, login, ACP command construction, and internal discovery.
- [ ] Replace the Controller allowlist and Coco preparation normalization source type with `coco`.
- [ ] Change Bash and Node.js display functions to identity functions.
- [ ] Run the focused tests and confirm the canonical-contract assertions pass.

### Task 3: Update Existing Contracts and Documentation

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/README.md`

**Interfaces:**
- Produces: all existing upgrade, cancellation, normalization, runtime, documentation, and package-contract tests describe `coco`, while explicit negative coverage retains `trae` only as a rejected legacy input.

- [ ] Update existing fixtures from canonical `trae` to canonical `coco` without changing scenario behavior.
- [ ] Remove documentation claims that `trae` is accepted or preserved.
- [ ] Document the six raw displayed types and explicit incompatibility of `trae`.
- [ ] Run the complete Task Agent test suite.

### Task 4: Align the Repository npm Release Skill

**Files:**
- Modify: `.agents/skills/aamp-npm-release/SKILL.md`
- Modify: `.agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs`
- Create: `.agents/skills/aamp-npm-release/scripts/aamp-npm-release.test.mjs`

**Interfaces:**
- Produces: generated startup commands default to canonical `coco`, accept only the six Task Agent types, and reject removed `trae`.

- [ ] Add a failing helper/skill regression test for the `coco` default and rejected `trae` input.
- [ ] Change helper usage, argument default, validation, and wizard command reproduction to the new canonical contract.
- [ ] Document the canonical values and default in the repository release skill.
- [ ] Run the focused release helper test.

### Task 5: Verify and Commit

**Files:**
- Verify all modified files from Tasks 1-4.

- [ ] Run `npm test` in `packages/aamp-feishu-task-agent` and require zero failures.
- [ ] Run `node --test .agents/skills/aamp-npm-release/scripts/aamp-npm-release.test.mjs`.
- [ ] Run `bash -n packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`.
- [ ] Run `git diff --check` and inspect `git diff --stat` plus `git status --short`.
- [ ] Commit only the design, plan, Task Agent implementation/tests/README, and the aligned repository release skill with message `feat(task-agent): rename legacy Trae type to Coco`.
