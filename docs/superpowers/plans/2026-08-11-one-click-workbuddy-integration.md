# One-click WorkBuddy Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the native Traex/WorkBuddy ACP integrations and the Trae one-click feature line on `feat/one-click-script`, then make Feishu Task Agent detect and start standard macOS WorkBuddy installations.

**Architecture:** Apply the ACP integration commits first and the complete Trae one-click branch as one synthetic cherry-pick. Resolve ACP conflicts on the later branch structure while restoring canonical `traex` and `workbuddy` resolver contracts, then extend the existing Task Agent bootstrap/controller preparation interface with canonical `workbuddy` bindings.

**Tech Stack:** Git, Bash, Node.js ESM, TypeScript, `node:test`, `tsx`, npm package workspaces.

## Global Constraints

- Start from `origin/main` commit `7fd750875f4da2417672b91aa39eb30d4d7c80d3` on branch `feat/one-click-script`.
- Apply `7f63d4a` and `8210011` first, then one synthetic commit representing the complete `origin/feat/traecli-acp-support` tree.
- Do not rewrite either source branch.
- Preserve #2 Task Agent, Feishu Bridge, CLI Bridge, logging, stream-event, step-rendering, and release-tool behavior.
- Preserve #1 canonical native agent names `traex` and `workbuddy`; do not expose `trae`, `traecli`, or `coco` as native ACP discovery candidates.
- Keep Task Agent's existing legacy `trae` saved-binding compatibility and guided upgrade to `traex`.
- Canonical Task Agent type is exactly `workbuddy`.
- WorkBuddy auto-detection is macOS-only and checks exactly `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy` for an executable file.
- Do not search `PATH` for `codebuddy` or `cbc` and do not invoke a WorkBuddy login command.
- The WorkBuddy ACP command is exactly `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp`.
- Do not publish packages or introduce package-version changes beyond those already present in branch #2.
- Preserve unrelated files and the user's other worktrees.

---

## File Structure

- `packages/aamp-acp-bridge/src/agent-resolver.ts`: canonical ACP discovery and native command resolution.
- `packages/aamp-acp-bridge/src/discovery.ts`: discovery candidates from resolver results and saved config.
- `packages/aamp-acp-bridge/src/cli/init.ts`: forced-name validation, scan targeting, and saved-command reuse.
- `packages/aamp-acp-bridge/test/*.test.ts`: combined native Traex/WorkBuddy contracts.
- `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`: WorkBuddy detection and ACP command generation.
- `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`: type validation, persistence, display, and failure guidance.
- `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`: focused WorkBuddy one-click tests.
- `packages/aamp-feishu-task-agent/README.md`: supported-agent behavior.
- `docs/AGENT_SETUP.md` and `packages/aamp-acp-bridge/README.md`: combined native ACP setup documentation.

---

### Task 1: Integrate Both Source Branches and Resolve ACP Bridge Conflicts

**Files:**
- Modify: `docs/AGENT_SETUP.md`
- Modify: `packages/aamp-acp-bridge/README.md`
- Modify: `packages/aamp-acp-bridge/package.json`
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Modify: `packages/aamp-acp-bridge/src/cli/init.ts`
- Modify: `packages/aamp-acp-bridge/src/discovery.ts`
- Modify: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Modify: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Modify: `packages/aamp-acp-bridge/test/init.test.ts`
- Modify: `packages/aamp-acp-bridge/test/json-init.test.ts`
- Modify: `packages/aamp-acp-bridge/test/path-fixture.ts`

**Interfaces:**
- Consumes: commits `7f63d4a`, `8210011`, tree `origin/feat/traecli-acp-support^{tree}`, parent `7fd7508`.
- Produces: one `traex` and one `workbuddy` in `KNOWN_AGENTS`; combined resolver APIs; resolved tree recorded at `refs/aamp/one-click-integrated`.

- [x] **Step 1: Verify refs and common base**

```bash
git status --short
git rev-parse origin/main origin/feat/acp-bridge-agent-integrations origin/feat/traecli-acp-support
git merge-base origin/main origin/feat/acp-bridge-agent-integrations
git merge-base origin/main origin/feat/traecli-acp-support
```

Expected: both merge-base commands print `7fd750875f4da2417672b91aa39eb30d4d7c80d3`.

- [x] **Step 2: Cherry-pick native ACP commits in original order**

```bash
git cherry-pick 7f63d4aa57719ab7a2ace992776c940a8b47b3a0
git cherry-pick 82100119bbb3e68155ae886c12361745ee3dff45
```

Expected: both succeed; native Traex precedes WorkBuddy in the log.

- [x] **Step 3: Create and cherry-pick one branch-#2 commit**

```bash
trae_source_tree="$(git rev-parse 'origin/feat/traecli-acp-support^{tree}')"
trae_squash_source="$(printf '%s\n\n%s\n' \
  'feat(one-click): integrate Trae task-agent changes' \
  'Squashed from origin/feat/traecli-acp-support at db39f6884b639cf0af86f9a24ebc32da72f42982.' \
  | git commit-tree "$trae_source_tree" -p 7fd750875f4da2417672b91aa39eb30d4d7c80d3)"
git cherry-pick "$trae_squash_source"
```

Expected: conflicts in exactly the 11 files listed above. Do not abort.

- [x] **Step 4: Adopt #2 as the mechanical base and write failing canonical-agent tests**

```bash
git checkout --theirs -- \
  docs/AGENT_SETUP.md \
  packages/aamp-acp-bridge/README.md \
  packages/aamp-acp-bridge/package.json \
  packages/aamp-acp-bridge/src/agent-resolver.ts \
  packages/aamp-acp-bridge/src/cli/init.ts \
  packages/aamp-acp-bridge/src/discovery.ts \
  packages/aamp-acp-bridge/test/agent-resolver.test.ts \
  packages/aamp-acp-bridge/test/discovery.test.ts \
  packages/aamp-acp-bridge/test/init.test.ts \
  packages/aamp-acp-bridge/test/json-init.test.ts \
  packages/aamp-acp-bridge/test/path-fixture.ts
```

Replace legacy native-Trae tests with these contracts while retaining #2 tests for blank and quoted explicit ACP commands:

```ts
test('registers only canonical Traex and WorkBuddy names', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'traex').length, 1)
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy').length, 1)
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.equal(KNOWN_AGENTS.includes(legacyName), false)
  }
})

test('resolves an executable standard macOS WorkBuddy app', () => {
  assert.deepEqual(detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => candidate === WORKBUDDY_APP_CLI,
    versionFor: () => '2.115.0',
  }), {
    command: WORKBUDDY_APP_CLI,
    acpCommand: `${WORKBUDDY_APP_CLI} --acp`,
    version: '2.115.0',
  })
})

test('does not expose legacy Trae discovery candidates', () => {
  const ids = discoverAcpBridgeAgents('/definitely/missing/config.json')
    .candidates.map((candidate) => candidate.id)
  for (const legacyName of ['trae', 'traecli', 'coco']) assert.equal(ids.includes(legacyName), false)
})

test('interactive init accepts Traex and WorkBuddy', () => {
  assert.deepEqual(resolveInitScanTargets('traex'), ['traex'])
  assert.deepEqual(resolveInitScanTargets('workbuddy'), ['workbuddy'])
  assert.throws(() => resolveInitScanTargets('trae'), /Unknown ACP agent/)
})
```

Add JSON-init assertions for default `traex acp serve` and verbatim explicit WorkBuddy command preservation.

- [x] **Step 5: Verify the new contracts initially fail**

From `packages/aamp-acp-bridge` run:

```bash
npm ci
npm test
```

Expected: FAIL because #2 still exposes `trae` and lacks canonical `workbuddy` and scan helpers.

- [x] **Step 6: Implement the combined resolver**

Keep #2's cross-platform `findExecutableOnPath`; replace its Trae aliases with:

```ts
export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_APP_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`

export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'traex', 'workbuddy',
] as const

export interface AgentDetectionOptions extends ExecutableLookupOptions {
  pathIsExecutable?: (candidate: string) => boolean
  versionFor?: (command: string) => string
}

export function defaultAgentCommand(name: string): string {
  return name
}

function baseAcpCommand(name: string, command = defaultAgentCommand(name)): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex') return `${command} acp serve`
  return name
}
```

`detectKnownAgent` must check standard WorkBuddy, then `PATH`, then macOS Codex. Its WorkBuddy branch is:

```ts
if (name === 'workbuddy') {
  if (platform !== 'darwin' || !pathIsExecutable(WORKBUDDY_APP_CLI)) return undefined
  return {
    command: WORKBUDDY_APP_CLI,
    acpCommand: WORKBUDDY_APP_ACP_COMMAND,
    version: versionFor(WORKBUDDY_APP_CLI),
  }
}
```

Use `pathIsExecutable ?? ((candidate) => isExecutableFile(candidate, platform))`. Never call `findExecutableOnPath('codebuddy')`. Preserve #2's generic nonblank previous-command logic. Add WorkBuddy warning branches for missing standard macOS app and unsupported non-macOS detection.

- [x] **Step 7: Combine init behavior and documentation**

Keep #2's `resolveInitAcpCommand`; add:

```ts
export function resolveInitScanTargets(agent?: string): string[] {
  if (!agent) return [...KNOWN_AGENTS]
  if (!KNOWN_AGENTS.includes(agent as typeof KNOWN_AGENTS[number])) {
    throw new Error(`Unknown ACP agent "${agent}". Known agents: ${KNOWN_AGENTS.join(', ')}`)
  }
  return [agent]
}

export function noAgentsFoundMessage(agent?: string): string {
  if (agent) return `No ACP agent found. ${missingAgentWarning(agent)}`
  return 'No ACP agents found. Install an agent first (e.g. npm i -g @anthropic-ai/claude-code).'
}
```

Use these helpers in `runInit`. In both ACP docs state that Traex is the only native Trae discovery name, WorkBuddy uses the standard macOS embedded `codebuddy --acp`, and users sign in through the WorkBuddy app.

- [x] **Step 8: Verify and complete the consolidated cherry-pick**

From `packages/aamp-acp-bridge` run:

```bash
npm test
npm run build
```

Then from the repository root run:

```bash
git diff --check
git diff --name-only --diff-filter=U
git add docs/AGENT_SETUP.md packages/aamp-acp-bridge
git cherry-pick --continue
git update-ref refs/aamp/one-click-integrated HEAD
```

Expected: tests/build pass, no unmerged paths remain, and the consolidated commit completes.

---

### Task 2: Add WorkBuddy Bootstrap Detection and ACP Preparation

**Files:**
- Create: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`

**Interfaces:**
- Consumes: `is_macos`, `agent_cli_detected`, `discover_interactive_agents`, `ensure_agent_cli`, `ensure_agent_login`, `build_acp_agent_command`.
- Produces: fixed `WORKBUDDY_APP_CLI`; `find_workbuddy_cli()`; preparation result `{ agent_type: "workbuddy", acp_command: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp" }`.

- [x] **Step 1: Create the failing bootstrap test harness**

Create `workbuddy-one-click.test.mjs` with:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(testDir, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

function runShell(lines, args = []) {
  return spawnSync('bash', ['-c', lines.join('\n'), 'bash', ...args], { encoding: 'utf8' })
}
```

Add a test that extracts the validation, discovery, WorkBuddy resolver, login, and ACP-command functions. It creates a temporary executable which logs every invocation, overrides `WORKBUDDY_APP_CLI` with that path, stubs `is_macos` to success, then executes:

```bash
validate_agent_name workbuddy
discover_interactive_agents
ensure_agent_cli
ensure_agent_login
build_acp_agent_command
printf '%s|%s' "${DETECTED_AGENTS[*]}" "$ACP_AGENT_COMMAND"
```

Assert:

```js
assert.equal(result.status, 0, result.stderr)
assert.equal(result.stdout, `workbuddy|${fakeCli} --acp`)
assert.equal(spawnSync('test', ['-e', callLog]).status, 1)
```

Add negative scenarios with `is_macos() { return 1; }` and with a missing executable. Assert distinct stderr matches for `仅支持 macOS` and `/Applications/WorkBuddy.app`.

- [x] **Step 2: Run the focused test and verify it fails**

From `packages/aamp-feishu-task-agent` run:

```bash
npm test -- --test-name-pattern=WorkBuddy
```

Expected: FAIL because `workbuddy` is rejected and `find_workbuddy_cli` is absent.

- [x] **Step 3: Implement minimal bootstrap support**

Add the fixed constant near other CLI paths:

```bash
WORKBUDDY_APP_CLI="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

Add beside the Trae resolvers:

```bash
find_workbuddy_cli() {
  is_macos || return 1
  [ -x "$WORKBUDDY_APP_CLI" ] || return 1
  printf '%s\n' "$WORKBUDDY_APP_CLI"
}
```

Add `workbuddy` to `validate_agent_name`, help text, noninteractive guidance, `agent_cli_detected`, `discover_interactive_agents`, and `run_internal_discover_agents`. Append it after the Trae/Traex slot so existing ordering stays stable.

Add this explicit validation before the generic `command -v` fallback:

```bash
if [ "$AGENT" = "workbuddy" ]; then
  is_macos || agent_fail "WorkBuddy 一键探测仅支持 macOS。"
  find_workbuddy_cli >/dev/null 2>&1 \
    || agent_fail "未检测到 WorkBuddy。请确认已安装到 /Applications/WorkBuddy.app 后重新运行脚本。"
  return 0
fi
```

Add a no-op login case:

```bash
workbuddy)
  agent_detail "WorkBuddy authentication is managed by the desktop app"
  ;;
```

Add this first branch in `build_acp_agent_command`:

```bash
if [ "$AGENT" = "workbuddy" ]; then
  local workbuddy_bin
  workbuddy_bin="$(find_workbuddy_cli)" \
    || agent_fail "WorkBuddy 不可用。请确认已安装到 /Applications/WorkBuddy.app。"
  ACP_AGENT_COMMAND="$workbuddy_bin --acp"
  agent_detail "using native WorkBuddy ACP command: $ACP_AGENT_COMMAND"
  return 0
fi
```

- [x] **Step 4: Run focused and bootstrap tests**

From `packages/aamp-feishu-task-agent` run:

```bash
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
npm test -- --test-name-pattern='WorkBuddy|bootstrap'
```

Expected: Bash syntax succeeds; WorkBuddy and existing bootstrap tests pass.

- [x] **Step 5: Commit the bootstrap slice**

```bash
git add \
  packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh \
  packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs
git commit -m "feat(task-agent): detect WorkBuddy for one-click setup"
```

Expected: only bootstrap discovery/preparation and focused tests are committed.

---

### Task 3: Accept, Persist, Display, and Diagnose WorkBuddy Bindings

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/README.md`

**Interfaces:**
- Consumes: bootstrap result `{ agent_type: "workbuddy", acp_command: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp" }` and binding schema version 1.
- Produces: `AGENT_TYPES` with `workbuddy`; persisted `agent_type: "workbuddy"`; `agentFailureMessage(agentType, message)`; canonical lower-case display.

- [x] **Step 1: Add failing controller and persistence tests**

Extend `workbuddy-one-click.test.mjs` with:

```js
test('controller accepts WorkBuddy as a canonical binding type', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /const AGENT_TYPES = \[[^\]]*'workbuddy'/)
  assert.match(source, /codex\/cursor\/trae\/traex\/workbuddy/)
  assert.match(source, /如果尚未登录，请打开 WorkBuddy 完成登录后重试/)
})
```

Add a real `list` test which writes this pending binding into an isolated `bindings-v1.json`:

```js
const binding = {
  binding_id: '22222222-2222-4222-8222-222222222222',
  agent_type: 'workbuddy',
  aamp_host: 'https://meshmail.ai',
  environment: { name: 'online' },
  bot: {
    app_id: 'cli_workbuddy_test',
    app_secret: 'workbuddy-test-only-secret',
    lark_cli_profile: 'workbuddy-test-profile',
  },
  feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
  state: 'pending',
}
```

Run the controller with isolated `HOME`, `AAMP_TASK_STATE_HOME`, `AAMP_TASK_CONFIG_FILE`, `AAMP_TASK_RUNTIME_HOME`, and `AAMP_RUN_LOG_DIR`. Assert exit 0, stdout contains `workbuddy`, and stdout omits `workbuddy-test-only-secret`.

Add copy assertions requiring `--agent codex|cursor|trae|traex|workbuddy` in bootstrap and README, and README text saying authentication is managed by the WorkBuddy desktop app.

- [x] **Step 2: Run the focused test and verify controller assertions fail**

From `packages/aamp-feishu-task-agent` run:

```bash
npm test -- --test-name-pattern=WorkBuddy
```

Expected: FAIL because controller validation and README do not yet support `workbuddy`.

- [x] **Step 3: Implement canonical controller support**

Extend the allowlist and all exact validation/help strings:

```js
const AGENT_TYPES = ['codex', 'cursor', 'trae', 'traex', 'workbuddy'];
```

Leave the WorkBuddy branches of `agentSelectionDisplayName` and `agentBindingDisplayName` on their existing default behavior so UI output is exactly `workbuddy`.

Add beside the display helpers:

```js
function agentFailureMessage(agentType, message) {
  const text = String(message || 'Agent Bridge 启动失败');
  if (agentType !== 'workbuddy') return text;
  return `${text}\n如果尚未登录，请打开 WorkBuddy 完成登录后重试。`;
}
```

Use it in per-agent preparation failure storage:

```js
const reason = agentFailureMessage(effectiveAgentType, redact(error.message || error));
group.failures.set(effectiveAgentType, reason);
```

Use it in ACP group failure storage:

```js
for (const agent of agents) {
  group.failures.set(
    agent.name,
    agentFailureMessage(agent.name, redact(error.message || error)),
  );
}
```

Update no-agent guidance to mention WorkBuddy without claiming authentication was checked.

- [x] **Step 4: Document the WorkBuddy flow**

Add this behavior to `packages/aamp-feishu-task-agent/README.md` without removing legacy Trae text:

```text
`workbuddy` is detected only from the standard macOS WorkBuddy.app installation. The launcher uses the app-bundled `codebuddy --acp` command and does not run a WorkBuddy login command. Open WorkBuddy and complete login before starting a binding. Nonstandard paths and non-macOS installations are not auto-detected.
```

- [x] **Step 5: Run the complete Task Agent suite**

From `packages/aamp-feishu-task-agent` run:

```bash
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
npm test
```

Expected: all Task Agent tests pass, including legacy Trae/Traex and new WorkBuddy tests.

- [x] **Step 6: Commit controller and documentation**

```bash
git add \
  packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs \
  packages/aamp-feishu-task-agent/README.md
git commit -m "feat(task-agent): support WorkBuddy bindings"
```

Expected: controller, persistence, failure copy, README, and focused tests are committed.

---

### Task 4: Verify the Combined Branch and Normalize Final History

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-one-click-workbuddy-integration-design.md` only if verification exposes a factual mismatch.
- Modify: `docs/superpowers/plans/2026-08-11-one-click-workbuddy-integration.md` only to mark completed checks before history normalization.

**Interfaces:**
- Consumes: `refs/aamp/one-click-integrated`, fully tested final tree, original ACP integration tip `8210011`.
- Produces: four commits in order: native Traex, native WorkBuddy, consolidated one-click/Trae branch, focused WorkBuddy Task Agent change including design/plan docs.

- [x] **Step 1: Run every affected test and build**

Run in the indicated directories:

```bash
# packages/aamp-acp-bridge
npm ci
npm test
npm run build

# packages/aamp-feishu-task-agent
npm ci
npm test

# packages/aamp-feishu-task-bridge
npm ci
npm test
npm run build

# packages/aamp-feishu-bridge
npm ci
npm run build

# packages/aamp-cli-bridge
npm ci
npm run build
```

Expected: every command exits 0. Package installation or a build alone is not functional verification.

- [x] **Step 2: Check conflicts, whitespace, and source-path coverage**

From the repository root run:

```bash
git diff --check
rg -n '^(<<<<<<<|=======|>>>>>>>)' docs packages || true
comm -23 \
  <(git diff --name-only origin/main...origin/feat/acp-bridge-agent-integrations | sort -u) \
  <(git diff --name-only origin/main...HEAD | sort -u)
comm -23 \
  <(git diff --name-only origin/main...origin/feat/traecli-acp-support | sort -u) \
  <(git diff --name-only origin/main...HEAD | sort -u)
```

Expected: no whitespace errors, conflict markers, or missing changed paths.

- [x] **Step 3: Review the post-integration behavioral diff**

```bash
git diff --stat origin/main...HEAD
git diff refs/aamp/one-click-integrated..HEAD -- \
  packages/aamp-feishu-task-agent \
  docs/superpowers
git status --short
```

Expected: post-integration changes are limited to WorkBuddy Task Agent support and the approved design/plan; status is clean.

- [x] **Step 4: Construct the final four-commit history without replaying conflicts**

Create an integrated tree with the design/plan removed, then parent it directly on the original WorkBuddy ACP commit:

```bash
history_index="$(mktemp "${TMPDIR:-/tmp}/aamp-one-click-history.XXXXXX")"
rm "$history_index"
GIT_INDEX_FILE="$history_index" git read-tree 'refs/aamp/one-click-integrated^{tree}'
GIT_INDEX_FILE="$history_index" git rm --cached --ignore-unmatch \
  docs/superpowers/specs/2026-08-11-one-click-workbuddy-integration-design.md \
  docs/superpowers/plans/2026-08-11-one-click-workbuddy-integration.md
integrated_tree="$(GIT_INDEX_FILE="$history_index" git write-tree)"
rm "$history_index"
integrated_commit="$(printf '%s\n\n%s\n' \
  'feat(one-click): integrate Trae task-agent changes' \
  'Squashed from origin/feat/traecli-acp-support at db39f6884b639cf0af86f9a24ebc32da72f42982 and resolved with native ACP integrations.' \
  | git commit-tree "$integrated_tree" -p 82100119bbb3e68155ae886c12361745ee3dff45)"
```

Create the WorkBuddy commit from the already-tested final tree and atomically move only the target branch ref:

```bash
final_tree="$(git rev-parse 'HEAD^{tree}')"
workbuddy_commit="$(printf '%s\n\n%s\n' \
  'feat(task-agent): support WorkBuddy one-click bindings' \
  'Detects standard macOS WorkBuddy installations, uses the embedded native ACP command, and preserves desktop-managed authentication.' \
  | git commit-tree "$final_tree" -p "$integrated_commit")"
previous_head="$(git rev-parse HEAD)"
git update-ref refs/heads/feat/one-click-script "$workbuddy_commit" "$previous_head"
git update-ref -d refs/aamp/one-click-integrated
```

Expected: checked-out files do not change because the exact tested `final_tree` is reused.

- [x] **Step 5: Verify final history and tree identity**

```bash
git log --oneline --reverse origin/main..HEAD
git status --short
git diff --exit-code "$final_tree" 'HEAD^{tree}'
git diff --check origin/main...HEAD
```

Expected: exactly four commits appear in the required order; status is empty; tree comparison and diff check exit 0.

- [x] **Step 6: Perform final focused review**

```bash
rg -n "workbuddy|WorkBuddy|WORKBUDDY_APP_CLI" \
  packages/aamp-acp-bridge \
  packages/aamp-feishu-task-agent \
  docs/AGENT_SETUP.md
rg -n "workbuddy.*login|login.*workbuddy" \
  packages/aamp-feishu-task-agent/bootstrap \
  packages/aamp-feishu-task-agent/bin || true
```

Expected: all WorkBuddy detection uses the standard macOS app path; login-related matches are explanatory copy only and no WorkBuddy login command is executed.
