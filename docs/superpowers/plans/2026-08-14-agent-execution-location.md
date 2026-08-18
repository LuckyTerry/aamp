# Local and Remote Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit local-versus-remote Agent execution contract so Aime can use its remote-native Feishu/Lark capabilities without inheriting caller-local `lark-cli`, profile, cwd, shell, or file requirements.

**Architecture:** A shared Task Agent metadata module classifies known Agents once, with local as the default policy and Aime as remote. The one-click controller writes matching trusted execution-location values into `aamp-acp-bridge` and the Task runtime inside the merged `aamp-feishu-bridge`; each bridge independently enforces the remote prompt, attachment, delivery, and diagnostic boundaries from trusted config rather than incoming Task data.

**Tech Stack:** Node.js ESM, TypeScript 5, Zod, Node test runner, tsx, Bash, ACP/acpx, AAMP SDK, Feishu Node SDK.

**Spec:** `docs/superpowers/specs/2026-08-14-agent-execution-location-design.md`

## Global Constraints

- `AgentExecutionLocation` has exactly two values: `local` and `remote`.
- Missing execution location defaults to `local` in bridge configuration migrations.
- Aime resolves to `remote`, `attachmentPolicy: "reject"`, and `taskDispatchConcurrency: 1` from one shared Task Agent metadata source.
- Execution location is trusted receiver configuration and must never be accepted from Task body, prompt rules, or `dispatchContext`.
- Remote Aime may use its own remote-native identity and tools to read Feishu/Lark data; one-click must not provision or copy those credentials.
- Only `aamp-feishu-bridge` writes comments, status, and deliveries for the current Feishu Task.
- Remote input attachments, `FILE:/...` attachment markers, and `file_delivery` fail closed before caller filesystem access.
- Text delivery and HTTP(S) link delivery remain supported for remote Agents.
- Local Agent prompt, attachment, cwd, and `lark-cli` behavior remains compatible.
- Do not modify, test, publish, or depend on `packages/aamp-feishu-task-bridge`; it is deprecated and merged into `packages/aamp-feishu-bridge`.
- Do not change `packages/aime-acp` behavior unless a new regression proves the existing remote adapter contract is insufficient.
- Do not change package versions, lockfiles, registry pins, or publish any package in this implementation.
- Preserve the pre-existing user-owned executable-mode change on `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`; do not include that mode change in any feature commit.
- Never place App Secrets, tokens, full prompts, raw acpx commands, caller cwd, or local executable paths in argv, Task comments, or unredacted diagnostics.

---

## File and Responsibility Map

### New files

- `packages/aamp-feishu-task-agent/bin/agent-metadata.mjs` — canonical known-Agent metadata and a JSON query entrypoint shared by bootstrap and controller.
- `packages/aamp-feishu-task-agent/test/agent-metadata.test.mjs` — metadata, import safety, and JSON query contract.
- `packages/aamp-feishu-bridge/src/private-json.ts` — atomic mode-`0600` JSON writer for secret-bearing merged-bridge runtime files.
- `packages/aamp-feishu-bridge/src/private-json.test.ts` — file mode, replacement, and cleanup contract.
- `packages/aamp-feishu-bridge/src/task-runtime-profile.test.ts` — local `lark-cli` versus remote app-secret profile normalization.
- `packages/aamp-feishu-bridge/src/task/config.test.ts` — Task runtime Agent descriptor migration and current-package error copy.

### Modified files

- `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs` — consume shared metadata, validate remote bindings without profile, configure both bridges, and branch Feishu startup.
- `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh` — query shared metadata, skip remote `lark-cli` setup, and register app-secret Bot profiles.
- `packages/aamp-feishu-task-agent/test/aime-one-click.test.mjs` — remote Aime setup and startup regression.
- `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs` — legacy Aime profile tolerance and local profile requirement.
- `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs` — bootstrap metadata query and no-`lark-cli` remote path.
- `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs` — local-Agent metadata compatibility.
- `packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs` — local-Agent metadata compatibility.
- `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs` — source-extracted controller helpers receive the shared Agent list.
- `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs` — source-extracted controller helpers receive the shared Agent list.
- `packages/aamp-acp-bridge/src/config.ts` — trusted execution-location schema and remote attachment-policy validation.
- `packages/aamp-acp-bridge/src/json-init.ts` — JSON init/update preservation.
- `packages/aamp-acp-bridge/src/cli/init.ts` — local default for directly initialized Agents.
- `packages/aamp-acp-bridge/src/prompt-builder.ts` — local and remote default prompt policies.
- `packages/aamp-acp-bridge/src/agent-bridge.ts` — pass trusted prompt options, reject remote artifacts, and sanitize errors/debug output.
- `packages/aamp-acp-bridge/test/config.test.ts` — schema defaults and invalid remote combination.
- `packages/aamp-acp-bridge/test/json-init.test.ts` — init and update persistence.
- `packages/aamp-acp-bridge/src/prompt-builder.test.ts` — local compatibility and remote negative assertions.
- `packages/aamp-acp-bridge/src/agent-bridge.test.ts` — no-filesystem remote result and safe diagnostic behavior.
- `packages/aamp-acp-bridge/test/aime-packaged.test.ts` — real packaged first-turn/follow-up remote prompt contract.
- `packages/aamp-acp-bridge/test/aime-packaged-harness.ts` — pass explicit remote Agent configuration and record sanitized prompt evidence.
- `packages/aamp-feishu-bridge/src/task/types.ts` — trusted Task runtime Agent descriptor.
- `packages/aamp-feishu-bridge/src/task/config.ts` — legacy local migration and current merged-package error guidance.
- `packages/aamp-feishu-bridge/src/task-runtime-profile.ts` — app-secret and `lark-cli` authentication modes.
- `packages/aamp-feishu-bridge/src/task-runtime.ts` — CLI/runtime execution-location propagation and private JSON writes.
- `packages/aamp-feishu-bridge/src/index.ts` — parse `--agent-execution-location`.
- `packages/aamp-feishu-bridge/src/task/dispatch.ts` — invariant plus local/remote prompt composition.
- `packages/aamp-feishu-bridge/src/task/dispatch.test.ts` — prompt parity and remote exclusions.
- `packages/aamp-feishu-bridge/src/task/runtime.ts` — remote delivery enforcement and Task-visible error sanitization.
- `packages/aamp-feishu-bridge/src/task/runtime.test.ts` — remote result, error, first-turn, and follow-up behavior.
- `packages/aamp-feishu-bridge/src/task-runtime.test.ts` — CLI/config persistence and legacy migration.
- `packages/aamp-feishu-task-agent/README.md` — one-click local/remote behavior.
- `packages/aamp-acp-bridge/README.md` — execution-location configuration contract.
- `packages/aamp-feishu-bridge/README.md` — merged Task runtime option and app-secret mode.
- `docs/aime-acp/e2e-report.md` — retain `NOT RUN` until the exact live remote group-summary gate is executed.

---

### Task 1: Centralize Task Agent execution metadata

**Files:**
- Create: `packages/aamp-feishu-task-agent/bin/agent-metadata.mjs`
- Create: `packages/aamp-feishu-task-agent/test/agent-metadata.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:73`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`

**Interfaces:**
- Consumes: canonical Agent names already accepted by the one-click controller.
- Produces: `TASK_AGENT_TYPES`, `TASK_AGENT_METADATA`, and `resolveTaskAgentMetadata(agentType)`; CLI query `node bin/agent-metadata.mjs --json <agentType>`.

- [ ] **Step 1: Write the failing metadata contract test**

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TASK_AGENT_TYPES,
  resolveTaskAgentMetadata,
} from '../bin/agent-metadata.mjs'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const metadataBin = join(packageDir, 'bin', 'agent-metadata.mjs')

test('known agents have one execution policy and Aime is the only remote agent', () => {
  assert.deepEqual(TASK_AGENT_TYPES, [
    'codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy', 'workbuddy_ai', 'aime',
  ])
  for (const type of TASK_AGENT_TYPES.filter((value) => value !== 'aime')) {
    assert.deepEqual(resolveTaskAgentMetadata(type), { executionLocation: 'local' })
  }
  assert.deepEqual(resolveTaskAgentMetadata('aime'), {
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  })
  assert.throws(() => resolveTaskAgentMetadata('unknown-agent'), /Unknown Task Agent type/)
})

test('metadata JSON query is import-safe and deterministic', () => {
  const run = spawnSync(process.execPath, [metadataBin, '--json', 'aime'], { encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  assert.deepEqual(JSON.parse(run.stdout), {
    schemaVersion: 1,
    agentType: 'aime',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd packages/aamp-feishu-task-agent && node --test test/agent-metadata.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bin/agent-metadata.mjs`.

- [ ] **Step 3: Implement the shared metadata module and JSON entrypoint**

```js
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TASK_AGENT_METADATA = Object.freeze({
  codex: Object.freeze({ executionLocation: 'local' }),
  cursor: Object.freeze({ executionLocation: 'local' }),
  coco: Object.freeze({ executionLocation: 'local' }),
  traex: Object.freeze({ executionLocation: 'local' }),
  traecli: Object.freeze({ executionLocation: 'local' }),
  workbuddy: Object.freeze({ executionLocation: 'local' }),
  workbuddy_ai: Object.freeze({ executionLocation: 'local' }),
  aime: Object.freeze({
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  }),
})

export const TASK_AGENT_TYPES = Object.freeze(Object.keys(TASK_AGENT_METADATA))

export function resolveTaskAgentMetadata(agentType) {
  const normalized = String(agentType ?? '').trim()
  const metadata = TASK_AGENT_METADATA[normalized]
  if (!metadata) throw new Error(`Unknown Task Agent type: ${normalized || '(empty)'}`)
  return { ...metadata }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  if (process.argv[2] !== '--json' || !process.argv[3] || process.argv[4]) {
    console.error('Usage: node agent-metadata.mjs --json <agent-type>')
    process.exitCode = 2
  } else {
    try {
      const agentType = process.argv[3].trim()
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        agentType,
        ...resolveTaskAgentMetadata(agentType),
      })}\n`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
```

- [ ] **Step 4: Replace the controller's local Agent list with the shared export**

Add this import beside the existing Node imports:

```js
import {
  TASK_AGENT_TYPES,
  resolveTaskAgentMetadata,
} from './agent-metadata.mjs'
```

Replace every controller membership check against `AGENT_TYPES` with
`TASK_AGENT_TYPES`. Update the WorkBuddy static tests to assert the import and
the corresponding metadata entries instead of asserting a controller-local
array literal. Update source-extracted Trae and TraeCode test harness parameters
from `AGENT_TYPES` to `TASK_AGENT_TYPES` so they inject the dependency that the
extracted controller functions actually reference.

- [ ] **Step 5: Run focused and full Task Agent tests**

Run: `cd packages/aamp-feishu-task-agent && node --test test/agent-metadata.test.mjs test/workbuddy-one-click.test.mjs test/workbuddy-ai-one-click.test.mjs test/trae-one-click.test.mjs test/traecode-one-click.test.mjs`

Expected: PASS.

Run: `cd packages/aamp-feishu-task-agent && npm test`

Expected: PASS with no test reading metadata from a second Agent list.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/aamp-feishu-task-agent/bin/agent-metadata.mjs packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs packages/aamp-feishu-task-agent/test/agent-metadata.test.mjs packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs packages/aamp-feishu-task-agent/test/workbuddy-ai-one-click.test.mjs packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs
git commit -m "refactor(task-agent): centralize agent execution metadata"
```

---

### Task 2: Model execution location in ACP Bridge configuration and prompts

**Files:**
- Modify: `packages/aamp-acp-bridge/src/config.ts:7-41,93-110`
- Modify: `packages/aamp-acp-bridge/src/json-init.ts:20-205`
- Modify: `packages/aamp-acp-bridge/src/cli/init.ts:600-691`
- Modify: `packages/aamp-acp-bridge/src/prompt-builder.ts:340-475`
- Modify: `packages/aamp-acp-bridge/src/agent-bridge.ts:17,1400-1420`
- Modify: `packages/aamp-acp-bridge/test/config.test.ts`
- Modify: `packages/aamp-acp-bridge/test/json-init.test.ts`
- Modify: `packages/aamp-acp-bridge/src/prompt-builder.test.ts`

**Interfaces:**
- Consumes: `executionLocation` supplied by Task Agent JSON init in Task 6.
- Produces: `AgentExecutionLocation`, normalized `AgentConfig.executionLocation`, and `buildPrompt(task, threadContextText, options)` where `options.executionLocation` is trusted configuration.

- [ ] **Step 1: Add failing configuration and JSON-init tests**

Add these assertions to the focused config tests:

```ts
assert.equal(normalizeAgentConfig({
  name: 'codex',
  acpCommand: 'codex-acp',
}).executionLocation, 'local')

assert.equal(normalizeAgentConfig({
  name: 'aime',
  acpCommand: 'aime-acp',
  executionLocation: 'remote',
  attachmentPolicy: 'reject',
}).executionLocation, 'remote')

assert.throws(() => normalizeAgentConfig({
  name: 'unsafe-remote',
  acpCommand: 'unsafe-remote-acp',
  executionLocation: 'remote',
  attachmentPolicy: 'allow',
}), /remote Agent requires attachmentPolicy=reject/)
```

Add a JSON-init case that creates a remote Agent, updates it without resending
the field, and asserts both outputs retain `executionLocation: 'remote'`.

- [ ] **Step 2: Run configuration tests and verify RED**

Run: `cd packages/aamp-acp-bridge && npm exec -- tsx --test test/config.test.ts test/json-init.test.ts`

Expected: FAIL because `executionLocation` is absent and the unsafe remote
combination is accepted.

- [ ] **Step 3: Add the Zod schema and preservation logic**

Add the exact type and field:

```ts
export const agentExecutionLocationSchema = z.enum(['local', 'remote'])
export type AgentExecutionLocation = z.infer<typeof agentExecutionLocationSchema>
```

Inside `agentConfigSchema`, add:

```ts
executionLocation: agentExecutionLocationSchema.default('local'),
```

Add a schema refinement with this message:

```ts
if (agent.executionLocation === 'remote' && agent.attachmentPolicy !== 'reject') {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['attachmentPolicy'],
    message: 'remote Agent requires attachmentPolicy=reject',
  })
}
```

Extend JSON input parsing with optional `executionLocation`, resolve it as
`requestedAgent.executionLocation ?? previousAgent?.executionLocation ?? 'local'`,
and include it in the written Agent object and JSON result. Direct interactive
init writes `executionLocation: 'local'`.

- [ ] **Step 4: Add failing local/remote prompt tests**

```ts
const remotePrompt = buildPrompt(task, undefined, {
  agentName: 'aime',
  executionLocation: 'remote',
})
assert.match(remotePrompt, /runs in a remote sandbox/i)
assert.match(remotePrompt, /own remote-native capabilities/i)
assert.doesNotMatch(remotePrompt, /current working directory/i)
assert.doesNotMatch(remotePrompt, /FILE:\/absolute\/path/i)
assert.doesNotMatch(remotePrompt, /Feishu lark-cli profile rules/i)

const localPrompt = buildPrompt(task, undefined, {
  agentName: 'codex',
  executionLocation: 'local',
})
assert.match(localPrompt, /current working directory/i)
assert.match(localPrompt, /FILE:\/absolute\/path/i)
```

Include a remote Task whose user-authored body says `explain lark-cli at
/Users/example/tool`; assert that user text is preserved while generated
remote policy still contains no generated profile rule.

- [ ] **Step 5: Run prompt tests and verify RED**

Run: `cd packages/aamp-acp-bridge && npm exec -- tsx --test src/prompt-builder.test.ts`

Expected: FAIL because `buildPrompt` still takes a string Agent name and emits
local cwd/file rules.

- [ ] **Step 6: Implement prompt options and remote default rules**

Define the exact interface:

```ts
export interface PromptBuildOptions {
  agentName?: string
  executionLocation?: AgentExecutionLocation
}
```

Change the signature to:

```ts
export function buildPrompt(
  task: TaskDispatch,
  threadContextText?: string,
  options: PromptBuildOptions = {},
): string
```

Use `options.agentName` for identity and default
`options.executionLocation ?? 'local'`. For remote generic and conversational
prompts, render these exact policy statements instead of cwd/file rules:

```ts
const REMOTE_EXECUTION_RULES = [
  'Execution rules:',
  '- This Agent runs in a remote sandbox.',
  '- The caller local working directory, files, home directory, binaries, profiles, credentials, MCP servers, and shell environment are unavailable.',
  '- Use your own remote-native capabilities and identity when the request requires remote data access.',
  '- Do not claim that a caller-local command or path is available.',
  '- Text and HTTP(S) links are supported; local FILE references and file delivery are unsupported.',
  '- Finish all remote tool work before emitting the final result.',
]
```

Do not call `renderLarkCliProfileRules` for remote configuration even if an
incoming `dispatchContext` contains profile-shaped keys. Update Agent Bridge to
call:

```ts
const prompt = buildPrompt(promptTask, publicHydratedTask.threadContextText, {
  agentName: this.name,
  executionLocation: this.agentConfig.executionLocation,
})
```

- [ ] **Step 7: Run ACP focused and full gates**

Run: `cd packages/aamp-acp-bridge && npm exec -- tsx --test test/config.test.ts test/json-init.test.ts src/prompt-builder.test.ts src/agent-bridge.test.ts`

Expected: PASS.

Run: `cd packages/aamp-acp-bridge && npm test && npm run build`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/aamp-acp-bridge/src/config.ts packages/aamp-acp-bridge/src/json-init.ts packages/aamp-acp-bridge/src/cli/init.ts packages/aamp-acp-bridge/src/prompt-builder.ts packages/aamp-acp-bridge/src/agent-bridge.ts packages/aamp-acp-bridge/test/config.test.ts packages/aamp-acp-bridge/test/json-init.test.ts packages/aamp-acp-bridge/src/prompt-builder.test.ts
git commit -m "feat(acp-bridge): model remote agent execution"
```

---

### Task 3: Fail closed on remote ACP artifacts and unsafe diagnostics

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-bridge.ts:287-325,1488-1665`
- Modify: `packages/aamp-acp-bridge/src/agent-bridge.test.ts`

**Interfaces:**
- Consumes: normalized `AgentConfig.executionLocation` from Task 2 and parsed response file references.
- Produces: safe code `REMOTE_ARTIFACT_UNSUPPORTED`, remote task error formatting, and prompt debug fingerprints without prompt content.

- [ ] **Step 1: Write failing remote artifact and error tests**

Add an Agent Bridge fixture configured with:

```ts
{
  name: 'aime',
  acpCommand: 'aime-acp',
  executionLocation: 'remote',
  attachmentPolicy: 'reject',
}
```

Make its ACP result end with `FILE:/remote/sandbox/private.txt`. Assert:

```ts
assert.equal(fakeClient.results.length, 1)
assert.equal(fakeClient.results[0]?.status, 'rejected')
assert.match(fakeClient.results[0]?.errorMsg ?? '', /REMOTE_ARTIFACT_UNSUPPORTED/)
assert.doesNotMatch(fakeClient.results[0]?.errorMsg ?? '', /remote\/sandbox/)
assert.equal(fakeClient.results[0]?.attachments, undefined)
```

Add error-format cases using sentinels:

```ts
const unsafe = new Error("acpx --cwd /Users/private --agent '/secret/aime-acp' prompt ## AAMP Task SECRET_PROMPT")
assert.equal(
  formatTaskAgentError('aime', unsafe, 'remote'),
  'REMOTE_AGENT_FAILED: Remote Agent execution failed. Check local redacted diagnostics.',
)
assert.equal(
  formatTaskAgentError('aime', new Error('AUTH_REQUIRED raw-private-detail'), 'remote'),
  'AUTH_REQUIRED: Remote Agent authentication is required.',
)
```

Add a debug-log assertion that output contains prompt length and SHA-256 but
not `SECRET_PROMPT`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd packages/aamp-acp-bridge && npm exec -- tsx --test src/agent-bridge.test.ts`

Expected: FAIL because remote files are read as local attachments and raw
errors/debug prompts are returned.

- [ ] **Step 3: Add the remote artifact guard before filesystem access**

Add this helper beside response parsing:

```ts
export function assertSupportedResultArtifacts(
  parsed: ReturnType<typeof parseResponse>,
  executionLocation: AgentExecutionLocation,
): void {
  const hasArtifact = parsed.files.length > 0 || Boolean(parsed.attachments?.length)
  if (executionLocation === 'remote' && hasArtifact) {
    throw new UserFacingBridgeError(
      'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
    )
  }
}
```

Call it immediately after `parseResponse(result.output)` and before any
`existsSync`, `readFileSync`, filename merge, stream close, or result send.

- [ ] **Step 4: Sanitize remote task errors and prompt diagnostics**

Change the error formatter signature to:

```ts
export function formatTaskAgentError(
  agentName: string,
  error: unknown,
  executionLocation: AgentExecutionLocation = 'local',
): string
```

For remote configuration:

```ts
if (error instanceof UserFacingBridgeError) return error.userMessage
const safeCode = /\b(?:AIME|AUTH)_[A-Z0-9_]+\b/.exec(message)?.[0]
if (safeCode === 'AUTH_REQUIRED') {
  return 'AUTH_REQUIRED: Remote Agent authentication is required.'
}
if (safeCode === 'AUTH_IDENTITY_CHANGED') {
  return 'AUTH_IDENTITY_CHANGED: Restart the binding after verifying the remote account.'
}
if (safeCode) return `${safeCode}: Remote Agent execution failed. Check local redacted diagnostics.`
return 'REMOTE_AGENT_FAILED: Remote Agent execution failed. Check local redacted diagnostics.'
```

Pass `this.agentConfig.executionLocation` at the catch site. Replace raw debug
prompt output with:

```ts
const digest = createHash('sha256').update(options.prompt).digest('hex')
return `[${options.agentName}] ACP prompt debug task=${options.taskId} session=${options.sessionName} prompt_chars=${options.prompt.length} prompt_sha256=${digest} content_logged=false`
```

Never include the prompt in that function for either execution location.

- [ ] **Step 5: Run focused tests, full tests, and build**

Run: `cd packages/aamp-acp-bridge && npm exec -- tsx --test src/agent-bridge.test.ts src/prompt-builder.test.ts`

Expected: PASS.

Run: `cd packages/aamp-acp-bridge && npm test && npm run build`

Expected: PASS with no `SECRET_PROMPT`, `/Users/private`, or raw acpx command in
captured Task results or debug output.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/aamp-acp-bridge/src/agent-bridge.ts packages/aamp-acp-bridge/src/agent-bridge.test.ts
git commit -m "fix(acp-bridge): reject remote local artifacts safely"
```

---

### Task 4: Add trusted execution and app-secret configuration to merged Feishu Bridge

**Files:**
- Create: `packages/aamp-feishu-bridge/src/private-json.ts`
- Create: `packages/aamp-feishu-bridge/src/private-json.test.ts`
- Create: `packages/aamp-feishu-bridge/src/task-runtime-profile.test.ts`
- Create: `packages/aamp-feishu-bridge/src/task/config.test.ts`
- Modify: `packages/aamp-feishu-bridge/src/task/types.ts:1-35`
- Modify: `packages/aamp-feishu-bridge/src/task/config.ts:1-70,240-265`
- Modify: `packages/aamp-feishu-bridge/src/task-runtime-profile.ts:1-105`
- Modify: `packages/aamp-feishu-bridge/src/task-runtime.ts:1-100,140-175,280-350,478-536`
- Modify: `packages/aamp-feishu-bridge/src/index.ts:105-120,235-260`
- Modify: `packages/aamp-feishu-bridge/src/task-runtime.test.ts`

**Interfaces:**
- Consumes: `--agent-execution-location` from one-click Task 6.
- Produces: trusted `BridgeConfig.agent`, normalized `TaskRuntimeAgentConfig.execution_location`, app-secret Task profiles without `lark-cli`, and private atomic JSON persistence.

- [ ] **Step 1: Write failing Task config and profile tests**

Define these expectations:

```ts
const legacy = normalizeBridgeConfig({
  version: 1,
  aampHost: 'https://meshmail.test',
  targetAgentEmail: 'agent@meshmail.test',
  slug: 'feishu-runtime',
  feishu: {
    appId: 'cli_test',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  },
  mailbox,
  behavior: { ackComment: true },
}, 'aime')
assert.deepEqual(legacy.agent, { type: 'aime', executionLocation: 'local' })
```

Add profile tests:

```ts
const remote = normalizeTaskProfile({
  app_id: 'cli_remote',
  app_secret: 'remote-secret',
  auth_mode: 'app-secret',
})
assert.equal(remote.auth_mode, 'app-secret')
assert.equal(remote.profile, undefined)
assert.deepEqual(buildTaskProfileTaskFeishuConfig(remote), {
  appId: 'cli_remote',
  appSecret: 'remote-secret',
  authMode: 'app-secret',
})

const local = normalizeTaskProfile({
  app_id: 'cli_local',
  auth_mode: 'lark-cli',
})
assert.equal(local.profile, 'aamp-feishu-task-cli_local')
assert.equal(local.auth_mode, 'lark-cli')
```

Assert an app-secret profile without an App Secret throws a safe validation
error. Assert a legacy profile with neither `auth_mode` nor `profile` defaults
to `lark-cli` and receives the same generated profile name as before.

- [ ] **Step 2: Run the config/profile tests and verify RED**

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test src/task/config.test.ts src/task-runtime-profile.test.ts`

Expected: FAIL because the files/contracts do not exist and profile auth mode is
hard-coded to `lark-cli`.

- [ ] **Step 3: Add Task runtime types and migration**

Add to `src/task/types.ts`:

```ts
export type AgentExecutionLocation = 'local' | 'remote'

export interface TaskRuntimeAgentDescriptor {
  type: string
  executionLocation: AgentExecutionLocation
}
```

Add `agent: TaskRuntimeAgentDescriptor` to normalized `BridgeConfig`. Export a
testable normalizer from `src/task/config.ts`:

```ts
export function normalizeBridgeConfig(
  config: Partial<BridgeConfig>,
  fallbackAgentType = 'agent',
): BridgeConfig
```

Normalize a missing descriptor to:

```ts
{
  type: fallbackAgentType.trim() || 'agent',
  executionLocation: 'local',
}
```

Reject any explicit location other than `local` or `remote`. Preserve
`feishu.authMode`, `appSecret`, `cliProfile`, `cliBin`, domain, and headers in
the normalized config. For a remote descriptor, require App Secret, normalize
`authMode` to `app-secret`, and omit `cliProfile`/`cliBin`; for local legacy
config, preserve explicit auth mode and default to `lark-cli` when absent.

Change the stale
merged-package error to:

```text
Bridge config is incomplete. Run "aamp-feishu-bridge start --enable-task" again.
```

- [ ] **Step 4: Implement app-secret profile normalization**

Change the profile interfaces to:

```ts
export interface TaskProfileConfig {
  app_id: string
  app_secret?: string
  profile?: string
  display_name?: string
  auth_mode: 'app-secret' | 'lark-cli'
  capabilities: Array<'im' | 'task'>
  domains: string[]
  updated_at: string
}

export interface TaskProfileInput {
  app_id: string
  app_secret?: string
  profile?: string
  display_name?: string
  auth_mode?: 'app-secret' | 'lark-cli'
  capabilities?: Array<'im' | 'task'>
  domains?: string[]
  updated_at?: string
}
```

`normalizeTaskProfile` defaults legacy input to `lark-cli`, preserves the
existing generated `resolveTaskProfileName(appId)` when local input omits a
profile, requires `app_secret` for app-secret mode, and does not invent a
`lark-cli` profile for app-secret mode. `buildTaskProfileFeishuConfig` and
`buildTaskProfileTaskFeishuConfig` emit `authMode: 'app-secret'` plus App Secret
without `cliProfile` for remote profiles; local profiles emit
`authMode: 'lark-cli'` plus `cliProfile`.

The normalization branch is:

```ts
const authMode = input.auth_mode ?? 'lark-cli'
const appSecret = input.app_secret?.trim()
if (authMode === 'app-secret' && !appSecret) {
  throw new Error(`Feishu App Secret is required for app-secret profile ${appId}.`)
}
const profile = authMode === 'lark-cli'
  ? input.profile?.trim() || resolveTaskProfileName(appId)
  : undefined
```

The app-secret builder branch returns:

```ts
{
  appId: profile.app_id,
  appSecret: profile.app_secret,
  authMode: 'app-secret',
}
```

Update Bot selection display so app-secret records render
`auth=app-secret`; render `profile=<name>` only for local `lark-cli` records.

- [ ] **Step 5: Write the failing private-file mode test**

```ts
test('writePrivateJsonAtomic writes and replaces mode 0600 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-private-json-'))
  const target = join(root, 'nested', 'config.json')
  try {
    await writePrivateJsonAtomic(target, { app_secret: 'SECRET_SENTINEL' })
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    await writePrivateJsonAtomic(target, { app_secret: 'SECOND_SENTINEL' })
    assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { app_secret: 'SECOND_SENTINEL' })
    assert.deepEqual((await readdir(dirname(target))).sort(), ['config.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
```

- [ ] **Step 6: Implement and use private atomic JSON writes**

Create `writePrivateJsonAtomic(filePath, value)` using
`open(tempPath, 'wx', 0o600)`, `handle.writeFile`, `handle.sync`, `rename`, and
`chmod(filePath, 0o600)`. Its `finally` closes an open handle and removes only
its exact temporary file. Remove the local `writeJsonAtomic` implementation
from `task-runtime.ts` and route every Task-runtime JSON write through this
helper. In particular, `saveBots`, both generated IM/Task `config.json` writes
(including mailbox retry rewrites), and the Agent/current/active stores must all
use the same private atomic primitive; this keeps the rule simple and prevents
a later secret-bearing field from silently returning to default file modes.

```ts
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const parent = dirname(filePath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const tempPath = join(parent, `.${basename(filePath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}
```

- [ ] **Step 7: Propagate CLI execution location into persisted configs**

Extend `TaskEnabledRunOptions` with:

```ts
agentExecutionLocation?: AgentExecutionLocation
```

Extend persisted `TaskRuntimeAgentConfig` with:

```ts
execution_location: AgentExecutionLocation
```

Normalize legacy stored Agents to local. Non-interactive selection uses the
explicit CLI value or local. `ensureInstanceConfigs` always writes:

```ts
agent: {
  type: selection.agent.type,
  executionLocation: selection.agent.execution_location,
}
```

Parse `--agent-execution-location` in `src/index.ts`, reject invalid values
before file writes, and do not put the value into AAMP `dispatchContext`.

- [ ] **Step 8: Run merged Feishu Bridge focused/full gates**

Extend `task-runtime.test.ts` to assert the saved profile store and both
generated bridge `config.json` files are mode `0600`, including after a
replacement write.

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test src/private-json.test.ts src/task/config.test.ts src/task-runtime-profile.test.ts src/task-runtime.test.ts`

Expected: PASS.

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test "src/**/*.test.ts" && npm run build`

Expected: PASS and no output instructing the user to run the deprecated package.

- [ ] **Step 9: Commit Task 4**

```bash
git add packages/aamp-feishu-bridge/src/private-json.ts packages/aamp-feishu-bridge/src/private-json.test.ts packages/aamp-feishu-bridge/src/task-runtime-profile.ts packages/aamp-feishu-bridge/src/task-runtime-profile.test.ts packages/aamp-feishu-bridge/src/task/types.ts packages/aamp-feishu-bridge/src/task/config.ts packages/aamp-feishu-bridge/src/task/config.test.ts packages/aamp-feishu-bridge/src/task-runtime.ts packages/aamp-feishu-bridge/src/task-runtime.test.ts packages/aamp-feishu-bridge/src/index.ts
git commit -m "feat(feishu-bridge): configure remote task execution"
```

---

### Task 5: Split merged Feishu prompt policy and guard remote results

**Files:**
- Modify: `packages/aamp-feishu-bridge/src/task/dispatch.ts:9-15,138-405,445-470`
- Modify: `packages/aamp-feishu-bridge/src/task/dispatch.test.ts`
- Modify: `packages/aamp-feishu-bridge/src/task/runtime.ts:200-280,841-930,2580-2730`
- Modify: `packages/aamp-feishu-bridge/src/task/runtime.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig.agent.executionLocation` from Task 4.
- Produces: invariant/local/remote Feishu prompt sections, safe remote result failures, and pre-filesystem `file_delivery` rejection.

- [ ] **Step 1: Write failing prompt parity and exclusion tests**

Build local and remote dispatches from the same Task fixture. Assert both
contain:

```ts
for (const rules of [local.promptRules ?? '', remote.promptRules ?? '']) {
  assert.match(rules, /FEISHU_TASK_RESULT_JSON/)
  assert.match(rules, /AAMP_RESULT_JSON/)
  assert.match(rules, /only the Feishu Bridge writes the current Task/i)
  assert.match(rules, /all work for this turn has settled/i)
}
```

Assert the remote generated sections:

```ts
assert.match(remote.promptRules ?? '', /remote sandbox/i)
assert.match(remote.promptRules ?? '', /own remote-native Feishu\/Lark capabilities/i)
assert.doesNotMatch(remote.promptRules ?? '', /lark-cli/i)
assert.doesNotMatch(remote.promptRules ?? '', /--profile/i)
assert.doesNotMatch(remote.promptRules ?? '', /source ~\/lark-env\.sh/i)
assert.doesNotMatch(remote.promptRules ?? '', /current working directory/i)
assert.doesNotMatch(remote.promptRules ?? '', /file_delivery artifact/i)
assert.doesNotMatch(remote.promptRules ?? '', /do not delegate work to subagents/i)
assert.doesNotMatch(remote.promptRules ?? '', /copy.*verbatim/i)
assert.match(remote.promptRules ?? '', /internal remote tool orchestration is allowed/i)
```

Use a Task body containing `The user mentioned lark-cli and /Users/example` and
assert those user-authored strings remain in `bodyText` while generated
`promptRules` stays remote-safe.

- [ ] **Step 2: Run dispatch tests and verify RED**

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test src/task/dispatch.test.ts`

Expected: FAIL because dispatch options have no execution location and all
prompts contain local profile/file rules.

- [ ] **Step 3: Refactor prompt construction into invariant and location policies**

Extend `FeishuTaskDispatchOptions` with:

```ts
agentExecutionLocation?: AgentExecutionLocation
```

Create three focused renderers:

```ts
function renderInvariantTaskRules(): string[]
function renderLocalExecutionRules(options: FeishuTaskDispatchOptions | undefined): string[]
function renderRemoteExecutionRules(): string[]
```

`renderInvariantTaskRules` contains result schema, nested JSON escaping,
thread/intent context, final-settlement, and current-Task write ownership.
It includes the exact lines `Only the Feishu Bridge writes the current Task
comments, status, and deliveries.` and `Emit the final result only after all
work for this turn has settled.`
`renderLocalExecutionRules` retains the existing CLI/profile/cwd/file text.
`renderRemoteExecutionRules` states remote sandbox, remote-native reads,
Bridge-only current Task writes, text/link output support, and no local
attachments/files. `buildFeishuTaskPromptRules` chooses exactly one location
renderer after invariants.

The remote renderer returns these policy lines in addition to the invariant
contract:

```ts
return [
  'Remote execution rules:',
  '- You run in a remote sandbox. Caller-local cwd, files, home, binaries, profiles, credentials, MCP servers, and shell environment are unavailable.',
  '- Use your own remote-native Feishu/Lark capabilities and identity for requested data reads.',
  '- Only the Feishu Bridge writes the current Task comments, status, and deliveries.',
  '- Text and HTTP(S) link results are supported. Local FILE references, ACP attachments, and file_delivery are unsupported.',
  '- Internal remote tool orchestration is allowed, but all work for this turn must settle before the final result envelope.',
]
```

Update `buildFeishuTaskDispatchOptions(config)` in `src/task/runtime.ts` to
include only the trusted value:

```ts
agentExecutionLocation: config.agent.executionLocation,
```

`buildFeishuTaskDispatchContext` continues to contain `source` and stable
session key only; do not add execution location or remote credentials.

- [ ] **Step 4: Write failing remote result and sanitization tests**

Add a runtime configured with:

```ts
agent: { type: 'aime', executionLocation: 'remote' }
```

Return a valid `status=succeeded` envelope containing a `file_delivery` path
`/Users/private/SECRET_FILE`. Assert the Task is closed as failed with safe code
`REMOTE_ARTIFACT_UNSUPPORTED`, `uploadTaskDelivery` is never called, and the
comment/state/log evidence contains neither the path nor `SECRET_FILE`.

Return an outer rejected result with:

```text
ACP agent error: acpx --cwd /Users/private --agent /secret/aime-acp prompt ## AAMP Task SECRET_PROMPT
```

Assert the Task comment contains `REMOTE_AGENT_FAILED` and none of the command,
path, or prompt sentinel. Also assert a safe inner failed message such as
`没有权限读取指定群聊，请确认远端 Aime 账号权限。` remains visible.

- [ ] **Step 5: Run runtime tests and verify RED**

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test src/task/runtime.test.ts`

Expected: FAIL because remote `file_delivery` reaches path validation and raw
ACP rejection text reaches the Task comment.

- [ ] **Step 6: Enforce remote output and error safety before filesystem access**

Change result classification to receive trusted location:

```ts
function classifyTaskResult(
  result: TaskResult,
  executionLocation: AgentExecutionLocation = 'local',
): TaskResultDisposition
```

Immediately after parsing `outputs`, before returning a succeeded disposition,
classify any remote `file_delivery` as:

```ts
{
  kind: 'failure',
  reason: 'agent_failed',
  message: 'REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.',
}
```

Pass `this.config.agent.executionLocation` at the runtime call site. As a
defense-in-depth assertion, also add this at the start of
`applyTaskResultOutputs`, before `validateFileDeliveryPath`:

```ts
if (
  this.config.agent.executionLocation === 'remote'
  && outputs.some((output) => output.kind === 'file_delivery')
) {
  throw new Error('REMOTE_ARTIFACT_UNSUPPORTED: Remote Agent file delivery is not supported.')
}
```

Add a single Task-visible sanitizer:

```ts
const REMOTE_FAILURE_FORBIDDEN = /(?:\bacpx\b|--cwd\b|--agent\b|## AAMP Task|\/(?:Users|home|tmp|var\/folders)\/|app[_-]?secret|access[_-]?token|resume[_-]?token)/i

function truncateShortText(message: string): string {
  const characters = Array.from(message)
  if (characters.length <= MAX_SHORT_FAILURE_REASON_LENGTH) return characters.join('')
  return `${characters.slice(0, MAX_SHORT_FAILURE_REASON_LENGTH).join('')}...`
}

export function sanitizeTaskVisibleFailureReason(
  error: unknown,
  executionLocation: AgentExecutionLocation,
): string {
  const normalized = formatUnknownError(error).replace(/\s+/g, ' ').trim()
  if (executionLocation === 'local') return truncateShortText(normalized || '未知错误')
  const code = /\b(?:AIME|AUTH|REMOTE)_[A-Z0-9_]+\b/.exec(normalized)?.[0]
  if (REMOTE_FAILURE_FORBIDDEN.test(normalized)) {
    return code
      ? `${code}：远程智能体执行失败，请查看本地脱敏日志。`
      : 'REMOTE_AGENT_FAILED：远程智能体执行失败，请查看本地脱敏日志。'
  }
  return truncateShortText(normalized || 'REMOTE_AGENT_FAILED：远程智能体执行失败。')
}
```

Use it for prompt-dispatch failures, outer rejected results, inner failed
results, persisted `lastError`, and Task-visible comments. Remote logs persist
the sanitized value plus structural action/category; they do not store the raw
message.

- [ ] **Step 7: Run focused and full merged-package gates**

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test src/task/dispatch.test.ts src/task/runtime.test.ts src/task-runtime.test.ts`

Expected: PASS.

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test "src/**/*.test.ts" && npm run build`

Expected: PASS with local prompt/result regressions unchanged.

- [ ] **Step 8: Commit Task 5**

```bash
git add packages/aamp-feishu-bridge/src/task/dispatch.ts packages/aamp-feishu-bridge/src/task/dispatch.test.ts packages/aamp-feishu-bridge/src/task/runtime.ts packages/aamp-feishu-bridge/src/task/runtime.test.ts
git commit -m "fix(feishu-bridge): enforce remote task boundaries"
```

---

### Task 6: Branch one-click registration and startup by shared metadata

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh:1-160,1210-1350,2390-2485,2600-2670,3990-4050,4530-4625`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:490-535,1360-1470,1630-1770,2610-2660`
- Modify: `packages/aamp-feishu-task-agent/test/aime-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs`

**Interfaces:**
- Consumes: `resolveTaskAgentMetadata` and metadata JSON query from Task 1; bridge config fields from Tasks 2 and 4.
- Produces: Aime registration/startup with no local `lark-cli`, matching trusted bridge configs, and unchanged local startup.

- [ ] **Step 1: Write failing controller tests for remote bindings and argv**

Add tests that use an Aime binding with no `bot.lark_cli_profile` and assert
validation succeeds. A local Codex binding with the same omission must still
throw `bindings[0].bot.lark_cli_profile`.

Update the existing Aime override assertions to target
`acpBridgeAgentPolicy`. Update selection copy assertions to use
`请选择要绑定的智能体` and `是否继续选择智能体和 Bot`, without describing the whole
list as local.

For Aime, assert the ACP init payload Agent is exactly:

```js
{
  name: 'aime',
  acpCommand: '/safe/bin/aime-acp --site cn',
  credentialsFile: expectedCredentials,
  pairingFile: expectedPairing,
  senderPoliciesFile: expectedPolicies,
  createPairing: false,
  executionLocation: 'remote',
  attachmentPolicy: 'reject',
  taskDispatchConcurrency: 1,
}
```

Assert remote Feishu argv contains:

```text
--agent aime --agent-execution-location remote --app-id cli_remote
```

and contains none of `--use-feishu-cli`, `--feishu-cli-profile`,
`--feishu-cli-bin`, or the App Secret sentinel. Assert local argv still contains
the existing three CLI/profile/bin arguments plus
`--agent-execution-location local`.

- [ ] **Step 2: Write failing bootstrap tests for zero remote `lark-cli` calls**

Run internal Aime register/prepare fixtures with fake functions that fail if
`ensure_lark_cli`, `ensure_lark_cli_profile`, `probe_lark_cli_profile_locked`,
or `source_lark_env` is called. Assert Bot registration, Aime internal-network
check, pinned package preparation, auth status, and doctor are each called once.

Assert returned remote registration JSON contains `app_id`, `app_secret`, and
`auth_mode: "app-secret"`, but no `lark_cli_profile` or local binary path.
Add a legacy Aime binding whose saved profile file contains a sentinel; assert
the remote start never probes or ensures it and the exact file remains
unchanged after the test.

- [ ] **Step 3: Run one-click focused tests and verify RED**

Run: `cd packages/aamp-feishu-task-agent && node --test test/agent-metadata.test.mjs test/aime-one-click.test.mjs test/binding-persistence.test.mjs test/bootstrap.test.mjs test/startup-concurrency.test.mjs`

Expected: FAIL because profile validation/setup and Feishu CLI argv are still
unconditional.

- [ ] **Step 4: Add a bootstrap metadata query and cache**

Add a `task_agent_metadata_path` beside `task_agent_controller_path` and query:

```bash
load_agent_metadata() {
  local metadata_path metadata_json
  metadata_path="$(task_agent_global_package_dir)/bin/agent-metadata.mjs"
  [ -r "$metadata_path" ] || agent_fail "Task Agent metadata is missing: $metadata_path"
  metadata_json="$(node "$metadata_path" --json "$AGENT")" \
    || agent_fail "failed to resolve Task Agent metadata for $AGENT"
  AGENT_EXECUTION_LOCATION="$(node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(value.executionLocation)' "$metadata_json")"
  AGENT_ATTACHMENT_POLICY="$(node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(value.attachmentPolicy || "")' "$metadata_json")"
  AGENT_TASK_DISPATCH_CONCURRENCY="$(node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(value.taskDispatchConcurrency ? String(value.taskDispatchConcurrency) : "")' "$metadata_json")"
}
```

Initialize the three variables to empty strings and call this once after Agent
selection or once at each internal action boundary before behavior branches.
Do not add another shell `case` that maps Agent name to execution location.

- [ ] **Step 5: Branch Bot registration and profile handling**

For remote metadata:

- register the Bot App with the existing Node SDK and app-level permissions;
- set no `LARK_CLI_PROFILE`;
- skip `source_lark_env`, `ensure_lark_cli`, `ensure_lark_cli_profile`, profile
  probe, profile ensure, and user OAuth;
- save/return `auth_mode: "app-secret"` with App ID/Secret in the existing
  private binding/runtime files;
- keep the App Secret out of stdout, argv, and logs.

Use one branch around the existing profile operations:

```bash
if [ "$AGENT_EXECUTION_LOCATION" = "remote" ]; then
  LARK_CLI_PROFILE=""
else
  LARK_CLI_PROFILE="$(task_profile_name_for_app_id "$APP_ID")"
  source_lark_env
  ensure_lark_cli_profile "$APP_ID" "$APP_SECRET" "$LARK_CLI_PROFILE"
fi
```

Likewise, `prepare_internal_agent_environment` calls `source_lark_env` only for
`local`; Agent CLI preparation, Aime package/auth/doctor, and acpx preparation
remain outside that branch. Remote prepare JSON omits
`lark_cli_config_dir`; local prepare JSON retains it.

For local metadata, retain the current profile generation and OAuth flow. Make
`run_internal_probe_profile` and `run_internal_ensure_profile` reject a remote
binding as an invalid controller call so a regression cannot silently re-enable
local profile setup.

- [ ] **Step 6: Make controller metadata authoritative**

Replace `acpBridgeAgentOverrides` with:

```js
function acpBridgeAgentPolicy(stableAgentType) {
  const metadata = resolveTaskAgentMetadata(stableAgentType)
  return {
    executionLocation: metadata.executionLocation,
    ...(metadata.attachmentPolicy ? { attachmentPolicy: metadata.attachmentPolicy } : {}),
    ...(metadata.taskDispatchConcurrency
      ? { taskDispatchConcurrency: metadata.taskDispatchConcurrency }
      : {}),
  }
}
```

Binding validation requires `lark_cli_profile` only when metadata is local.
`writeFeishuRuntimeProfile` writes `auth_mode: 'app-secret'`, App Secret, and no
profile for remote; local output remains `auth_mode: 'lark-cli'` with profile.

Skip profile prewarming, profile ensure, and `lark_cli_config_dir` consistency
checks for remote bindings. Change startup copy to
`正在检查 aime 远程智能体...` and retain `本地智能体` for local metadata.
Change the empty-discovery and selection prompts to refer to `智能体`, because
the candidate list can contain both execution classes.

Build Feishu args from metadata:

```js
const args = [
  'start', '--enable-task',
  '--config-dir', binding.feishu_config_dir,
  '--aamp-host', binding.aamp_host,
  '--agent', binding.agent_type,
  '--agent-execution-location', metadata.executionLocation,
  ...targetArgs,
  '--app-id', binding.bot.app_id,
  '--bot-name', binding.bot.display_name || binding.bot.app_id,
  '--json',
]
```

Append the current `--use-feishu-cli`, profile, and binary arguments only for
local metadata. Never append App Secret.

- [ ] **Step 7: Preserve the user-owned bootstrap mode while staging content**

After modifying the bootstrap content, stage the file and reset only the index
mode before inspecting the staged patch:

```bash
git add packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh
git update-index --chmod=-x packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh
git diff --cached --summary
```

Expected: the staged summary contains no mode change. The working tree may
continue to show the user's executable-mode change after the commit.

- [ ] **Step 8: Run focused and full one-click gates**

Run: `cd packages/aamp-feishu-task-agent && node --test test/agent-metadata.test.mjs test/aime-one-click.test.mjs test/binding-persistence.test.mjs test/bootstrap.test.mjs test/startup-concurrency.test.mjs`

Expected: PASS.

Run: `cd packages/aamp-feishu-task-agent && npm test`

Expected: PASS, including all local Agent startup regressions.

- [ ] **Step 9: Commit Task 6 with content only**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs packages/aamp-feishu-task-agent/test/aime-one-click.test.mjs packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs packages/aamp-feishu-task-agent/test/bootstrap.test.mjs packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs
git update-index --chmod=-x packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh
git diff --cached --check
git commit -m "feat(task-agent): start remote agents without lark cli"
```

---

### Task 7: Lock packaged remote behavior, documentation, and final gates

**Files:**
- Modify: `packages/aamp-acp-bridge/test/aime-packaged.test.ts`
- Modify: `packages/aamp-acp-bridge/test/aime-packaged-harness.ts`
- Modify: `packages/aamp-feishu-task-agent/README.md`
- Modify: `packages/aamp-acp-bridge/README.md`
- Modify: `packages/aamp-feishu-bridge/README.md`
- Modify: `docs/aime-acp/e2e-report.md`

**Interfaces:**
- Consumes: all trusted execution-location, prompt, result, and one-click behavior from Tasks 1-6.
- Produces: packaged first-turn/follow-up evidence and an explicit live acceptance checklist that remains `NOT RUN` until actually executed.

- [ ] **Step 1: Extend the packaged Aime test and verify RED**

Configure the clean-installed generic bridge Agent with:

```ts
{
  name: 'aime',
  acpCommand: installedAimeAcpCommand,
  executionLocation: 'remote',
  attachmentPolicy: 'reject',
  taskDispatchConcurrency: 1,
}
```

Inspect the full prompt only inside the deterministic test process's memory;
persist or print only its fingerprint and boolean contract results. Do not
write raw prompt text to logs, fixtures, or persistent files. For both first
turn and follow-up, assert generated policy contains:

```text
remote sandbox
own remote-native capabilities
AAMP_RESULT_JSON
FEISHU_TASK_RESULT_JSON
```

and contains none of generated local rules:

```text
Feishu lark-cli profile rules:
source ~/lark-env.sh
FILE:/absolute/path/to/file
Use these local file paths
```

Assert first turn and follow-up reuse the same remote Aime session ID, both
complete, and the second prompt contains the invariant result contract again.

Run: `cd packages/aamp-acp-bridge && npm run test:aime-packaged`

Expected before harness updates: FAIL because packaged config/prompt evidence
does not yet carry execution location.

- [ ] **Step 2: Update the packaged harness and make the gate GREEN**

Pass the explicit remote configuration through the real clean-installed
`aamp-acp-bridge` JSON init. Keep the existing fake Aime transport, exact acpx
version, child timeout, TERM/KILL/retained-close cleanup, temp-root ownership,
and privacy sentinels unchanged. Add assertions that no prompt evidence contains
an App Secret, caller cwd, raw acpx command, or local profile.

Run: `cd packages/aamp-acp-bridge && npm run test:aime-packaged`

Expected: PASS with zero owned child processes and zero owned temporary roots.

- [ ] **Step 3: Update user and operator documentation**

Document these exact points:

- all Agents default to local; Aime is remote;
- Aime one-click does not require a local `lark-cli` profile or user OAuth;
- the local Feishu Bridge still uses Bot App credentials and exclusively writes
  the current Task;
- Aime uses its own remote-native capabilities and identity for requested
  Feishu/Lark reads;
- remote incoming attachments and local file delivery are unsupported;
- text and HTTP(S) link outputs are supported;
- `aamp-feishu-task-bridge` is deprecated and is not an implementation target;
- Aime auth/doctor readiness does not prove access to a particular group.

In `docs/aime-acp/e2e-report.md`, add a “Remote execution-location gate” section
with status `NOT RUN` and the exact live scenario:

```text
总结一下 lark mind 群昨天的消息
```

Require first-turn completion, follow-up completion on the same stable session,
Bridge-written comment/status, and absence of local CLI/profile/path/secret/raw
command evidence. Do not change the status to PASS during deterministic tests.

- [ ] **Step 4: Run all package gates from clean package directories**

Run: `cd packages/aamp-feishu-task-agent && npm test`

Expected: PASS.

Run: `cd packages/aamp-acp-bridge && npm test && npm run build && npm run test:aime-packaged`

Expected: PASS.

Run: `cd packages/aamp-feishu-bridge && npm exec -- tsx --test "src/**/*.test.ts" && npm run build`

Expected: PASS.

- [ ] **Step 5: Run static scope, privacy, and deprecated-package checks**

Run:

```bash
git diff --check
git diff ab73307 --name-only | grep '^packages/aamp-feishu-task-bridge/'
```

Expected: `git diff --check` exits zero; the deprecated-package grep exits one
with no output.

Run:

```bash
git diff ab73307 -- packages/aamp-feishu-task-agent packages/aamp-acp-bridge packages/aamp-feishu-bridge docs/aime-acp | grep -E 'SECRET_SENTINEL|SECRET_PROMPT|/Users/private|access_token|resume_token'
```

Expected: only negative test fixtures/assertions contain sentinels; no
production or documentation line contains credential values or caller-local
paths.

Inspect staging and status. The bootstrap executable-mode change must remain
unstaged and must not appear in any feature commit.

- [ ] **Step 6: Commit Task 7**

```bash
git add packages/aamp-acp-bridge/test/aime-packaged.test.ts packages/aamp-acp-bridge/test/aime-packaged-harness.ts packages/aamp-feishu-task-agent/README.md packages/aamp-acp-bridge/README.md packages/aamp-feishu-bridge/README.md docs/aime-acp/e2e-report.md
git diff --cached --check
git commit -m "test: verify remote Aime execution contract"
```

- [ ] **Step 7: Record the live gate honestly**

Do not run the live company-network/Feishu/Aime scenario without explicit user
direction and the intended non-secret test deployment identity. If it is not
run, report it as `NOT RUN` and do not call startup, deterministic fakes, or
packaged tests end-to-end production acceptance.
