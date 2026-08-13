# TraeCLI Native ACP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Trae 2.0 as the canonical `trae` agent in `aamp-acp-bridge`, discovering `traecli` or `traex` and running the detected native ACP server with existing AAMP streaming behavior.

**Architecture:** Extend the existing known-agent resolver with an ordered Trae executable alias list and a raw ACP command builder. Share the known-agent registry between discovery and interactive init, then reuse `AcpxClient` and `AgentBridge` unchanged for sessions, streaming, cancellation, and final results.

**Tech Stack:** TypeScript, Node.js 20+, `tsx` with `node:test`, `acpx`, TraeCLI native ACP, AAMP Node SDK.

## Global Constraints

- The canonical bridge identity is exactly `trae`; `traecli` and `traex` are executable aliases only.
- Prefer `traecli`; use `traex` only when `traecli` is not present on `PATH`.
- Generate exactly `traecli acp serve` or `traex acp serve` and omit `--yolo` by default.
- Preserve every explicitly supplied or previously configured non-empty Trae `acpCommand` verbatim.
- Do not retry with `traex` when a detected `traecli` process starts but ACP initialization fails.
- Do not add a Trae profile or parser to `packages/aamp-cli-bridge`, and do not change the existing `coco` profile.
- Do not add an AAMP usage stream event; the current schema only supports `text.delta`, `todo`, `tool_call`, and `artifact`.
- Automated tests must not use the real Trae installation, network, or files in the user's AAMP configuration directory.
- Do not bump package versions or add release automation.

---

## File map

- `packages/aamp-acp-bridge/src/agent-resolver.ts`: canonical known-agent registry, Trae alias ordering, default executable hint, ACP command generation, and missing-command warning.
- `packages/aamp-acp-bridge/src/discovery.ts`: JSON discovery consumes the shared registry and emits the canonical missing-state `command`.
- `packages/aamp-acp-bridge/src/cli/init.ts`: interactive init consumes the same shared registry.
- `packages/aamp-acp-bridge/test/path-fixture.ts`: isolated fake `PATH` helper shared by resolver and discovery tests.
- `packages/aamp-acp-bridge/test/agent-resolver.test.ts`: resolver precedence, fallback, version, warning, and compatibility tests.
- `packages/aamp-acp-bridge/test/discovery.test.ts`: canonical discovery shape and previous-config preservation tests.
- `packages/aamp-acp-bridge/package.json`: package-local test command.
- `packages/aamp-acp-bridge/README.md`: Trae setup, alias behavior, authentication, and safety guidance.
- `docs/AGENT_SETUP.md`: ACP-first connector recommendation for Trae 2.0 and separation from Coco.

### Task 1: Add deterministic Trae command resolution

**Files:**
- Create: `packages/aamp-acp-bridge/test/path-fixture.ts`
- Create: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Modify: `packages/aamp-acp-bridge/package.json:13-18`
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts:1-70`

**Interfaces:**
- Consumes: Node `execFileSync`, `existsSync`, and the process `PATH` used by the current resolver.
- Produces: `KNOWN_AGENTS: readonly string[]`, `defaultAgentCommand(name: string): string`, `detectKnownAgent(name: string): AgentResolution | undefined`, `defaultAcpCommand(name: string, previousCommand?: string): string`, and `missingAgentWarning(name: string): string`.

- [ ] **Step 1: Add the package test command and isolated fake-PATH helper**

Add this script to `packages/aamp-acp-bridge/package.json`:

```json
"test": "tsx --test test/*.test.ts"
```

Create `packages/aamp-acp-bridge/test/path-fixture.ts`:

```ts
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakePathCommand {
  name: string
  version: string
  versionExitCode?: number
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function withFakePath<T>(
  commands: readonly FakePathCommand[],
  run: (directory: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-agent-path-'))
  const previousPath = process.env.PATH

  try {
    for (const command of commands) {
      if (!/^[a-z0-9-]+$/.test(command.name)) {
        throw new Error(`Unsafe fake command name: ${command.name}`)
      }

      const executable = join(directory, command.name)
      writeFileSync(executable, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  printf '%s\\n' ${shellQuote(command.version)}`,
        `  exit ${command.versionExitCode ?? 0}`,
        'fi',
        'exit 0',
        '',
      ].join('\n'))
      chmodSync(executable, 0o755)
    }

    const cases = commands.map((command) => [
      `  ${command.name})`,
      `    printf '%s\\n' ${shellQuote(join(directory, command.name))}`,
      '    exit 0',
      '    ;;',
    ].join('\n')).join('\n')
    const which = join(directory, 'which')
    writeFileSync(which, [
      '#!/bin/sh',
      'case "$1" in',
      cases,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'))
    chmodSync(which, 0o755)

    process.env.PATH = directory
    return run(directory)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
}
```

- [ ] **Step 2: Write failing resolver tests**

Create `packages/aamp-acp-bridge/test/agent-resolver.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  defaultAgentCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../src/agent-resolver.js'
import { withFakePath } from './path-fixture.js'

test('registers trae exactly once as a known agent', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'trae').length, 1)
})

test('prefers traecli when both Trae executables are installed', () => {
  withFakePath([
    { name: 'traecli', version: 'traecli 2.0.0' },
    { name: 'traex', version: 'traecli 2.0.0' },
  ], () => {
    assert.deepEqual(detectKnownAgent('trae'), {
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: 'traecli 2.0.0',
    })
  })
})

test('falls back to traex when traecli is absent', () => {
  withFakePath([{ name: 'traex', version: 'traecli 2.0.0' }], () => {
    assert.deepEqual(detectKnownAgent('trae'), {
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'traecli 2.0.0',
    })
  })
})

test('uses canonical defaults and warning when Trae is absent', () => {
  withFakePath([], () => {
    assert.equal(detectKnownAgent('trae'), undefined)
    assert.equal(defaultAgentCommand('trae'), 'traecli')
    assert.equal(defaultAcpCommand('trae'), 'traecli acp serve')
    assert.equal(missingAgentWarning('trae'), 'traecli or traex was not found on PATH.')
  })
})

test('keeps detection when the selected executable cannot report a version', () => {
  withFakePath([
    { name: 'traecli', version: 'unavailable', versionExitCode: 1 },
  ], () => {
    assert.deepEqual(detectKnownAgent('trae'), {
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: 'installed',
    })
  })
})

test('preserves previous commands and existing generic agent behavior', () => {
  withFakePath([
    { name: 'claude', version: 'claude 1.0.0' },
    { name: 'hermes', version: 'hermes 1.0.0' },
  ], () => {
    assert.equal(
      defaultAcpCommand('trae', 'traecli acp serve --yolo'),
      'traecli acp serve --yolo',
    )
    assert.deepEqual(detectKnownAgent('claude'), {
      command: 'claude',
      acpCommand: 'claude',
      version: 'claude 1.0.0',
    })
    assert.deepEqual(detectKnownAgent('hermes'), {
      command: 'hermes',
      acpCommand: 'hermes acp',
      version: 'hermes 1.0.0',
    })
    assert.equal(
      defaultAcpCommand('codex', 'npx -y custom-codex-acp'),
      'npx -y custom-codex-acp',
    )
  })
})
```

- [ ] **Step 3: Run the resolver test and verify the intended failure**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/agent-resolver.test.ts
```

Expected: FAIL because `KNOWN_AGENTS` and `defaultAgentCommand` are not yet exported, or because Trae resolves as an ordinary missing command.

- [ ] **Step 4: Implement the shared registry and Trae resolver**

Replace `packages/aamp-acp-bridge/src/agent-resolver.ts` with:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex'
const CODEX_APP_ACP_COMMAND = `env CODEX_PATH=${CODEX_APP_CLI} npx -y @agentclientprotocol/codex-acp`
const TRAE_COMMANDS = ['traecli', 'traex'] as const

export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'trae',
] as const

export interface AgentResolution {
  command: string
  acpCommand: string
  version: string
}

function commandCandidates(name: string): readonly string[] {
  return name === 'trae' ? TRAE_COMMANDS : [name]
}

export function defaultAgentCommand(name: string): string {
  return commandCandidates(name)[0]
}

function baseAcpCommand(name: string, command = defaultAgentCommand(name)): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'trae') return `${command} acp serve`
  return name
}

function detectVersion(command: string): string {
  try {
    return execFileSync(command, ['--version'], { stdio: 'pipe', timeout: 5_000 })
      .toString()
      .trim()
      .split('\n')[0] || 'installed'
  } catch {
    return 'installed'
  }
}

function findOnPath(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe', timeout: 3_000 })
    return true
  } catch {
    return false
  }
}

export function detectKnownAgent(name: string): AgentResolution | undefined {
  for (const command of commandCandidates(name)) {
    if (findOnPath(command)) {
      return {
        command,
        acpCommand: baseAcpCommand(name, command),
        version: detectVersion(command),
      }
    }
  }

  if (name === 'codex' && process.platform === 'darwin' && existsSync(CODEX_APP_CLI)) {
    return {
      command: CODEX_APP_CLI,
      acpCommand: CODEX_APP_ACP_COMMAND,
      version: detectVersion(CODEX_APP_CLI),
    }
  }

  return undefined
}

export function defaultAcpCommand(name: string, previousCommand?: string): string {
  const baseCommand = baseAcpCommand(name)
  if (name === 'trae' && previousCommand) return previousCommand
  if (previousCommand && previousCommand !== baseCommand) {
    if (name !== 'codex' || previousCommand !== CODEX_APP_CLI) return previousCommand
  }
  return detectKnownAgent(name)?.acpCommand ?? baseCommand
}

export function missingAgentWarning(name: string): string {
  if (name === 'trae') {
    return 'traecli or traex was not found on PATH.'
  }
  if (name === 'codex' && process.platform === 'darwin') {
    return `codex was not found on PATH or at ${CODEX_APP_CLI}.`
  }
  return `${name} was not found on PATH.`
}
```

- [ ] **Step 5: Run resolver tests and the package build**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/agent-resolver.test.ts
npm run build
```

Expected: 6 tests pass and TypeScript exits with code 0.

- [ ] **Step 6: Commit resolver support**

```bash
git add packages/aamp-acp-bridge/package.json \
  packages/aamp-acp-bridge/src/agent-resolver.ts \
  packages/aamp-acp-bridge/test/path-fixture.ts \
  packages/aamp-acp-bridge/test/agent-resolver.test.ts
git commit -m "feat(acp-bridge): resolve Trae native ACP commands"
```

### Task 2: Integrate Trae into discovery and interactive init

**Files:**
- Create: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Modify: `packages/aamp-acp-bridge/src/discovery.ts:1-96`
- Modify: `packages/aamp-acp-bridge/src/cli/init.ts:1-22`

**Interfaces:**
- Consumes: `KNOWN_AGENTS`, `defaultAgentCommand`, `defaultAcpCommand`, `detectKnownAgent`, and `missingAgentWarning` from Task 1.
- Produces: one canonical `AcpBridgeAgentCandidate` with `id: 'trae'`; interactive `init --agent trae` uses the same registry.

- [ ] **Step 1: Write failing discovery tests**

Create `packages/aamp-acp-bridge/test/discovery.test.ts`:

```ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  discoverAcpBridgeAgents,
  type AcpBridgeAgentCandidate,
} from '../src/discovery.js'
import { withFakePath } from './path-fixture.js'

function findTrae(configPath: string): AcpBridgeAgentCandidate {
  const candidates = discoverAcpBridgeAgents(configPath).candidates
    .filter((candidate) => candidate.id === 'trae')
  assert.equal(candidates.length, 1)
  return candidates[0]
}

test('discovers canonical trae through traecli', () => {
  withFakePath([{ name: 'traecli', version: 'traecli 2.0.0' }], (directory) => {
    const candidate = findTrae(join(directory, 'missing-config.json'))
    assert.deepEqual(candidate, {
      id: 'trae',
      displayName: 'trae',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: 'traecli 2.0.0',
      warnings: [],
    })
  })
})

test('reports canonical Trae defaults when both aliases are missing', () => {
  withFakePath([], (directory) => {
    const candidate = findTrae(join(directory, 'missing-config.json'))
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, false)
    assert.equal(candidate.confidence, 'low')
    assert.equal(candidate.command, 'traecli')
    assert.equal(candidate.acpCommand, 'traecli acp serve')
    assert.deepEqual(candidate.warnings, [
      'traecli or traex was not found on PATH.',
    ])
  })
})

test('preserves a configured Trae ACP command', () => {
  withFakePath([], (directory) => {
    const configPath = join(directory, 'bridge.json')
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'trae',
        acpCommand: 'traex acp serve --yolo',
        credentialsFile: join(directory, 'missing-credentials.json'),
      }],
    }))

    const candidate = findTrae(configPath)
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, true)
    assert.equal(candidate.confidence, 'medium')
    assert.equal(candidate.command, 'traecli')
    assert.equal(candidate.acpCommand, 'traex acp serve --yolo')
  })
})
```

- [ ] **Step 2: Run the discovery test and verify the intended failure**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/discovery.test.ts
```

Expected: FAIL because the local `KNOWN_AGENTS` list in `discovery.ts` does not contain `trae`.

- [ ] **Step 3: Use the shared registry and canonical command hint**

In `packages/aamp-acp-bridge/src/discovery.ts`, replace the resolver import with:

```ts
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  defaultAgentCommand,
  detectKnownAgent,
  missingAgentWarning,
} from './agent-resolver.js'
```

Delete the file-local `KNOWN_AGENTS` array. Replace the command fallback inside `discoverAcpBridgeAgents` with:

```ts
const command = resolution?.command ?? defaultAgentCommand(name)
```

In `packages/aamp-acp-bridge/src/cli/init.ts`, replace the resolver import with:

```ts
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  detectKnownAgent,
} from '../agent-resolver.js'
```

Delete the file-local `KNOWN_AGENTS` array. Do not change the scan, selection, registration, or config-writing flow.

- [ ] **Step 4: Run focused tests, the full package test suite, and build**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/discovery.test.ts
npm test
npm run build
```

Expected: 3 discovery tests pass, all 9 package tests pass, and TypeScript exits with code 0.

- [ ] **Step 5: Confirm there is only one known-agent registry**

Run:

```bash
rg -n "const KNOWN_AGENTS|export const KNOWN_AGENTS" \
  packages/aamp-acp-bridge/src
```

Expected: one match, the exported declaration in `src/agent-resolver.ts`.

- [ ] **Step 6: Commit discovery and init integration**

```bash
git add packages/aamp-acp-bridge/src/discovery.ts \
  packages/aamp-acp-bridge/src/cli/init.ts \
  packages/aamp-acp-bridge/test/discovery.test.ts
git commit -m "feat(acp-bridge): discover Trae CLI aliases"
```

### Task 3: Document Trae ACP setup and safety boundaries

**Files:**
- Modify: `packages/aamp-acp-bridge/README.md:9-17,135-148`
- Modify: `docs/AGENT_SETUP.md:38-88`

**Interfaces:**
- Consumes: canonical agent name and command behavior implemented in Tasks 1-2.
- Produces: operator instructions that select ACP Bridge for Trae 2.0 and keep Coco as a distinct CLI profile.

- [ ] **Step 1: Verify Trae-specific documentation is absent before editing**

Run:

```bash
rg -n "Trae 2.0|traecli acp serve|traex acp serve" \
  packages/aamp-acp-bridge/README.md docs/AGENT_SETUP.md
```

Expected: exit code 1 with no matches.

- [ ] **Step 2: Add the Trae section to the ACP Bridge README**

Change the init description to say it scans installed ACP-capable agents, including Hermes and Trae. Append this section after the Hermes section in `packages/aamp-acp-bridge/README.md`:

````markdown
### Trae 2.0

Trae 2.0 exposes a native ACP server. Sign in with TraeCLI first, then initialize the canonical `trae` agent:

```bash
traecli login
npx aamp-acp-bridge init --agent trae
```

Discovery prefers `traecli` and falls back to `traex`. The generated config uses one of these raw ACP commands:

```json
{
  "name": "trae",
  "acpCommand": "traecli acp serve",
  "slug": "trae-bridge"
}
```

```json
{
  "name": "trae",
  "acpCommand": "traex acp serve",
  "slug": "trae-bridge"
}
```

The default deliberately omits `--yolo`. ACP Bridge already auto-approves ACP permission requests through `acpx`, while Trae's `--yolo` also disables sandboxing. Only add `--yolo` through an explicit custom `acpCommand` when the surrounding environment provides an external sandbox.
````

- [ ] **Step 3: Update the agent setup guide**

Add this connector-choice row to `docs/AGENT_SETUP.md`:

```markdown
| `trae` (Trae 2.0) | `aamp-acp-bridge` with native `traecli acp serve` or `traex acp serve` | explicit custom ACP command |
```

Add this known-agent row:

```markdown
| `trae` | `traecli acp serve`, falling back to `traex acp serve` |
```

After the known-agent table, add:

```markdown
For Trae 2.0, use the canonical agent name `trae`. The executable aliases are detected automatically, and the generated command omits `--yolo`. The `coco` entry below remains a separate CLI Bridge profile; ACP Bridge does not migrate or fall back to it.
```

- [ ] **Step 4: Verify documentation and run all deterministic checks**

Run:

```bash
rg -n "Trae 2.0|traecli acp serve|traex acp serve|coco" \
  packages/aamp-acp-bridge/README.md docs/AGENT_SETUP.md

cd packages/sdks/nodejs
npm test
npm run build

cd ../../aamp-acp-bridge
npm test
npm run build

cd ../..
git diff --check
```

Expected: documentation contains both aliases and the Coco separation; SDK reports 55 passing tests; ACP Bridge reports 9 passing tests; both builds and `git diff --check` succeed.

- [ ] **Step 5: Commit documentation**

```bash
git add packages/aamp-acp-bridge/README.md docs/AGENT_SETUP.md
git commit -m "docs: add Trae ACP bridge setup"
```

### Task 4: Verify real discovery, native ACP streaming, and the AAMP boundary

**Files:**
- No repository files are modified. Store smoke output only in temporary directories and remove it afterward.

**Interfaces:**
- Consumes: built `aamp-acp-bridge`, authenticated `traecli`, `acpx`, and optionally an authorized AAMP sender/recipient pair.
- Produces: verification evidence for discovery, session lifecycle, streamed assistant chunks, final result, and conditional AAMP end-to-end status.

- [ ] **Step 1: Verify real bridge discovery without touching user config**

Run from the repository root:

```bash
TRAE_DISCOVERY_DIR="$(mktemp -d)"
TRAE_DISCOVERY_CONFIG="$TRAE_DISCOVERY_DIR/bridge.json"
TRAE_DISCOVERY_JSON="$TRAE_DISCOVERY_DIR/discovery.json"

node packages/aamp-acp-bridge/dist/index.js discover \
  --config "$TRAE_DISCOVERY_CONFIG" --json > "$TRAE_DISCOVERY_JSON"

node - "$TRAE_DISCOVERY_JSON" <<'NODE'
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const discovery = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const candidates = discovery.candidates.filter((item) => item.id === 'trae')
assert.equal(candidates.length, 1)
assert.equal(candidates[0].detected, true)
assert.equal(candidates[0].command, 'traecli')
assert.equal(candidates[0].acpCommand, 'traecli acp serve')
assert.deepEqual(candidates[0].warnings, [])
console.log(JSON.stringify(candidates[0], null, 2))
NODE

rm -rf "$TRAE_DISCOVERY_DIR"
```

Expected: the assertion script prints one detected `trae` candidate using `traecli acp serve`; the user's normal ACP Bridge config is not read or written.

- [ ] **Step 2: Verify named-session lifecycle and strict JSON streaming**

Run:

```bash
TRAE_ACP_WORK_DIR="$(mktemp -d)"
TRAE_ACP_LOG="$(mktemp)"
TRAE_ACP_SESSION="aamp-trae-smoke-$$"

acpx --approve-all --cwd "$TRAE_ACP_WORK_DIR" \
  --agent "traecli acp serve" \
  sessions ensure --name "$TRAE_ACP_SESSION"

acpx --approve-all --cwd "$TRAE_ACP_WORK_DIR" \
  --format json --json-strict --timeout 60 --max-turns 1 \
  --agent "traecli acp serve" \
  prompt --session "$TRAE_ACP_SESSION" \
  "Do not call tools or modify files. Reply exactly: ACP_TRAE_OK" \
  > "$TRAE_ACP_LOG"

node - "$TRAE_ACP_LOG" <<'NODE'
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const records = readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const updates = records.map((record) =>
  record.params?.update ?? record.update ?? record)
const chunks = updates.filter((item) =>
  item.type === 'agent_message_chunk' || item.sessionUpdate === 'agent_message_chunk')
const text = chunks.map((item) => {
  const content = item.content ?? item.update?.content
  if (typeof content === 'string') return content
  return content?.text ?? ''
}).join('')
const resultIndex = records.findIndex((record, index) =>
  updates[index].type === 'result' || record.result?.stopReason)
const result = resultIndex === -1 ? undefined : records[resultIndex]
const stopReason = result?.result?.stopReason ?? updates[resultIndex]?.stopReason
assert.ok(chunks.length > 1, 'expected multiple agent_message_chunk events')
assert.match(text, /ACP_TRAE_OK/)
assert.ok(result, 'expected a final result event')
assert.equal(stopReason, 'end_turn', 'expected final stopReason=end_turn')
console.log(`chunks=${chunks.length} text=${text} stopReason=${stopReason}`)
NODE

acpx --approve-all --cwd "$TRAE_ACP_WORK_DIR" \
  --agent "traecli acp serve" \
  sessions close "$TRAE_ACP_SESSION"

test -z "$(find "$TRAE_ACP_WORK_DIR" -mindepth 1 -print -quit)"
rm -rf "$TRAE_ACP_WORK_DIR"
rm -f "$TRAE_ACP_LOG"
```

Expected: session ensure and close succeed, multiple assistant chunks combine to `ACP_TRAE_OK`, a final result exists, and the isolated work directory remains empty. The Trae command does not include `--yolo`.

- [ ] **Step 3: Run controlled AAMP end-to-end verification when credentials are available**

Use only a bridge config whose `trae` mailbox already authorizes the selected sender. Export the three task-specific variables from the controlled test environment, then validate them without printing credential contents:

```bash
: "${TRAE_E2E_CONFIG:?TRAE_E2E_CONFIG must point to an existing controlled ACP Bridge config}"
: "${TRAE_E2E_RECIPIENT:?TRAE_E2E_RECIPIENT must be the configured Trae test mailbox}"
: "${TRAE_E2E_SENDER_PROFILE_PATH:?TRAE_E2E_SENDER_PROFILE_PATH must point to an authorized AAMP CLI profile}"
test -f "$TRAE_E2E_CONFIG"
test -f "$TRAE_E2E_SENDER_PROFILE_PATH"
```

Start the built bridge in one terminal:

```bash
node packages/aamp-acp-bridge/dist/index.js start \
  --agent trae --config "$TRAE_E2E_CONFIG" --json
```

In a second terminal, run this observer/dispatcher from the repository root:

```bash
TRAE_E2E_RECIPIENT="$TRAE_E2E_RECIPIENT" \
TRAE_E2E_SENDER_PROFILE_PATH="$TRAE_E2E_SENDER_PROFILE_PATH" \
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AampClient } from './packages/sdks/nodejs/dist/index.js'

const recipient = process.env.TRAE_E2E_RECIPIENT
const profilePath = process.env.TRAE_E2E_SENDER_PROFILE_PATH
assert.ok(recipient, 'TRAE_E2E_RECIPIENT is required')
assert.ok(profilePath, 'TRAE_E2E_SENDER_PROFILE_PATH is required')

const profile = JSON.parse(await readFile(profilePath, 'utf8'))
const domain = profile.email.split('@')[1]
const client = AampClient.fromMailboxIdentity({
  email: profile.email,
  smtpPassword: profile.smtpPassword,
  baseUrl: profile.baseUrl ?? `https://${domain}`,
  smtpHost: profile.smtpHost ?? domain,
  smtpPort: profile.smtpPort ?? 587,
  rejectUnauthorized: profile.rejectUnauthorized,
})

const taskId = randomUUID()
let textDeltaCount = 0
let finalResult
let streamSubscription

const completed = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('AAMP E2E timed out')), 120_000)

  client.on('task.stream.opened', (opened) => {
    if (opened.taskId !== taskId) return
    void client.subscribeStream(opened.streamId, {
      onEvent(event) {
        if (event.type === 'text.delta') textDeltaCount += 1
        if (finalResult && textDeltaCount > 0) {
          clearTimeout(timeout)
          resolve(undefined)
        }
      },
      onError(error) {
        clearTimeout(timeout)
        reject(error)
      },
    })
      .then((subscription) => { streamSubscription = subscription })
      .catch((error) => {
        clearTimeout(timeout)
        reject(error)
      })
  })

  client.on('task.result', (result) => {
    if (result.taskId !== taskId) return
    finalResult = result
    if (textDeltaCount > 0) {
      clearTimeout(timeout)
      resolve(undefined)
    }
  })
})

try {
  await client.connect()
  const sent = await client.sendTask({
    to: recipient,
    taskId,
    title: 'Trae ACP bridge E2E smoke',
    bodyText: 'Do not call tools or modify files. Reply exactly: AAMP_TRAE_E2E_OK',
  })
  assert.equal(sent.taskId, taskId)
  await completed

  assert.ok(textDeltaCount > 0, 'expected at least one realtime text.delta')
  assert.ok(finalResult, 'expected a matching task.result')
  assert.equal(finalResult.status, 'completed')
  assert.match(String(finalResult.output ?? ''), /AAMP_TRAE_E2E_OK/)
  console.log(JSON.stringify({ taskId, textDeltaCount, status: finalResult.status }, null, 2))
} finally {
  streamSubscription?.close()
  client.disconnect()
}
NODE
```

Expected: at least one realtime `text.delta`, a matching completed `task.result`, and output containing `AAMP_TRAE_E2E_OK`. Stop the bridge with Ctrl+C after the result.

If the three controlled-environment values are unavailable, do not register a production mailbox or weaken sender policy merely to run this check. Report the result exactly as: `AAMP end-to-end not run: authorized test sender/recipient unavailable.`

- [ ] **Step 4: Confirm commit scope and clean worktree**

Run:

```bash
git status --short
git diff --name-only main...HEAD
```

Expected: `git status --short` is empty. The branch diff contains only the design/plan documents and the implementation, tests, and documentation named in this plan; there are no changes under `packages/aamp-cli-bridge`.
