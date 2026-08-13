# Native Traex Support in AAMP ACP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native `traex` discovery and initialization to `aamp-acp-bridge`, with the default ACP command `traex acp serve` and no legacy Trae/Coco aliases.

**Architecture:** Extend the existing native-agent resolver with one exact Traex profile, then make interactive init and JSON discovery share that resolver-owned list. Keep AcpxClient and JSON-init orchestration unchanged; they already consume raw ACP commands and `defaultAcpCommand` respectively.

**Tech Stack:** Node.js 20, TypeScript 5.4, `node:test`, `tsx`, Zod, acpx 0.11+.

## Global Constraints

- The canonical Agent name is exactly `traex`.
- Detect only the executable named `traex`.
- The default ACP command is exactly `traex acp serve`.
- Never add `--yolo` automatically.
- Do not detect, alias, migrate, install, upgrade, or log in through `trae`, `traecli`, or `coco`.
- Do not modify `packages/aamp-feishu-task-agent`, `packages/aamp-feishu-bridge`, or `packages/aamp-cli-bridge`.
- Do not modify AcpxClient streaming or permission behavior.
- Do not bump or publish an npm package version in these implementation tasks.
- Keep all implementation changes under `packages/aamp-acp-bridge/**`; only spec and plan files may live under `docs/superpowers/**`.

## File Structure

- Modify `packages/aamp-acp-bridge/src/agent-resolver.ts`: own the shared native-agent list and the Traex command mapping.
- Modify `packages/aamp-acp-bridge/src/discovery.ts`: consume the shared native-agent list.
- Modify `packages/aamp-acp-bridge/src/cli/init.ts`: consume the shared list, expose pure target/message helpers, and report an explicit missing executable.
- Modify `packages/aamp-acp-bridge/package.json`: add the package-local test command.
- Create `packages/aamp-acp-bridge/test/path-fixture.ts`: isolated POSIX PATH fixture for resolver tests.
- Create `packages/aamp-acp-bridge/test/agent-resolver.test.ts`: native profile, exact mapping, no-fallback, and regression tests.
- Create `packages/aamp-acp-bridge/test/json-init.test.ts`: verify JSON init inherits the resolver default without network registration.
- Create `packages/aamp-acp-bridge/test/discovery.test.ts`: verify installed and missing discovery states.
- Create `packages/aamp-acp-bridge/test/init.test.ts`: verify interactive init target validation and missing-agent copy without starting the wizard.
- Modify `packages/aamp-acp-bridge/README.md`: document the native Traex flow and generated config.

---

### Task 1: Native Traex Resolver and JSON Init Default

**Files:**
- Modify: `packages/aamp-acp-bridge/package.json`
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Create: `packages/aamp-acp-bridge/test/path-fixture.ts`
- Create: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Create: `packages/aamp-acp-bridge/test/json-init.test.ts`

**Interfaces:**
- Consumes: existing `detectKnownAgent(name)`, `defaultAcpCommand(name, previousCommand?)`, `missingAgentWarning(name)`, and `runJsonInit(configPath, input)`.
- Produces: `KNOWN_AGENTS: readonly string[]`; `defaultAcpCommand('traex') === 'traex acp serve'`; `detectKnownAgent('traex')` returns an `AgentResolution` only when `traex` exists on PATH.

- [ ] **Step 1: Add the test runner and isolated PATH fixture**

Add this script to `packages/aamp-acp-bridge/package.json` without changing the package version:

```json
"scripts": {
  "dev": "tsx src/index.ts",
  "build": "tsc",
  "test": "tsx --test \"test/*.test.ts\"",
  "start": "node dist/index.js"
}
```

Create `packages/aamp-acp-bridge/test/path-fixture.ts`:

```ts
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface FakePathCommand {
  name: string
  version: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function withFakePath<T>(
  commands: readonly FakePathCommand[],
  run: (directory: string) => T,
): T {
  if (process.platform === 'win32') {
    throw new Error('withFakePath is POSIX-only because the current resolver uses which')
  }

  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-path-'))
  const previousPath = process.env.PATH

  try {
    for (const command of commands) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(command.name)) {
        throw new Error(`Unsafe fake command name: ${command.name}`)
      }
      const executable = join(directory, command.name)
      writeFileSync(executable, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  printf '%s\\n' ${shellQuote(command.version)}`,
        'fi',
        'exit 0',
        '',
      ].join('\n'))
      chmodSync(executable, 0o755)
    }

    process.env.PATH = [directory, '/usr/bin', '/bin'].join(delimiter)
    return run(directory)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
}
```

- [ ] **Step 2: Write failing resolver and JSON-init tests**

Create `packages/aamp-acp-bridge/test/agent-resolver.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../src/agent-resolver.js'
import { withFakePath } from './path-fixture.js'

test('registers only traex as a native Trae profile', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'traex').length, 1)
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.equal(KNOWN_AGENTS.includes(legacyName), false)
  }
})

test('detects traex and maps its native ACP command', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], () => {
    assert.deepEqual(detectKnownAgent('traex'), {
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'traecli 0.200.19',
    })
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
  })
})

test('does not fall back to traecli or coco', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([
    { name: 'traecli', version: 'legacy' },
    { name: 'coco', version: 'legacy' },
  ], () => {
    assert.equal(detectKnownAgent('traex'), undefined)
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
    assert.equal(missingAgentWarning('traex'), 'traex was not found on PATH.')
  })
})

test('preserves representative existing native mappings', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([
    { name: 'claude', version: 'claude 1.0.0' },
    { name: 'hermes', version: 'hermes 1.0.0' },
  ], () => {
    assert.equal(detectKnownAgent('claude')?.acpCommand, 'claude')
    assert.equal(detectKnownAgent('hermes')?.acpCommand, 'hermes acp')
    assert.equal(
      defaultAcpCommand('codex', 'npx -y custom-codex-acp'),
      'npx -y custom-codex-acp',
    )
  })
})
```

Create `packages/aamp-acp-bridge/test/json-init.test.ts`:

```ts
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runJsonInit } from '../src/json-init.js'

test('JSON init supplies the native traex ACP command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-json-init-'))
  const configPath = join(directory, 'config.json')
  const credentialsFile = join(directory, 'traex-credentials.json')

  try {
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'traex@example.com',
      smtpPassword: 'fixture-password',
    }))

    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, 'traex acp serve')
    assert.equal(result.agents[0].registered, false)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'traex')
    assert.equal(written.agents[0].acpCommand, 'traex acp serve')
    assert.equal(written.agents[0].slug, 'traex-bridge')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('JSON init preserves an existing custom traex ACP command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-json-init-'))
  const configPath = join(directory, 'config.json')
  const credentialsFile = join(directory, 'traex-credentials.json')
  const customCommand = 'traex acp serve --config model="custom"'

  try {
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'traex@example.com',
      smtpPassword: 'fixture-password',
    }))
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'traex',
        acpCommand: customCommand,
        credentialsFile,
      }],
    }))

    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, customCommand)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].acpCommand, customCommand)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run the tests and verify the red state**

Run:

```bash
cd packages/sdks/nodejs
npm ci
npm run build
cd ../../aamp-acp-bridge
npm ci
npm test
```

Expected: FAIL because `KNOWN_AGENTS` is not exported and the old resolver maps
`traex` to the executable name instead of `traex acp serve`.

- [ ] **Step 4: Implement the minimal resolver profile**

In `packages/aamp-acp-bridge/src/agent-resolver.ts`, add the exported shared
list near the existing constants:

```ts
export const KNOWN_AGENTS: readonly string[] = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'traex',
]
```

Replace `baseAcpCommand` with:

```ts
function baseAcpCommand(name: string): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex') return 'traex acp serve'
  return name
}
```

Do not add candidate arrays or aliases. The existing `detectKnownAgent` will
look up the exact name `traex`, call `traex --version`, and attach the new base
ACP command. The existing generic `missingAgentWarning` already returns the
required `traex was not found on PATH.` text.

- [ ] **Step 5: Run focused and package tests**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/agent-resolver.test.ts test/json-init.test.ts
npm test
```

Expected: PASS, zero failures. On Windows, the three PATH-dependent assertions
are skipped while the native-list and JSON-init assertions still run.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/aamp-acp-bridge/package.json \
  packages/aamp-acp-bridge/src/agent-resolver.ts \
  packages/aamp-acp-bridge/test/path-fixture.ts \
  packages/aamp-acp-bridge/test/agent-resolver.test.ts \
  packages/aamp-acp-bridge/test/json-init.test.ts
git commit -m "feat(acp-bridge): add native Traex profile"
```

---

### Task 2: Expose Traex Through Discovery and Interactive Init

**Files:**
- Modify: `packages/aamp-acp-bridge/src/discovery.ts`
- Modify: `packages/aamp-acp-bridge/src/cli/init.ts`
- Create: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Create: `packages/aamp-acp-bridge/test/init.test.ts`

**Interfaces:**
- Consumes: `KNOWN_AGENTS`, `detectKnownAgent`, `defaultAcpCommand`, and `missingAgentWarning` from Task 1.
- Produces: `resolveInitScanTargets(agent?: string): string[]`; `noAgentsFoundMessage(agent?: string): string`; discovery candidate `id: 'traex'` with exact native command fields.

- [ ] **Step 1: Write the failing discovery test**

Create `packages/aamp-acp-bridge/test/discovery.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { discoverAcpBridgeAgents } from '../src/discovery.js'
import { withFakePath } from './path-fixture.js'

function findTraex(configPath: string) {
  const matches = discoverAcpBridgeAgents(configPath).candidates
    .filter((candidate) => candidate.id === 'traex')
  assert.equal(matches.length, 1)
  return matches[0]
}

test('discovers an installed native traex executable', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], (directory) => {
    assert.deepEqual(findTraex(join(directory, 'missing-config.json')), {
      id: 'traex',
      displayName: 'traex',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'traecli 0.200.19',
      warnings: [],
    })
  })
})

test('reports the native defaults when traex is missing', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([], (directory) => {
    const candidate = findTraex(join(directory, 'missing-config.json'))
    assert.equal(candidate.detected, false)
    assert.equal(candidate.configured, false)
    assert.equal(candidate.confidence, 'low')
    assert.equal(candidate.command, 'traex')
    assert.equal(candidate.acpCommand, 'traex acp serve')
    assert.deepEqual(candidate.warnings, ['traex was not found on PATH.'])
  })
})

test('does not expose legacy Trae or Coco names as native candidates', () => {
  const ids = discoverAcpBridgeAgents('/definitely/missing/config.json')
    .candidates.map((candidate) => candidate.id)
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.equal(ids.includes(legacyName), false)
  }
})
```

- [ ] **Step 2: Write the failing interactive-init contract test**

Create `packages/aamp-acp-bridge/test/init.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  noAgentsFoundMessage,
  resolveInitScanTargets,
} from '../src/cli/init.js'

test('interactive init accepts only the native traex name', () => {
  assert.deepEqual(resolveInitScanTargets('traex'), ['traex'])
  for (const legacyName of ['trae', 'traecli', 'coco']) {
    assert.throws(
      () => resolveInitScanTargets(legacyName),
      new RegExp(`Unknown ACP agent "${legacyName}"`),
    )
  }
})

test('forced init explains a missing traex executable', () => {
  assert.equal(
    noAgentsFoundMessage('traex'),
    'No ACP agent found. traex was not found on PATH.',
  )
  assert.match(noAgentsFoundMessage(), /Install an agent first/)
})
```

- [ ] **Step 3: Run the focused tests and verify the red state**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/discovery.test.ts test/init.test.ts
```

Expected: FAIL because discovery and init still own old native-agent lists, and
the two pure init helpers do not exist.

- [ ] **Step 4: Make discovery consume the resolver-owned list**

In `packages/aamp-acp-bridge/src/discovery.ts`, change the resolver import to:

```ts
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from './agent-resolver.js'
```

Delete the local `KNOWN_AGENTS` declaration. Keep the existing candidate
builder unchanged; Task 1's resolver now supplies all Traex fields.

- [ ] **Step 5: Make interactive init consume the shared list and explicit error copy**

In `packages/aamp-acp-bridge/src/cli/init.ts`, change the resolver import to:

```ts
import {
  KNOWN_AGENTS,
  defaultAcpCommand,
  detectKnownAgent,
  missingAgentWarning,
} from '../agent-resolver.js'
```

Delete the local `KNOWN_AGENTS` declaration. Add these pure helpers before
`runInit`:

```ts
export function resolveInitScanTargets(agent?: string): string[] {
  if (!agent) return [...KNOWN_AGENTS]
  if (!KNOWN_AGENTS.includes(agent)) {
    throw new Error(`Unknown ACP agent "${agent}". Known agents: ${KNOWN_AGENTS.join(', ')}`)
  }
  return [agent]
}

export function noAgentsFoundMessage(agent?: string): string {
  if (agent) return `No ACP agent found. ${missingAgentWarning(agent)}`
  return 'No ACP agents found. Install an agent first (e.g. npm i -g @anthropic-ai/claude-code).'
}
```

Replace the scan-target filtering and separate unknown-agent branch with:

```ts
const scanTargets = resolveInitScanTargets(opts.agent)
```

Replace the empty-detection message with:

```ts
if (detected.length === 0) {
  console.log(noAgentsFoundMessage(opts.agent))
  rl.close()
  return false
}
```

- [ ] **Step 6: Run Task 2 and full package tests**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test test/discovery.test.ts test/init.test.ts
npm test
```

Expected: PASS, zero failures. The output must include the resolver/JSON tests
from Task 1 as well as the new discovery/init tests.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/aamp-acp-bridge/src/discovery.ts \
  packages/aamp-acp-bridge/src/cli/init.ts \
  packages/aamp-acp-bridge/test/discovery.test.ts \
  packages/aamp-acp-bridge/test/init.test.ts
git commit -m "feat(acp-bridge): expose Traex in init and discovery"
```

---

### Task 3: Documentation, Build, Scope, and Native Smoke Verification

**Files:**
- Modify: `packages/aamp-acp-bridge/README.md`

**Interfaces:**
- Consumes: the native `traex` profile implemented by Tasks 1 and 2.
- Produces: user-facing setup instructions and final verification evidence; no new runtime interface.

- [ ] **Step 1: Add the README section after the existing Hermes section**

Append this content to `packages/aamp-acp-bridge/README.md`:

````markdown
### Traex

Trae CLI 2.0 exposes a native ACP server through `traex`. Sign in first, then
initialize the native Traex profile:

```bash
traex login
npx aamp-acp-bridge init --agent traex
```

The generated agent config uses:

```json
{
  "name": "traex",
  "acpCommand": "traex acp serve",
  "slug": "traex-bridge"
}
```

ACP Bridge detects only the `traex` executable for this profile. It does not
fall back to Coco, `trae`, or `traecli`. The generated command deliberately
omits `--yolo`.
````

- [ ] **Step 2: Run the complete deterministic verification suite**

Run from the worktree root:

```bash
cd packages/sdks/nodejs
npm ci
npm run build
cd ../../aamp-acp-bridge
npm ci
npm test
npm run build
cd ../..
git diff --check
```

Expected:

- Node SDK build: PASS.
- ACP Bridge tests: PASS with zero failures.
- ACP Bridge TypeScript build: PASS.
- `git diff --check`: no output and exit code 0.

- [ ] **Step 3: Verify the built CLI discovers the installed Traex binary**

Run:

```bash
node packages/aamp-acp-bridge/dist/index.js discover --json \
  --config /tmp/aamp-acp-bridge-traex-missing-config.json
```

Expected: exit code 0 and one candidate with all of:

```json
{
  "id": "traex",
  "displayName": "traex",
  "detected": true,
  "command": "traex",
  "acpCommand": "traex acp serve",
  "warnings": []
}
```

If `traex` is not installed on the verification host, this manual assertion is
skipped with that reason recorded; deterministic fake-PATH tests remain
mandatory.

- [ ] **Step 4: Run a bounded native ACP smoke when Traex is logged in**

Run:

```bash
acpx --approve-all \
  --agent "traex acp serve" \
  --format json \
  --timeout 30 \
  prompt -s aamp-traex-native-smoke \
  "Reply with exactly ACP_TRAEX_OK"

acpx --agent "traex acp serve" sessions close aamp-traex-native-smoke
```

Expected: the prompt exits 0, the ACP transcript contains incremental message
content composing `ACP_TRAEX_OK`, a final end-turn result, and the close command
exits 0. If login is unavailable, record the smoke as skipped rather than
changing ACP Bridge to perform login.

- [ ] **Step 5: Enforce the branch scope**

Run:

```bash
git diff --name-only main...HEAD
git status --short
```

Expected tracked paths:

```text
docs/superpowers/plans/2026-08-11-acp-bridge-traex-native-support.md
docs/superpowers/specs/2026-08-11-acp-bridge-traex-native-support-design.md
packages/aamp-acp-bridge/README.md
packages/aamp-acp-bridge/package.json
packages/aamp-acp-bridge/src/agent-resolver.ts
packages/aamp-acp-bridge/src/cli/init.ts
packages/aamp-acp-bridge/src/discovery.ts
packages/aamp-acp-bridge/test/agent-resolver.test.ts
packages/aamp-acp-bridge/test/discovery.test.ts
packages/aamp-acp-bridge/test/init.test.ts
packages/aamp-acp-bridge/test/json-init.test.ts
packages/aamp-acp-bridge/test/path-fixture.ts
```

No path under any Feishu package or `packages/aamp-cli-bridge` may appear.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/aamp-acp-bridge/README.md
git commit -m "docs(acp-bridge): document native Traex setup"
```

- [ ] **Step 7: Record the final commit sequence**

Run:

```bash
git log --oneline main..HEAD
```

Expected implementation commits after the already committed design and plan:

```text
docs(acp-bridge): document native Traex setup
feat(acp-bridge): expose Traex in init and discovery
feat(acp-bridge): add native Traex profile
```
