# WorkBuddy AI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the international WorkBuddy AI macOS application as the distinct canonical Agent type `workbuddy_ai`, with native ACP discovery and the complete Feishu Task Agent one-click lifecycle.

**Architecture:** Insert one historical native ACP commit directly after `8210011`, replay the existing `feat/one-click-script` commits unchanged in order, then amend the reviewed documentation commit into one final integration commit. Keep `workbuddy` and `workbuddy_ai` as separate fixed-path runtimes; reuse current WorkBuddy readiness semantics while keeping product-specific messages.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, ESM JavaScript, Bash 3.2-compatible bootstrap code, Git rebase, ACP through `acpx`.

## Global Constraints

- The canonical persisted, CLI, and displayed value is exactly `workbuddy_ai`.
- Its default mailbox slug is `workbuddy-ai-bridge`; slug derivation does not
  normalize or alias the canonical Agent name.
- Do not accept aliases such as `workbuddy ai`, `workbuddy-ai`, or `workbuddyai`.
- Existing `workbuddy` bindings, commands, messages, and discovery behavior remain compatible.
- WorkBuddy AI detection is macOS-only and checks exactly `/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`.
- Do not search `PATH` for `codebuddy` or `cbc`, and do not fall back between the two WorkBuddy application bundles.
- The WorkBuddy AI ACP command must parse into exactly two words: the full path and `--acp`.
- Do not send a model prompt during discovery or readiness verification.
- Final history has two newly authored feature commits; no package version, dependency, lockfile, publication, push, or pull request change is in scope.
- Preserve unrelated worktrees and the source branch `feat/one-click-script` unchanged.

## File Responsibility Map

- `packages/aamp-acp-bridge/src/agent-resolver.ts`: canonical native Agent registry, fixed application paths, default ACP commands, detection, and warnings.
- `packages/aamp-acp-bridge/test/agent-resolver.test.ts`: native resolver behavior and shell-token round trip.
- `packages/aamp-acp-bridge/test/discovery.test.ts`: distinct discovery candidates.
- `packages/aamp-acp-bridge/test/init.test.ts`: forced and interactive canonical-name handling.
- `packages/aamp-acp-bridge/test/json-init.test.ts`: persisted default WorkBuddy AI ACP command.
- `packages/aamp-acp-bridge/src/agent-bridge.ts`: startup readiness selection and product-specific ACP/authentication errors.
- `packages/aamp-acp-bridge/src/agent-bridge.test.ts`: current runtime readiness regressions.
- `packages/aamp-acp-bridge/README.md`: ACP Bridge setup and runtime contract.
- `docs/AGENT_SETUP.md`: repository-wide connector mapping.
- `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`: one-click validation, discovery, preparation, and command quoting.
- `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`: binding allowlist, persistence validation, and failure guidance.
- `packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs`: WorkBuddy AI one-click behavior without credentials or model calls.
- `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`: existing WorkBuddy-only fixtures remain isolated from the newly installed international app.
- `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`: TraeCode discovery fixtures explicitly exclude both WorkBuddy products.
- `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs`: controller preservation of actionable WorkBuddy AI readiness failures.
- `packages/aamp-feishu-task-agent/README.md`: user-facing canonical value and application setup.
- `docs/superpowers/specs/2026-08-13-workbuddy-ai-integration-design.md`: approved design, folded into the second feature commit.
- `docs/superpowers/plans/2026-08-13-workbuddy-ai-integration.md`: this plan, folded into the second feature commit.

---

### Task 1: Create the historical WorkBuddy AI native ACP commit

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Modify: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Modify: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Modify: `packages/aamp-acp-bridge/test/init.test.ts`
- Modify: `packages/aamp-acp-bridge/README.md`
- Modify: `docs/AGENT_SETUP.md`

**Interfaces:**
- Consumes: the existing `workbuddy` fixed-path resolver at commit `8210011`.
- Produces: exported `WORKBUDDY_AI_APP_CLI`, canonical `KNOWN_AGENTS` entry `workbuddy_ai`, `detectKnownAgent('workbuddy_ai')`, `defaultAcpCommand('workbuddy_ai')`, and `missingAgentWarning('workbuddy_ai')`.

- [ ] **Step 1: Create a temporary native branch at the required parent**

Run:

```bash
git status --short
git switch -c tmp/workbuddy-ai-native 8210011
git log -1 --oneline
```

Expected: clean status and `HEAD` equal to `8210011 feat(acp-bridge): add WorkBuddy ACP support`. The reviewed `feat/workbuddy-ai-support` branch remains at its documentation commit.

- [ ] **Step 2: Write failing resolver and canonical-name tests**

Add the imports and tests below to `packages/aamp-acp-bridge/test/agent-resolver.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import {
  KNOWN_AGENTS,
  WORKBUDDY_AI_APP_CLI,
  WORKBUDDY_APP_CLI,
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../src/agent-resolver.js'

const WORKBUDDY_AI_ACP_COMMAND = `'${WORKBUDDY_AI_APP_CLI}' --acp`

test('registers WorkBuddy and WorkBuddy AI as distinct canonical agents', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy').length, 1)
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy_ai').length, 1)
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.equal(KNOWN_AGENTS.includes(alias), false)
  }
})

test('resolves WorkBuddy AI only from its international macOS bundle', () => {
  const seen: string[] = []
  const resolution = detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathExists: (candidate) => {
      seen.push(candidate)
      return candidate === WORKBUDDY_AI_APP_CLI
    },
    versionFor: () => '2.115.0',
  })

  assert.deepEqual(resolution, {
    command: WORKBUDDY_AI_APP_CLI,
    acpCommand: WORKBUDDY_AI_ACP_COMMAND,
    version: '2.115.0',
  })
  assert.deepEqual(seen, [WORKBUDDY_AI_APP_CLI])
  assert.notEqual(WORKBUDDY_AI_APP_CLI, WORKBUDDY_APP_CLI)
  assert.equal(defaultAcpCommand('workbuddy_ai'), WORKBUDDY_AI_ACP_COMMAND)
})

test('WorkBuddy AI ACP command keeps the application path as one shell word', {
  skip: process.platform === 'win32',
}, () => {
  const resolution = detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathExists: (candidate) => candidate === WORKBUDDY_AI_APP_CLI,
    versionFor: () => '2.115.0',
  })
  assert.ok(resolution)

  const parsed = spawnSync('bash', [
    '-c',
    'eval "set -- $1"; printf "%s\\0" "$@"',
    'bash',
    resolution.acpCommand,
  ], { encoding: 'buffer' })

  assert.equal(parsed.status, 0, parsed.stderr.toString())
  assert.deepEqual(
    parsed.stdout.toString().split('\0').filter(Boolean),
    [WORKBUDDY_AI_APP_CLI, '--acp'],
  )
})

test('WorkBuddy products do not fall back to each other', () => {
  assert.equal(detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathExists: (candidate) => candidate === WORKBUDDY_APP_CLI,
  }), undefined)
  assert.equal(detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathExists: (candidate) => candidate === WORKBUDDY_AI_APP_CLI,
  }), undefined)
})

test('WorkBuddy AI warnings name the international product and exact path', () => {
  assert.equal(
    missingAgentWarning('workbuddy_ai', { platform: 'darwin' }),
    `WorkBuddy AI was not found at ${WORKBUDDY_AI_APP_CLI}.`,
  )
  assert.equal(
    missingAgentWarning('workbuddy_ai', { platform: 'linux' }),
    'WorkBuddy AI auto-detection is only supported on macOS; configure acpCommand explicitly.',
  )
})
```

Update `packages/aamp-acp-bridge/test/discovery.test.ts` with a canonical-candidate test:

```ts
test('exposes both WorkBuddy products as distinct native candidates', () => {
  const ids = discoverAcpBridgeAgents('/definitely/missing/config.json')
    .candidates.map((candidate) => candidate.id)
  assert.equal(ids.filter((id) => id === 'workbuddy').length, 1)
  assert.equal(ids.filter((id) => id === 'workbuddy_ai').length, 1)
})
```

Update `packages/aamp-acp-bridge/test/init.test.ts`:

```ts
test('interactive init accepts both canonical WorkBuddy products', () => {
  assert.deepEqual(resolveInitScanTargets('workbuddy'), ['workbuddy'])
  assert.deepEqual(resolveInitScanTargets('workbuddy_ai'), ['workbuddy_ai'])
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.throws(
      () => resolveInitScanTargets(alias),
      new RegExp(`Unknown ACP agent "${alias}"`),
    )
  }
  assert.match(noAgentsFoundMessage('workbuddy_ai'), /WorkBuddy AI/)
})
```

- [ ] **Step 3: Run the native tests and verify RED**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/agent-resolver.test.ts test/discovery.test.ts test/init.test.ts
```

Expected: FAIL because `WORKBUDDY_AI_APP_CLI` is not exported and `workbuddy_ai` is not registered.

- [ ] **Step 4: Implement the minimal historical resolver**

In `packages/aamp-acp-bridge/src/agent-resolver.ts`, keep the existing WorkBuddy command unchanged and add this fixed international command:

```ts
export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_APP_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`
export const WORKBUDDY_AI_APP_CLI = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_AI_APP_ACP_COMMAND = `'${WORKBUDDY_AI_APP_CLI}' --acp`

export const KNOWN_AGENTS: readonly string[] = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'traex', 'workbuddy', 'workbuddy_ai',
]

function workbuddyApp(name: string): {
  cli: string
  acpCommand: string
  displayName: string
} | undefined {
  if (name === 'workbuddy') {
    return {
      cli: WORKBUDDY_APP_CLI,
      acpCommand: WORKBUDDY_APP_ACP_COMMAND,
      displayName: 'WorkBuddy',
    }
  }
  if (name === 'workbuddy_ai') {
    return {
      cli: WORKBUDDY_AI_APP_CLI,
      acpCommand: WORKBUDDY_AI_APP_ACP_COMMAND,
      displayName: 'WorkBuddy AI',
    }
  }
  return undefined
}
```

Extend `baseAcpCommand` without changing the existing WorkBuddy fallback:

```ts
function baseAcpCommand(name: string): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex') return 'traex acp serve'
  if (name === 'workbuddy_ai') return WORKBUDDY_AI_APP_ACP_COMMAND
  return name
}
```

Replace the single-name detection branch with:

```ts
  const workbuddy = workbuddyApp(name)
  if (workbuddy) {
    if (platform !== 'darwin' || !pathExists(workbuddy.cli)) return undefined
    return {
      command: workbuddy.cli,
      acpCommand: workbuddy.acpCommand,
      version: versionFor(workbuddy.cli),
    }
  }
```

Replace the WorkBuddy-specific warning branches with:

```ts
  const workbuddy = workbuddyApp(name)
  if (workbuddy && platform === 'darwin') {
    return `${workbuddy.displayName} was not found at ${workbuddy.cli}.`
  }
  if (workbuddy) {
    return `${workbuddy.displayName} auto-detection is only supported on macOS; configure acpCommand explicitly.`
  }
```

Do not add a PATH lookup or alias normalization.

- [ ] **Step 5: Run the targeted tests and verify GREEN**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/agent-resolver.test.ts test/discovery.test.ts test/init.test.ts
```

Expected: all selected tests PASS, including the two-word shell parse assertion.

- [ ] **Step 6: Document the native contract**

Add this row to the known-Agent table in `docs/AGENT_SETUP.md`:

```markdown
| `workbuddy_ai` | macOS WorkBuddy AI app embedded `'codebuddy' --acp` |
```

Add this exact path and command below the existing WorkBuddy setup:

```markdown
WorkBuddy AI is a separate canonical Agent, `workbuddy_ai`, detected only at:
`/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`.
Because the application path contains a space, its generated ACP command quotes
the executable path before appending `--acp`. It does not fall back to
`WorkBuddy.app`, `codebuddy`, or `cbc` on `PATH`.
```

Add a `### WorkBuddy AI` section to `packages/aamp-acp-bridge/README.md` with:

````markdown
### WorkBuddy AI

The international macOS application is a separate canonical Agent:

```text
workbuddy_ai
```

It is detected only at:

```text
/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

`init --agent workbuddy_ai` uses:

```text
'/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp
```

WorkBuddy and WorkBuddy AI are discovered independently and may both be
configured. Open WorkBuddy AI and sign in before starting its bridge.
````

- [ ] **Step 7: Verify the historical package**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build
git diff --check
```

Expected: all historical ACP tests pass, TypeScript exits 0, and `git diff --check` prints nothing.

- [ ] **Step 8: Commit native support directly after `8210011`**

Run:

```bash
git add -- \
  docs/AGENT_SETUP.md \
  packages/aamp-acp-bridge/README.md \
  packages/aamp-acp-bridge/src/agent-resolver.ts \
  packages/aamp-acp-bridge/test/agent-resolver.test.ts \
  packages/aamp-acp-bridge/test/discovery.test.ts \
  packages/aamp-acp-bridge/test/init.test.ts
git diff --cached --check
git commit -m "feat(acp-bridge): add WorkBuddy AI native support"
git log -2 --oneline
```

Expected: the new commit is immediately above `8210011` and contains only the six listed files.

---

### Task 2: Replay `feat/one-click-script` after native support

**Files:**
- Resolve if conflicted: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Resolve if conflicted: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Resolve if conflicted: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Resolve if conflicted: `packages/aamp-acp-bridge/test/init.test.ts`
- Resolve if conflicted: `packages/aamp-acp-bridge/README.md`
- Resolve if conflicted: `docs/AGENT_SETUP.md`

**Interfaces:**
- Consumes: `tmp/workbuddy-ai-native` and the reviewed `feat/workbuddy-ai-support` documentation commit.
- Produces: a linear final branch whose current resolver retains all later TraeCode/path-executable behavior plus both WorkBuddy products.

- [ ] **Step 1: Rebase the final branch onto the native commit**

Run:

```bash
native_commit="$(git rev-parse tmp/workbuddy-ai-native)"
git switch feat/workbuddy-ai-support
git rebase --onto "$native_commit" 8210011
```

Expected: Git replays the eleven existing source commits followed by the reviewed documentation commit. Overlapping resolver and documentation commits may stop for conflict resolution.

- [ ] **Step 2: Resolve every stopped commit to the current combined contract**

For `packages/aamp-acp-bridge/src/agent-resolver.ts`, the resolved current code must retain executable-file validation and have these mappings:

```ts
export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_APP_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`
export const WORKBUDDY_AI_APP_CLI = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
const WORKBUDDY_AI_APP_ACP_COMMAND = `'${WORKBUDDY_AI_APP_CLI}' --acp`

export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'traecli',
  'hermes', 'traex', 'workbuddy', 'workbuddy_ai',
] as const

function workbuddyApp(name: string) {
  if (name === 'workbuddy') {
    return { cli: WORKBUDDY_APP_CLI, acpCommand: WORKBUDDY_APP_ACP_COMMAND, displayName: 'WorkBuddy' }
  }
  if (name === 'workbuddy_ai') {
    return { cli: WORKBUDDY_AI_APP_CLI, acpCommand: WORKBUDDY_AI_APP_ACP_COMMAND, displayName: 'WorkBuddy AI' }
  }
  return undefined
}

export function defaultAgentCommand(name: string): string {
  return workbuddyApp(name)?.cli ?? name
}

function baseAcpCommand(name: string, command = defaultAgentCommand(name)): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex' || name === 'traecli') return `${command} acp serve`
  return workbuddyApp(name)?.acpCommand ?? name
}
```

The current `detectKnownAgent` and `missingAgentWarning` use `workbuddyApp(name)` exactly as Task 1, but call `pathIsExecutable` instead of the historical `pathExists`. Keep all current TraeCode, Windows PATH, explicit-command, and blank-command behavior.

For each conflict:

```bash
git status --short
git add -- <resolved-files>
git rebase --continue
```

Use `GIT_EDITOR=true git rebase --continue` if Git requests an editor. Do not skip or squash any of the eleven source commits.

- [ ] **Step 3: Verify replay order and semantic preservation**

Run:

```bash
native_commit="$(git rev-parse tmp/workbuddy-ai-native)"
git log --reverse --format='%h %s' 8210011..HEAD
diff -u \
  <(git log --reverse --format='%s' 8210011..feat/one-click-script) \
  <(git log --reverse --format='%s' "$native_commit"..HEAD^)
git range-diff 8210011..feat/one-click-script "$native_commit"..HEAD^
```

Expected: native support is first, the next eleven subjects match the source branch exactly and in order, the reviewed documentation commit is last, and range-diff reports the source commits as matched. Any displayed patch delta is limited to conflict context needed to retain `workbuddy_ai`.

- [ ] **Step 4: Re-run the current ACP baseline after replay**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build
```

Expected: the current ACP suite and TypeScript build pass before adding readiness behavior.

---

### Task 3: Extend current ACP readiness and persistence coverage

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-bridge.ts`
- Modify: `packages/aamp-acp-bridge/src/agent-bridge.test.ts`
- Modify: `packages/aamp-acp-bridge/test/json-init.test.ts`

**Interfaces:**
- Consumes: final current resolver mapping for `workbuddy_ai`.
- Produces: `requiresStartupReadinessProbe`, `formatAgentReadinessError`, and `formatTaskAgentError` behavior for both WorkBuddy products.

- [ ] **Step 1: Write failing WorkBuddy AI readiness tests**

Add to `packages/aamp-acp-bridge/src/agent-bridge.test.ts`:

```ts
test('both WorkBuddy products require the startup ACP readiness probe', () => {
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'workbuddy_ai' }), true)
  assert.equal(requiresStartupReadinessProbe({ name: 'traex' }), false)
  assert.equal(requiresStartupReadinessProbe({ name: 'codex' }), false)
})

test('WorkBuddy AI authentication failures name the international app', () => {
  const failure = new Error('acpx failed (1): stderr: Authentication required')
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', failure),
    'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
  )
  assert.equal(
    formatTaskAgentError('workbuddy_ai', failure),
    'WorkBuddy AI login expired. Open WorkBuddy AI and sign in, then retry the task.',
  )
  assert.equal(
    formatAgentReadinessError('workbuddy_ai', new Error('ACP readiness probe timed out after 15000ms')),
    'WorkBuddy AI ACP readiness check failed: ACP readiness probe timed out after 15000ms',
  )
})
```

Replace the old single-product readiness test rather than retaining duplicate assertions.

- [ ] **Step 2: Run the readiness test and verify RED**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test src/agent-bridge.test.ts
```

Expected: FAIL because `workbuddy_ai` does not yet require the probe and returns raw authentication errors.

- [ ] **Step 3: Implement product-aware readiness behavior**

In `packages/aamp-acp-bridge/src/agent-bridge.ts`, add and use this helper:

```ts
function workbuddyProductName(agentName: string): string | undefined {
  const normalized = agentName.trim().toLowerCase()
  if (normalized === 'workbuddy') return 'WorkBuddy'
  if (normalized === 'workbuddy_ai') return 'WorkBuddy AI'
  return undefined
}

export function requiresStartupReadinessProbe(agent: Pick<AgentConfig, 'name'>): boolean {
  return workbuddyProductName(agent.name) !== undefined
}

export function formatAgentReadinessError(agentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const productName = workbuddyProductName(agentName)
  if (productName) {
    if (ACP_AUTH_FAILURE_PATTERN.test(message)) {
      return `${productName} is not logged in. Open ${productName} and sign in, then retry.`
    }
    return `${productName} ACP readiness check failed: ${message}`
  }
  return message
}

export function formatTaskAgentError(agentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const productName = workbuddyProductName(agentName)
  if (productName && ACP_AUTH_FAILURE_PATTERN.test(message)) {
    return `${productName} login expired. Open ${productName} and sign in, then retry the task.`
  }
  return message
}
```

- [ ] **Step 4: Verify readiness GREEN**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test src/agent-bridge.test.ts
```

Expected: all readiness and existing AgentBridge tests PASS.

- [ ] **Step 5: Add current JSON persistence coverage**

Import `WORKBUDDY_AI_APP_CLI` and `loadConfig` in
`packages/aamp-acp-bridge/test/json-init.test.ts` and add:

```ts
test('JSON init supplies the quoted native WorkBuddy AI ACP command', async () => {
  await withCredentials('workbuddy_ai', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'workbuddy_ai', credentialsFile }],
    })

    const command = `'${WORKBUDDY_AI_APP_CLI}' --acp`
    assert.equal(result.agents[0].acpCommand, command)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'workbuddy_ai')
    assert.equal(written.agents[0].acpCommand, command)
    assert.equal(written.agents[0].slug, 'workbuddy-ai-bridge')
    const loaded = loadConfig(configPath)
    assert.equal(loaded.agents[0].name, 'workbuddy_ai')
    assert.equal(loaded.agents[0].slug, 'workbuddy-ai-bridge')
    assert.equal(loaded.agents[0].acpCommand, command)
  })
})
```

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/json-init.test.ts
```

Expected: PASS using the native command already established by Task 1.

---

### Task 4: Add WorkBuddy AI to the Feishu Task Agent one-click flow

**Files:**
- Create: `packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/README.md`

**Interfaces:**
- Consumes: canonical `workbuddy_ai`, fixed WorkBuddy AI CLI path, `acp_command_word`, and product-aware ACP readiness errors.
- Produces: literal one-click discovery/persistence/display and a quoted `acp_command` returned by `__prepare-agent`.

- [ ] **Step 1: Create the focused failing one-click test**

Create `packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs` with:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function workbuddyFunctions(source) {
  return [
    functionRange(source, 'validate_agent_name()', 'read_tty_line()'),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
    functionRange(source, 'ensure_agent_login()', 'run_acp_bridge()'),
    functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()'),
  ].join('\n')
}

test('discovers both WorkBuddy products and quotes WorkBuddy AI without invoking either CLI', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-workbuddy-ai-bootstrap-'))
  const workbuddyCli = path.join(root, 'WorkBuddy.app', 'codebuddy')
  const workbuddyAiCli = path.join(root, 'WorkBuddy AI.app', 'codebuddy')
  const callLog = path.join(root, 'calls.log')
  for (const cli of [workbuddyCli, workbuddyAiCli]) {
    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\n`)
    chmodSync(cli, 0o755)
  }

  const result = runShell([
    'set -euo pipefail',
    'WORKBUDDY_APP_CLI="$1"',
    'WORKBUDDY_AI_APP_CLI="$2"',
    'AGENT="workbuddy_ai"',
    'DETECTED_AGENTS=()',
    'ACP_AGENT_COMMAND=""',
    'is_macos() { return 0; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_traex_cli() { return 1; }',
    'find_legacy_trae_cli() { return 1; }',
    'find_traecode_cli() { return 1; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    workbuddyFunctions(source),
    'validate_agent_name workbuddy_ai',
    'discover_interactive_agents',
    'ensure_agent_cli',
    'ensure_agent_login',
    'build_acp_agent_command',
    'eval "set -- $ACP_AGENT_COMMAND"',
    'printf "%s|%s|%s" "${DETECTED_AGENTS[*]}" "$1" "$2"',
  ], [workbuddyCli, workbuddyAiCli])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `workbuddy workbuddy_ai|${workbuddyAiCli}|--acp`)
  assert.equal(existsSync(callLog), false)
})

test('WorkBuddy AI preparation reports unsupported platform and its exact missing bundle', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helpers = [
    functionRange(source, 'find_workbuddy_cli()', 'resolve_cursor_cli_for_acp()'),
    functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()'),
  ].join('\n')
  const common = [
    'set -euo pipefail',
    'AGENT="workbuddy_ai"',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'ensure_codem_local_bin_on_path() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    helpers,
    'ensure_agent_cli',
  ]

  const unsupported = runShell([
    'WORKBUDDY_AI_APP_CLI="/Applications/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 1; }',
    ...common,
  ])
  assert.equal(unsupported.status, 64)
  assert.match(unsupported.stderr, /WorkBuddy AI.*macOS/)

  const missing = runShell([
    'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
    'is_macos() { return 0; }',
    ...common,
  ])
  assert.equal(missing.status, 64)
  assert.match(missing.stderr, /\/Applications\/WorkBuddy AI\.app/)
})

test('bootstrap and controller expose only the canonical workbuddy_ai spelling', () => {
  const bootstrapSource = readFileSync(bootstrap, 'utf8')
  const controllerSource = readFileSync(controller, 'utf8')
  assert.match(bootstrapSource, /codex\|cursor\|coco\|traex\|traecli\|workbuddy\|workbuddy_ai/)
  assert.match(controllerSource, /const AGENT_TYPES = \[[^\]]*'workbuddy_ai'/)
  const failureSource = functionRange(
    controllerSource,
    'function agentFailureMessage(',
    'function resolvePreparedAgentBindings(',
  )
  const agentFailureMessage = new Function(`${failureSource}\nreturn agentFailureMessage;`)()
  assert.equal(
    agentFailureMessage('workbuddy_ai', 'bridge exited'),
    'bridge exited\n如果尚未登录，请打开 WorkBuddy AI 完成登录后重试。',
  )
  assert.equal(
    agentFailureMessage(
      'workbuddy_ai',
      'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
    ),
    'WorkBuddy AI is not logged in. Open WorkBuddy AI and sign in, then retry.',
  )
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.doesNotMatch(bootstrapSource, new RegExp(`\\|${alias.replace('-', '\\-')}\\|`))
  }
})

test('a pending workbuddy_ai binding is accepted and displayed verbatim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-workbuddy-ai-'))
  const stateHome = path.join(root, 'state')
  const runtimeHome = path.join(stateHome, 'runtime-v1')
  const bindingId = '33333333-3333-4333-8333-333333333333'
  const configFile = path.join(stateHome, 'bindings-v1.json')
  mkdirSync(stateHome, { recursive: true })
  writeFileSync(configFile, `${JSON.stringify({
    schema: 'aamp.feishu-task-agent.bindings',
    version: 1,
    bindings: [{
      binding_id: bindingId,
      agent_type: 'workbuddy_ai',
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: {
        app_id: 'cli_workbuddy_ai_test',
        app_secret: 'workbuddy-ai-test-only-secret',
        lark_cli_profile: 'workbuddy-ai-test-profile',
      },
      feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
      state: 'pending',
    }],
  }, null, 2)}\n`)

  const result = spawnSync(process.execPath, [controller, 'list'], {
    env: {
      ...process.env,
      HOME: root,
      AAMP_TASK_STATE_HOME: stateHome,
      AAMP_TASK_CONFIG_FILE: configFile,
      AAMP_TASK_RUNTIME_HOME: runtimeHome,
      AAMP_RUN_LOG_DIR: path.join(root, 'logs'),
    },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /workbuddy_ai/)
  assert.doesNotMatch(result.stdout, /workbuddy-ai-test-only-secret/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/workbuddy-ai-one-click.test.mjs
```

Expected: FAIL because `workbuddy_ai` is absent from bootstrap validation, discovery, controller validation, and product-specific guidance.

- [ ] **Step 3: Implement bootstrap discovery and preparation**

Add beside `WORKBUDDY_APP_CLI`:

```bash
WORKBUDDY_AI_APP_CLI="/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

Extend every literal Agent list in usage, `validate_agent_name`, and noninteractive guidance with `workbuddy_ai` after `workbuddy`.

Use these exact validation and discovery-failure messages:

```bash
validate_agent_name() {
  case "$1" in
    codex|cursor|coco|traex|traecli|workbuddy|workbuddy_ai) ;;
    *) agent_fail "--agent must be codex, cursor, coco, traex, traecli, workbuddy, or workbuddy_ai" ;;
  esac
}

agent_fail "暂未检测到本地智能体。请先安装 Codex、Cursor、Trae CLI、WorkBuddy 或 WorkBuddy AI 后重试。"
agent_fail "missing --agent and no interactive terminal is available; pass --agent codex|cursor|coco|traex|traecli|workbuddy|workbuddy_ai"
```

Add this function immediately after `find_workbuddy_cli`:

```bash
find_workbuddy_ai_cli() {
  is_macos || return 1
  [ -x "$WORKBUDDY_AI_APP_CLI" ] || return 1
  printf '%s\n' "$WORKBUDDY_AI_APP_CLI"
}
```

Add this `agent_cli_detected` case:

```bash
    workbuddy_ai)
      find_workbuddy_ai_cli >/dev/null 2>&1
      ;;
```

Add this independent block immediately after the existing WorkBuddy block in both `discover_interactive_agents` and `run_internal_discover_agents`:

```bash
  if agent_cli_detected workbuddy_ai; then
    DETECTED_AGENTS+=("workbuddy_ai")
  fi
```

For `run_internal_discover_agents`, use its local array name:

```bash
  if agent_cli_detected workbuddy_ai; then
    agents+=("workbuddy_ai")
  fi
```

Add the exact `ensure_agent_cli` branch:

```bash
  if [ "$AGENT" = "workbuddy_ai" ]; then
    is_macos || agent_fail "WorkBuddy AI 一键探测仅支持 macOS。"
    find_workbuddy_ai_cli >/dev/null 2>&1 \
      || agent_fail "未检测到 WorkBuddy AI CLI：${WORKBUDDY_AI_APP_CLI}。请确认该文件存在且可执行后重新运行脚本。"
    return 0
  fi
```

Add an `ensure_agent_login` case that performs no CLI call:

```bash
    workbuddy_ai)
      agent_detail "WorkBuddy AI authentication is managed by the desktop app"
      ;;
```

Add this `build_acp_agent_command` branch after the existing WorkBuddy branch:

```bash
  if [ "$AGENT" = "workbuddy_ai" ]; then
    local workbuddy_ai_bin workbuddy_ai_word
    workbuddy_ai_bin="$(find_workbuddy_ai_cli)" \
      || agent_fail "WorkBuddy AI CLI 不可用：${WORKBUDDY_AI_APP_CLI}。请确认该文件存在且可执行。"
    workbuddy_ai_word="$(acp_command_word "$workbuddy_ai_bin")" \
      || agent_fail "WorkBuddy AI 路径包含不受支持的换行符。"
    ACP_AGENT_COMMAND="$workbuddy_ai_word --acp"
    agent_detail "using native WorkBuddy AI ACP command: $ACP_AGENT_COMMAND"
    return 0
  fi
```

Do not quote or otherwise change the existing WorkBuddy command in this task.

- [ ] **Step 4: Implement controller validation and product guidance**

Change the allowlist and validation text to:

```js
const AGENT_TYPES = ['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy', 'workbuddy_ai'];

if (!AGENT_TYPES.includes(binding.agent_type)) {
  throw new Error(`bindings[${index}].agent_type 仅支持 codex/cursor/coco/traex/traecli/workbuddy/workbuddy_ai`);
}
```

Replace `agentFailureMessage` with:

```js
function agentFailureMessage(agentType, message) {
  const text = String(message || 'Agent Bridge 启动失败');
  if (agentType === 'traecli') {
    return `${text}\n请执行 'traecli doctor --json' 检查 TraeCode CLI，修复后重试。`;
  }
  const productName = agentType === 'workbuddy'
    ? 'WorkBuddy'
    : agentType === 'workbuddy_ai'
      ? 'WorkBuddy AI'
      : '';
  if (!productName) return text;
  if (text.startsWith(`${productName} is not logged in.`)
    || text.startsWith(`${productName} login expired.`)) return text;
  return `${text}\n如果尚未登录，请打开 ${productName} 完成登录后重试。`;
}
```

Update the no-Agent error to name both products:

```js
if (!agents.length) {
  throw new Error('暂未检测到本地智能体。请先安装 Codex、Cursor、Trae CLI、TraeCode CLI、WorkBuddy 或 WorkBuddy AI 后重试。');
}
```

- [ ] **Step 5: Extend controller-network source coverage**

In `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs`, keep the existing WorkBuddy assertions and add:

```js
assert.match(controller, /agentType === 'workbuddy_ai'/)
assert.match(controller, /打开 \$\{productName\} 完成登录后重试/)
```

Replace the obsolete implementation-shape assertion:

```js
assert.match(controller, /WorkBuddy \(\?:is not logged in\|login expired\)/)
```

with product-aware prefix assertions:

```js
assert.match(controller, /text\.startsWith\(`\$\{productName\} is not logged in\.`\)/)
assert.match(controller, /text\.startsWith\(`\$\{productName\} login expired\.`\)/)
```

This locks in routing through the same immediate Agent-failure path without duplicating the network retry implementation.

- [ ] **Step 6: Keep existing discovery fixtures product-isolated**

In every shell fixture in `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs` that defines `WORKBUDDY_APP_CLI`, also define:

```js
'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
```

This keeps existing WorkBuddy assertions stable even when WorkBuddy AI is installed on the test machine.

Replace that file's old literal controller-message assertion with:

```js
assert.match(source, /如果尚未登录，请打开 \$\{productName\} 完成登录后重试/)
```

In both discovery fixture builders in `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`, add this stub beside `find_workbuddy_cli`:

```js
'find_workbuddy_ai_cli() { return 1; }',
```

In TraeCode preparation fixtures that define `WORKBUDDY_APP_CLI`, also define:

```js
'WORKBUDDY_AI_APP_CLI="/missing/WorkBuddy AI.app/codebuddy"',
```

These are test-fixture changes only; they do not introduce aliases or fallback behavior.

Extend the canonical display regression in that file to exercise the new literal value:

```js
for (const agent of ['codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy', 'workbuddy_ai']) {
  assert.equal(values.agentSelectionDisplayName(agent), agent)
  assert.equal(values.agentBindingDisplayName(agent), agent)
}
```

- [ ] **Step 7: Document the Task Agent contract**

Update `packages/aamp-feishu-task-agent/README.md` so canonical values and usage include `workbuddy_ai`, then add:

```markdown
`workbuddy_ai` is the international WorkBuddy AI application. It is detected
only at
`/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`.
Its persisted and displayed Agent type remains the literal `workbuddy_ai`.
When both WorkBuddy applications are installed, `workbuddy` and
`workbuddy_ai` are offered independently. The Task Agent does not run a login
command for either product; complete login in the selected desktop app.
```

- [ ] **Step 8: Verify the focused test GREEN**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/workbuddy-ai-one-click.test.mjs
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
```

Expected: four focused tests PASS and Bash syntax validation exits 0.

- [ ] **Step 9: Run the full Task Agent suite**

Run:

```bash
cd packages/aamp-feishu-task-agent
npm test
```

Expected: all existing 201 tests plus the new WorkBuddy AI tests pass with zero failures.

---

### Task 5: Form the second feature commit and verify the complete branch

**Files:**
- Amend: all files listed in Tasks 3 and 4
- Retain in amend: `docs/superpowers/specs/2026-08-13-workbuddy-ai-integration-design.md`
- Retain in amend: `docs/superpowers/plans/2026-08-13-workbuddy-ai-integration.md`

**Interfaces:**
- Consumes: green ACP and Task Agent implementations plus the replayed documentation commit.
- Produces: final two-feature-commit history and verified local integration.

- [ ] **Step 1: Inspect and stage only the remaining integration files**

Run:

```bash
git status --short
git diff --check
git diff --stat
git add -- \
  packages/aamp-acp-bridge/src/agent-bridge.ts \
  packages/aamp-acp-bridge/src/agent-bridge.test.ts \
  packages/aamp-acp-bridge/test/json-init.test.ts \
  packages/aamp-feishu-task-agent/README.md \
  packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs \
  packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs \
  packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs \
  packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs
git diff --cached --check
git diff --cached --name-only
```

Expected: only the ten listed implementation/test files are newly staged; the already committed design and plan remain part of `HEAD`.

- [ ] **Step 2: Amend the documentation commit into the second feature commit**

Run:

```bash
git commit --amend -m "feat(task-agent): add WorkBuddy AI integration"
```

Expected: `HEAD` contains the approved design, implementation plan, current ACP readiness changes, and Task Agent integration in one commit.

- [ ] **Step 3: Run fresh complete verification**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build

cd ../aamp-feishu-task-agent
npm test
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh

cd ../..
git diff --check feat/one-click-script HEAD
git status --short
```

Expected: ACP tests pass, TypeScript builds, Task Agent tests pass, Bash syntax is valid, diff check prints nothing, and status is clean.

- [ ] **Step 4: Verify live discovery against both installed applications**

Run:

```bash
discovery_tmp_dir="$(mktemp -d)"
node packages/aamp-acp-bridge/dist/index.js discover \
  --config "$discovery_tmp_dir/missing.json" \
  --json |
node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  const byId = new Map(data.candidates.map((candidate) => [candidate.id, candidate]));
  const workbuddy = byId.get("workbuddy");
  const workbuddyAi = byId.get("workbuddy_ai");
  if (!workbuddy?.detected || !workbuddyAi?.detected) process.exit(1);
  if (workbuddyAi.command !== "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy") process.exit(2);
  const quote = String.fromCharCode(39);
  const expectedCommand = `${quote}/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy${quote} --acp`;
  if (workbuddyAi.acpCommand !== expectedCommand) process.exit(3);
  process.stdout.write("workbuddy,workbuddy_ai detected\n");
});
'
rmdir "$discovery_tmp_dir"
```

Expected: prints `workbuddy,workbuddy_ai detected` and exits 0 without creating credentials or sending a prompt.

- [ ] **Step 5: Run a no-prompt WorkBuddy AI ACP readiness smoke test**

Run from the worktree root so session creation and cleanup use the exact same cwd:

```bash
workbuddy_ai_command="'/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp"
workbuddy_ai_session="aamp-workbuddy-ai-smoke-$(date +%s)"
acpx --approve-all --cwd "$PWD" --timeout 20 \
  --agent "$workbuddy_ai_command" \
  sessions new --name "$workbuddy_ai_session"
acpx --approve-all --cwd "$PWD" --timeout 20 \
  --agent "$workbuddy_ai_command" \
  sessions close "$workbuddy_ai_session"
```

Expected: a fresh session is created and closed without a model prompt. If desktop authentication is unavailable, preserve the exact error as an unresolved local-environment validation item and do not claim end-to-end readiness.

- [ ] **Step 6: Verify final commit topology and scope**

Run:

```bash
native_commit="$(git rev-list --reverse 8210011..HEAD | sed -n '1p')"
git log --reverse --format='%h %s' 8210011..HEAD
test "$(git rev-parse "$native_commit^")" = "$(git rev-parse 8210011)"
test "$(git show -s --format='%s' "$native_commit")" = "feat(acp-bridge): add WorkBuddy AI native support"
test "$(git show -s --format='%s' HEAD)" = "feat(task-agent): add WorkBuddy AI integration"
diff -u \
  <(git log --reverse --format='%s' 8210011..feat/one-click-script) \
  <(git log --reverse --format='%s' "$native_commit"..HEAD^)
git diff --name-only feat/one-click-script HEAD
git diff --name-only feat/one-click-script HEAD | rg '(^|/)package(-lock)?\.json$' && exit 1 || true
git status --short
```

Expected: the native commit directly follows `8210011`; the eleven source subjects match in order; the integration commit is last; only WorkBuddy AI source, test, and documentation files differ from `feat/one-click-script`; no package manifest/lockfile differs; status is clean.

- [ ] **Step 7: Remove the merged temporary branch pointer**

Run:

```bash
git branch -d tmp/workbuddy-ai-native
```

Expected: Git confirms deletion because the native commit is already an ancestor of `feat/workbuddy-ai-support`. Do not remove the worktree or push the branch.
