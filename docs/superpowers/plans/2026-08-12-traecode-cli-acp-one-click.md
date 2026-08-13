# TraeCode CLI ACP One-click Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the external `traecli` distribution as canonical TraeCode CLI, route it through native ACP, guide old clients through a consented update, and persist/display it distinctly from internal Coco and Trae CLI Next.

**Architecture:** First add a self-contained `traecli -> traecli acp serve` native profile to ACP Bridge so that commit can be moved directly after the existing Traex commit. Then add a small, testable Node helper for bounded ACP/doctor checks and extend the Task Agent bootstrap/controller with distribution-aware discovery, explicit update consent, stable binding identity, and approved product labels. The existing ACP streaming and Feishu Task runtime remain unchanged.

**Tech Stack:** Bash, Node.js ESM, TypeScript, `node:test`, `tsx`, npm, native ACP over stdio, `acpx`.

## Global Constraints

- Automatic Trae-family discovery order is exactly `traex -> coco -> traecli` and exposes at most one Trae-family choice.
- Display `coco` as `Trae CLI（内部版）`, `traex` as `Trae CLI Next（内部版）`, and external `traecli` as `TraeCode CLI`.
- Persist the external product as `agent_type: "traecli"`; do not persist `coco` as a new agent type.
- A saved or explicit `traecli` binding never falls back to `traex` or `coco`.
- A pending historical `trae` binding may normalize to `traex` or `traecli`; a ready historical `trae` binding retains its stored mailbox identity and reports its resolved runtime product.
- Both `traex` and `traecli` use native ACP. Never route TraeCode CLI through `aamp-cli-bridge` and do not modify its Coco profile.
- Probe TraeCode ACP with a bounded `traecli acp serve --help`; require both an `acp serve` usage marker and `Start the ACP server`, because unknown commands can print root help and exit zero.
- If ACP is absent, execute `traecli update` only after affirmative terminal confirmation, then refresh discovery and revalidate ACP.
- Never execute `traecli login`, `traecli login status`, or scripted `/status`.
- Parse bounded `traecli doctor --json`; warnings may continue, while every error blocks startup and the `model` error gets dedicated `/model` guidance.
- Do not expose raw doctor JSON or unsanitized home-directory paths in user-facing errors.
- Generated commands omit `--yolo`.
- Do not bump package versions or publish npm packages in these implementation tasks.
- Preserve WorkBuddy, Codex, Cursor, internal Traex, task-step, and stream-event behavior.
- The first implementation commit changes only `packages/aamp-acp-bridge/**` and is titled `feat(acp-bridge): add native TraeCode CLI support`.
- A successful build, ACP help probe, or bridge startup is not Feishu Task end-to-end acceptance.

---

## File Structure

- Modify `packages/aamp-acp-bridge/src/agent-resolver.ts`: register canonical `traecli` and map its raw native ACP command.
- Modify `packages/aamp-acp-bridge/test/agent-resolver.test.ts`: resolver identity, command, default, and no-fallback coverage.
- Modify `packages/aamp-acp-bridge/test/discovery.test.ts`: installed/missing canonical discovery coverage.
- Modify `packages/aamp-acp-bridge/test/init.test.ts`: forced interactive-init acceptance and missing-command message.
- Modify `packages/aamp-acp-bridge/test/json-init.test.ts`: default and explicit command persistence.
- Modify `packages/aamp-acp-bridge/README.md`: direct ACP Bridge setup for TraeCode CLI.
- Create `packages/aamp-feishu-task-agent/bin/traecode-readiness.mjs`: bounded subprocess execution, ACP-help recognition, doctor parsing, sanitization, and CLI exit contract.
- Create `packages/aamp-feishu-task-agent/test/traecode-readiness.test.mjs`: pure-parser and bounded-command tests.
- Create `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`: discovery priority, alias conflict, upgrade, doctor, ACP command, and controller contracts.
- Modify `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`: identity-aware executable discovery and TraeCode preparation.
- Modify `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`: allowlist, persistence normalization, runtime grouping, labels, and failures.
- Modify `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`: replace obsolete legacy-alias/display expectations with the three-product contract.
- Modify `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`: package completeness and split executable-resolution coverage.
- Modify `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`: update shared allowlist/help assertions without changing WorkBuddy behavior.
- Modify `packages/aamp-feishu-task-agent/README.md`: one-click behavior, upgrade, doctor remediation, and saved identity.
- Modify `docs/AGENT_SETUP.md`: native ACP setup for canonical `traecli` and separation from Coco.

---

### Task 1: Add the Standalone ACP Bridge Native Identity

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Modify: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Modify: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Modify: `packages/aamp-acp-bridge/test/init.test.ts`
- Modify: `packages/aamp-acp-bridge/test/json-init.test.ts`
- Modify: `packages/aamp-acp-bridge/README.md`

**Interfaces:**
- Consumes: existing `KNOWN_AGENTS`, `detectKnownAgent(name)`, `defaultAgentCommand(name)`, `defaultAcpCommand(name, previousCommand?)`, `missingAgentWarning(name)`, discovery, and JSON/interactive init contracts.
- Produces: canonical ACP agent `traecli`; `detectKnownAgent('traecli')?.acpCommand === 'traecli acp serve'`; `defaultAcpCommand('traecli') === 'traecli acp serve'`.
- Commit boundary: no path outside `packages/aamp-acp-bridge/**`; no dependency on Task Agent, WorkBuddy-specific behavior, or one-click product detection.

**Movability rule:** keep every semantic change additive to the Traex profile:
one registry entry, one ACP-command branch, isolated `traecli` test cases, and
one README section. Do not refactor WorkBuddy or depend on Task Agent behavior.
The current resolver/tests share list context with the later WorkBuddy commit,
so moving this commit behind Traex may require textual conflict resolution,
but the commit's behavior and file scope remain independently movable.

- [ ] **Step 1: Write failing native-profile tests**

Replace the canonical-name test in `test/agent-resolver.test.ts` with:

```ts
test('registers canonical Traex and TraeCode CLI names', () => {
  for (const name of ['traex', 'traecli']) {
    assert.equal(KNOWN_AGENTS.filter((candidate) => candidate === name).length, 1)
  }
  for (const nonNativeName of ['trae', 'coco']) {
    assert.equal(KNOWN_AGENTS.some((name) => name === nonNativeName), false)
  }
})

test('detects native TraeCode CLI and maps its ACP command', () => {
  withFakePath([{ name: 'traecli', version: 'trae-cli version 0.120.52' }], () => {
    assert.deepEqual(detectKnownAgent('traecli'), {
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: expectedFakePathVersion('trae-cli version 0.120.52'),
    })
    assert.equal(defaultAgentCommand('traecli'), 'traecli')
    assert.equal(defaultAcpCommand('traecli'), 'traecli acp serve')
  })
})

test('TraeCode CLI never falls back to internal Traex or Coco commands', () => {
  withFakePath([
    { name: 'traex', version: 'internal next' },
    { name: 'coco', version: 'internal legacy' },
  ], () => {
    assert.equal(detectKnownAgent('traecli'), undefined)
    assert.equal(defaultAgentCommand('traecli'), 'traecli')
    assert.equal(defaultAcpCommand('traecli'), 'traecli acp serve')
    assert.equal(missingAgentWarning('traecli'), 'traecli was not found on PATH.')
  })
})
```

Add to `test/discovery.test.ts`:

```ts
test('discovers an installed native TraeCode CLI executable', () => {
  withFakePath([{ name: 'traecli', version: 'trae-cli version 0.120.52' }], (directory) => {
    assert.deepEqual(findCandidate(join(directory, 'missing-config.json'), 'traecli'), {
      id: 'traecli',
      displayName: 'traecli',
      connection: 'acp_bridge',
      detected: true,
      configured: false,
      confidence: 'high',
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: expectedFakePathVersion('trae-cli version 0.120.52'),
      warnings: [],
    })
  })
})

test('reports the canonical TraeCode CLI default when it is missing', () => {
  withFakePath([], (directory) => {
    const candidate = findCandidate(join(directory, 'missing-config.json'), 'traecli')
    assert.equal(candidate.detected, false)
    assert.equal(candidate.command, 'traecli')
    assert.equal(candidate.acpCommand, 'traecli acp serve')
    assert.deepEqual(candidate.warnings, ['traecli was not found on PATH.'])
  })
})
```

Change the non-native assertion in that file to check only `['trae', 'coco']`.
Extend the existing Windows lookup fixture with `traecli.CMD`:

```ts
test('Windows lookup discovers canonical TraeCode wrappers through PATHEXT', () => {
  withFakePath([{ name: 'traecli.CMD', version: 'trae-cli version 0.120.52' }], (directory) => {
    const env = { PATH: directory, PATHEXT: '.EXE;.CMD' }
    assert.equal(
      findExecutableOnPath('traecli', { platform: 'win32', env }),
      join(directory, 'traecli.CMD'),
    )
  })
})
```

In `test/init.test.ts`, accept `traecli` and add its missing message:

```ts
test('interactive init accepts canonical Traex, TraeCode CLI, and WorkBuddy names', () => {
  assert.deepEqual(resolveInitScanTargets('traex'), ['traex'])
  assert.deepEqual(resolveInitScanTargets('traecli'), ['traecli'])
  assert.deepEqual(resolveInitScanTargets('workbuddy'), ['workbuddy'])
  for (const nonNativeName of ['trae', 'coco']) {
    assert.throws(
      () => resolveInitScanTargets(nonNativeName),
      new RegExp(`Unknown ACP agent "${nonNativeName}"`),
    )
  }
  assert.equal(
    noAgentsFoundMessage('traecli'),
    'No ACP agent found. traecli was not found on PATH.',
  )
})
```

Add to `test/json-init.test.ts`:

```ts
test('JSON init supplies the native TraeCode CLI ACP command', async () => {
  await withCredentials('traecli', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traecli', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, 'traecli acp serve')
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'traecli')
    assert.equal(written.agents[0].acpCommand, 'traecli acp serve')
    assert.equal(written.agents[0].slug, 'traecli-bridge')
  })
})

test('JSON init preserves an explicit TraeCode CLI command', async () => {
  await withCredentials('traecli', async ({ configPath, credentialsFile }) => {
    const command = 'env TRAE_CONFIG_DIR=/tmp/fixture traecli acp serve'
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traecli', acpCommand: command, credentialsFile }],
    })
    assert.equal(result.agents[0].acpCommand, command)
  })
})
```

- [ ] **Step 2: Run the focused ACP tests and confirm RED**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test \
  test/agent-resolver.test.ts \
  test/discovery.test.ts \
  test/init.test.ts \
  test/json-init.test.ts
```

Expected: FAIL because `traecli` is absent from `KNOWN_AGENTS`, resolves to the generic command, and is rejected by forced init.

- [ ] **Step 3: Implement the minimal native mapping**

In `src/agent-resolver.ts`, add `traecli` to the registry and native command mapping while leaving every other branch unchanged:

```ts
export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'traecli',
  'hermes', 'traex', 'workbuddy',
] as const

function baseAcpCommand(name: string, command = defaultAgentCommand(name)): string {
  if (name === 'hermes') return 'hermes acp'
  if (name === 'traex' || name === 'traecli') return `${command} acp serve`
  if (name === 'workbuddy') return WORKBUDDY_APP_ACP_COMMAND
  return name
}
```

Do not add distribution detection, version gating, `doctor`, update, or fallback logic here. Direct ACP Bridge callers selecting `traecli` explicitly request that executable.

- [ ] **Step 4: Document direct ACP Bridge use**

Add this section immediately after the Traex section in `packages/aamp-acp-bridge/README.md`:

```markdown
### TraeCode CLI

The external TraeCode CLI exposes native ACP through `traecli acp serve`:

```bash
npx aamp-acp-bridge init --agent traecli
```

The generated agent entry uses canonical name `traecli` and command
`traecli acp serve`. ACP Bridge does not update TraeCode CLI or inspect its
login/model state; prepare the client before starting the bridge. The generated
command omits `--yolo`.
```

In the preceding Traex section, change the stale sentence that lists
`traecli` as a legacy non-native name. It must say only `trae` and `coco` are
not native identities; TraeCode CLI is the separate canonical `traecli`
identity documented here.

- [ ] **Step 5: Verify GREEN, build, and commit the movable unit**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build
cd ../..
git diff --check
git add packages/aamp-acp-bridge
git diff --cached --name-only
```

Expected: all ACP Bridge tests and TypeScript build pass. Every staged line
begins with `packages/aamp-acp-bridge/`; no Task Agent or repository-level
documentation is staged. `git diff --cached` contains no Task Agent symbol or
WorkBuddy behavior change.

Commit:

```bash
git commit -m "feat(acp-bridge): add native TraeCode CLI support"
git show --name-only --format= HEAD | sed '/^$/d'
```

Expected: the commit contains only `packages/aamp-acp-bridge/**`. This is the commit that may later be moved directly after the existing native Traex support commit.

---

### Task 2: Add a Bounded TraeCode Readiness Helper

**Files:**
- Create: `packages/aamp-feishu-task-agent/bin/traecode-readiness.mjs`
- Create: `packages/aamp-feishu-task-agent/test/traecode-readiness.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`

**Interfaces:**
- Produces: `supportsTraeCodeAcpHelp(output): boolean`; `parseTraeCodeDoctor(raw, homeDir?): { status, warnings, errors }`; CLI actions `probe-acp <bin> <timeoutSeconds>` and `doctor <bin> <timeoutSeconds>`.
- CLI exit contract: `0` supported/ready, `3` ACP unsupported, `10` model required, `11` another doctor error, `65` invalid doctor output, `70` execution/output-limit failure, `124` timeout, `127` missing executable.
- Output contract: the helper emits only bounded, sanitized diagnostics; it never invokes login, status, update, or ACP serving without `--help`.

- [ ] **Step 1: Write failing parser and process tests**

Create `test/traecode-readiness.test.mjs` with these cases:

```js
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseTraeCodeDoctor,
  supportsTraeCodeAcpHelp,
} from '../bin/traecode-readiness.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const helper = path.resolve(testDir, '../bin/traecode-readiness.mjs')

test('ACP detection requires serve usage and the dedicated description', () => {
  assert.equal(supportsTraeCodeAcpHelp(`
Start the ACP server
Usage:
  trae-cli acp serve [flags]
`), true)
  assert.equal(supportsTraeCodeAcpHelp(`
Available Commands:
  acp Agent Client Protocol commands
`), false)
  assert.equal(supportsTraeCodeAcpHelp('Usage: traecli acp serve [flags]'), false)
})

test('doctor exit-two JSON is parsed by checks, with model guidance preserved', () => {
  const result = parseTraeCodeDoctor(JSON.stringify({
    checks: [
      { name: 'binary', severity: 'info', message: '/Users/test/.local/bin/traecli' },
      { name: 'model', severity: 'error', message: 'no effective model configured', fix: 'use /model to pick one' },
    ],
  }), '/Users/test')
  assert.equal(result.status, 'model_required')
  assert.deepEqual(result.errors, [{
    name: 'model',
    severity: 'error',
    message: 'no effective model configured',
    fix: 'use /model to pick one',
  }])
  assert.doesNotMatch(JSON.stringify(result), /\/Users\/test/)
})

test('doctor warnings continue and malformed JSON is rejected', () => {
  assert.deepEqual(parseTraeCodeDoctor(JSON.stringify({ checks: [
    { name: 'update', severity: 'warning', message: 'new version available' },
  ] })), {
    status: 'ready',
    warnings: [{ name: 'update', severity: 'warning', message: 'new version available' }],
    errors: [],
  })
  assert.throws(() => parseTraeCodeDoctor('{broken'), /valid JSON/)
  assert.throws(() => parseTraeCodeDoctor('{}'), /checks array/)
  assert.throws(() => parseTraeCodeDoctor(JSON.stringify({ checks: [null] })), /check 0 is invalid/)
})

test('CLI probe rejects root help even when the command exits zero', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, '#!/bin/sh\nprintf "Available Commands:\\n  acp Agent Client Protocol commands\\n"\n')
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '2'], { encoding: 'utf8' })
  assert.equal(result.status, 3)
})

test('CLI probe accepts only a successful dedicated ACP help response', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, '#!/bin/sh\nprintf "Start the ACP server\\nUsage: trae-cli acp serve [flags]\\n"\n')
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '2'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('CLI probe timeout is distinct from unsupported ACP help', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'probe-acp', fake, '1'], {
    encoding: 'utf8', timeout: 4_000,
  })
  assert.equal(result.status, 124)
})

test('CLI doctor is bounded and never invokes login/status', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const fake = path.join(directory, 'traecli')
  writeFileSync(fake, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'doctor --json') process.exit(90)
setTimeout(() => {}, 60_000)
`)
  chmodSync(fake, 0o755)
  const result = spawnSync(process.execPath, [helper, 'doctor', fake, '1'], {
    encoding: 'utf8', timeout: 4_000,
  })
  assert.equal(result.status, 124)
})

test('CLI doctor rejects unsupported exits and oversized output safely', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'traecode-helper-'))
  const unsupported = path.join(directory, 'unsupported')
  writeFileSync(unsupported, '#!/bin/sh\nprintf "{}"\nexit 9\n')
  chmodSync(unsupported, 0o755)
  assert.equal(
    spawnSync(process.execPath, [helper, 'doctor', unsupported, '2']).status,
    70,
  )

  const noisy = path.join(directory, 'noisy')
  writeFileSync(noisy, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024))\n`)
  chmodSync(noisy, 0o755)
  assert.equal(
    spawnSync(process.execPath, [helper, 'doctor', noisy, '2'], { timeout: 5_000 }).status,
    70,
  )
})
```

- [ ] **Step 2: Run the helper test and confirm RED**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/traecode-readiness.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `bin/traecode-readiness.mjs`.

- [ ] **Step 3: Implement the complete helper**

Create `bin/traecode-readiness.mjs`:

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_OUTPUT_BYTES = 1024 * 1024
const EXIT = Object.freeze({ unsupported: 3, model: 10, blocked: 11, invalid: 65, execution: 70, timeout: 124, missing: 127 })

function cleanText(value, homeDir = '') {
  if (typeof value !== 'string') return undefined
  let text = value.replace(/\s+/g, ' ').trim()
  if (homeDir) text = text.split(homeDir).join('~')
  if (!text) return undefined
  return text.slice(0, 400)
}

export function supportsTraeCodeAcpHelp(output) {
  const text = String(output || '')
  return /\bacp\s+serve\b/i.test(text) && /Start the ACP server/i.test(text)
}

export function parseTraeCodeDoctor(raw, homeDir = '') {
  let document
  try {
    document = JSON.parse(String(raw || ''))
  } catch {
    throw new Error('TraeCode doctor did not return valid JSON')
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.checks)) {
    throw new Error('TraeCode doctor JSON is missing a checks array')
  }

  const checks = document.checks.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`TraeCode doctor check ${index} is invalid`)
    }
    const name = cleanText(value.name, homeDir)
    const severity = cleanText(value.severity, homeDir)?.toLowerCase()
    const message = cleanText(value.message, homeDir)
    const fix = cleanText(value.fix, homeDir)
    if (!name || !['info', 'warning', 'error'].includes(severity) || !message) {
      throw new Error(`TraeCode doctor check ${index} is invalid`)
    }
    return { name, severity, message, ...(fix ? { fix } : {}) }
  })
  const warnings = checks.filter((check) => check.severity === 'warning')
  const errors = checks.filter((check) => check.severity === 'error')
  return {
    status: errors.length === 0
      ? 'ready'
      : errors.some((check) => check.name.toLowerCase() === 'model')
        ? 'model_required'
        : 'blocked',
    warnings,
    errors,
  }
}

function formatChecks(checks) {
  return checks.map((check) => {
    const suffix = check.fix ? `；建议：${check.fix}` : ''
    return `${check.name}: ${check.message}${suffix}`
  }).join('\n')
}

function runBounded(command, args, timeoutSeconds) {
  const timeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 10) * 1000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let total = 0
    let timedOut = false
    let outputLimited = false
    let settled = false
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let killTimer
    const terminate = () => {
      child.kill('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 500)
      killTimer.unref()
    }
    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      total += Buffer.byteLength(text)
      if (total > MAX_OUTPUT_BYTES) {
        outputLimited = true
        terminate()
        return target
      }
      return target + text
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ spawnError: error, stdout, stderr, timedOut, outputLimited })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ code, signal, stdout, stderr, timedOut, outputLimited })
    })
  })
}

async function main() {
  const [action, command, timeoutRaw] = process.argv.slice(2)
  if (!['probe-acp', 'doctor'].includes(action) || !command) process.exit(64)
  const result = await runBounded(command, action === 'probe-acp'
    ? ['acp', 'serve', '--help']
    : ['doctor', '--json'], Number(timeoutRaw || '10'))
  if (result.timedOut) process.exit(EXIT.timeout)
  if (result.outputLimited) process.exit(EXIT.execution)
  if (result.spawnError) process.exit(result.spawnError.code === 'ENOENT' ? EXIT.missing : EXIT.execution)

  if (action === 'probe-acp') {
    process.exit(result.code === 0 && supportsTraeCodeAcpHelp(`${result.stdout}\n${result.stderr}`)
      ? 0
      : EXIT.unsupported)
  }

  if (![0, 1, 2].includes(result.code)) {
    process.stderr.write(cleanText(result.stderr || result.stdout, process.env.HOME) || 'TraeCode doctor failed')
    process.exit(EXIT.execution)
  }
  let parsed
  try {
    parsed = parseTraeCodeDoctor(result.stdout, process.env.HOME || '')
  } catch (error) {
    process.stderr.write(error.message)
    process.exit(EXIT.invalid)
  }
  if (parsed.status === 'ready') {
    if (parsed.warnings.length) process.stdout.write(formatChecks(parsed.warnings))
    process.exit(0)
  }
  process.stdout.write(formatChecks(parsed.errors))
  process.exit(parsed.status === 'model_required' ? EXIT.model : EXIT.blocked)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(cleanText(error?.message || error, process.env.HOME) || 'TraeCode readiness check failed')
    process.exit(EXIT.execution)
  })
}
```

- [ ] **Step 4: Require the packaged helper**

In `task_agent_global_install_is_complete()` add:

```bash
[ -r "$package_dir/bin/traecode-readiness.mjs" ] || return 1
```

In `test/bootstrap.test.mjs`, add this assertion to the package-completeness test:

```js
assert.equal(
  packageJson.files.includes('bin'),
  true,
  'the packaged bin directory must include traecode-readiness.mjs',
)
```

Also prove the bootstrap completeness function checks the concrete helper,
not merely the broad `files: ["bin"]` manifest entry:

```js
test('global Task Agent installation requires the TraeCode readiness helper', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const completeness = source.slice(
    source.indexOf('task_agent_global_install_is_complete()'),
    source.indexOf('\ntask_agent_global_install_is_current()', source.indexOf('task_agent_global_install_is_complete()')),
  )
  assert.match(completeness, /bin\/traecode-readiness\.mjs/)
})
```

- [ ] **Step 5: Verify the helper and Task Agent suite are GREEN**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/traecode-readiness.test.mjs test/bootstrap.test.mjs
npm test
cd ../..
git diff --check
```

Expected: helper and full Task Agent tests pass; the new helper is included by
the existing `files: ["bin"]` package rule.

- [ ] **Step 6: Commit the readiness helper**

```bash
git add packages/aamp-feishu-task-agent/bin/traecode-readiness.mjs \
  packages/aamp-feishu-task-agent/test/traecode-readiness.test.mjs \
  packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh \
  packages/aamp-feishu-task-agent/test/bootstrap.test.mjs
git commit -m "feat(task-agent): add bounded TraeCode readiness checks"
```

---

### Task 3: Implement Distribution-aware Discovery, Update, Doctor, and ACP Preparation

**Files:**
- Create: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh`
- Modify: `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/bootstrap.test.mjs`

**Interfaces:**
- Consumes: Task 2 helper CLI and existing internal preparation result `{ agent_type, acp_command, lark_cli_config_dir }`.
- Produces: `find_coco_cli()`, `find_traecode_cli()`, `ensure_traecode_ready()`, automatic priority `traex -> coco -> traecli`, and exact external ACP command `<resolved-traecli> acp serve`.
- Cancellation contract: refusal to update sets `AGENT_PREPARE_CANCELLED=true` and a human-readable reason, matching the existing Coco upgrade path.

- [ ] **Step 1: Write failing discovery and alias-identity tests**

Create `test/traecode-one-click.test.mjs`. Start with this complete isolated
harness; every fake executable and binding store lives under `mkdtemp`, and no
fixture reads the user's normal AAMP or Trae state:

```js
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(testDir, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const controller = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')
const readinessHelper = path.resolve(testDir, '../bin/traecode-readiness.mjs')
const nodeBinDir = path.dirname(process.execPath)

function functionRange(source, startName, endName) {
  const start = source.indexOf(startName)
  const end = source.indexOf(`\n${endName}`, start)
  assert.notEqual(start, -1, `${startName} must exist`)
  assert.notEqual(end, -1, `${endName} must follow ${startName}`)
  return source.slice(start, end)
}

function runShell(lines, args = []) {
  return spawnSync('bash', ['-c', lines.join('\n'), 'bash', ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  })
}

function writeExecutable(file, body = 'exit 0') {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(file, 0o755)
}

function resolutionFunctions(source) {
  return functionRange(source, 'resolve_trae_cli_candidate()', 'find_workbuddy_cli()')
}

function ensureCliFunction(source) {
  return functionRange(source, 'ensure_agent_cli()', 'clear_quarantine_path()')
}

function readinessFunctions(source) {
  return functionRange(source, 'traecode_readiness_helper_path()', 'ensure_agent_login()')
}

function acpCommandFunctions(source) {
  return functionRange(source, 'acp_command_word()', 'validate_codex_acp_command()')
}

function runDiscoveryFixture(names) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-discovery-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(path.join(binDir, name))
  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT=""',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'DETECTED_AGENTS=()',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_workbuddy_cli() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    'discover_interactive_agents',
    'printf "%s" "${DETECTED_AGENTS[*]}"',
  ], [binDir, nodeBinDir])
  return { ...result, stdout: result.stdout.trim() }
}

function runDiscoveryNoExecFixture(names) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-discovery-noexec-'))
  const binDir = path.join(root, 'bin')
  const callLog = path.join(root, 'calls.log')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(
    path.join(binDir, name),
    `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}\nexit 91`,
  )
  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT=""',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'DETECTED_AGENTS=()',
    'resolve_codex_cli_for_acp() { return 1; }',
    'find_cursor_agent_cli() { return 1; }',
    'find_workbuddy_cli() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    functionRange(source, 'agent_cli_detected()', 'move_agent_menu_cursor_up()'),
    'discover_interactive_agents',
  ], [binDir, nodeBinDir])
  return { ...result, callLog }
}

function runAliasedFixture({ agent, sharedTarget }) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-alias-'))
  const binDir = path.join(root, 'bin')
  mkdirSync(binDir)
  const target = path.join(root, 'internal-coco')
  writeExecutable(target)
  symlinkSync(target, path.join(binDir, 'coco'))
  if (sharedTarget) symlinkSync(target, path.join(binDir, 'traecli'))
  else writeExecutable(path.join(binDir, 'traecli'))
  return runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT="$3"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'is_macos() { return 0; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'find_cursor_agent_cli() { return 1; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    ensureCliFunction(source),
    'ensure_agent_cli',
  ], [binDir, nodeBinDir, agent])
}

function runPreparedFixture({ names, agent, pathWithSpace = false }) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-prepared-'))
  const binDir = path.join(root, pathWithSpace ? 'bin with space' : 'bin')
  mkdirSync(binDir)
  for (const name of names) writeExecutable(path.join(binDir, name))
  return runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'AGENT="$3"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'ACP_AGENT_COMMAND=""',
    'WORKBUDDY_APP_CLI="/missing/WorkBuddy.app/codebuddy"',
    'is_macos() { return 0; }',
    'ensure_codem_local_bin_on_path() { :; }',
    'find_cursor_agent_cli() { return 1; }',
    'resolve_codex_cli_for_acp() { return 1; }',
    'agent_detail() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    ensureCliFunction(source),
    acpCommandFunctions(source),
    'ensure_agent_cli',
    'build_acp_agent_command',
    'printf "%s|%s" "$AGENT" "$ACP_AGENT_COMMAND"',
  ], [binDir, nodeBinDir, agent])
}

function runTraeCodePreparation({
  initialAcp,
  consent,
  doctor,
  updateFails = false,
  updateStillMissingAcp = false,
  removeAfterUpdate = false,
}) {
  const source = readFileSync(bootstrap, 'utf8')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traecode-prepare-'))
  const binDir = path.join(root, 'bin')
  const fake = path.join(binDir, 'traecli')
  const callLog = path.join(root, 'calls.log')
  const updateMarker = path.join(root, 'updated')
  mkdirSync(binDir)
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TEST_CALL_LOG, args.join(' ') + '\\n')
if (args.join(' ') === 'acp serve --help') {
  const supported = process.env.TEST_INITIAL_ACP === 'true'
    || (fs.existsSync(process.env.TEST_UPDATE_MARKER) && process.env.TEST_UPDATE_STILL_MISSING !== 'true')
  process.stdout.write(supported
    ? 'Start the ACP server\\nUsage: trae-cli acp serve [flags]\\n'
    : 'Available Commands:\\n  acp Agent Client Protocol commands\\n')
  process.exit(0)
}
if (args.join(' ') === 'update') {
  if (process.env.TEST_UPDATE_FAILS === 'true') process.exit(9)
  fs.writeFileSync(process.env.TEST_UPDATE_MARKER, 'updated')
  if (process.env.TEST_REMOVE_AFTER_UPDATE === 'true') {
    fs.renameSync(process.argv[1], process.argv[1] + '.removed')
  }
  process.exit(0)
}
if (args.join(' ') === 'doctor --json') {
  const mode = process.env.TEST_DOCTOR
  if (mode === 'malformed') { process.stdout.write('{broken'); process.exit(2) }
  const checks = mode === 'model'
    ? [{ name: 'model', severity: 'error', message: 'no effective model configured', fix: 'use /model to pick one' }]
    : mode === 'other'
      ? [{ name: 'auth', severity: 'error', message: 'authorization unavailable', fix: 'open TraeCode CLI' }]
      : mode === 'warning'
        ? [{ name: 'update', severity: 'warning', message: 'new version available' }]
        : [{ name: 'binary', severity: 'info', message: process.argv[1] }]
  process.stdout.write(JSON.stringify({ checks }))
  process.exit(checks.some((check) => check.severity === 'error') ? 2 : 0)
}
process.exit(90)
`)
  chmodSync(fake, 0o755)

  const result = runShell([
    'set -euo pipefail',
    'PATH="$1:$2:/usr/bin:/bin"',
    'TEST_CALL_LOG="$3"',
    'TEST_UPDATE_MARKER="$4"',
    'TEST_INITIAL_ACP="$5"',
    'TEST_DOCTOR="$6"',
    'TEST_CONSENT="$7"',
    'TEST_UPDATE_FAILS="$8"',
    'TEST_UPDATE_STILL_MISSING="$9"',
    'TEST_REMOVE_AFTER_UPDATE="${10}"',
    'export TEST_CALL_LOG TEST_UPDATE_MARKER TEST_INITIAL_ACP TEST_DOCTOR TEST_UPDATE_FAILS TEST_UPDATE_STILL_MISSING TEST_REMOVE_AFTER_UPDATE',
    'AGENT="traecli"',
    'AAMP_TRAE_CLI_BIN=""',
    'AAMP_TRAECODE_CLI_BIN=""',
    'AAMP_TRAECODE_CHECK_TIMEOUT_SECONDS=2',
    'AAMP_TRAECODE_READINESS_HELPER="${11}"',
    'TRAE_CLI_BIN=""',
    'TRAECODE_CLI_BIN=""',
    'ACP_AGENT_COMMAND=""',
    'AGENT_PREPARE_CANCELLED="false"',
    'AGENT_PREPARE_CANCEL_REASON=""',
    'agent_detail() { :; }',
    'agent_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    resolutionFunctions(source),
    readinessFunctions(source),
    acpCommandFunctions(source),
    'confirm_traecode_update() { case "$TEST_CONSENT" in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac; }',
    'ensure_traecode_ready',
    'if [ "$AGENT_PREPARE_CANCELLED" != "true" ]; then build_acp_agent_command; fi',
    'printf "RESULT:%s|%s|%s|%s\\n" "$AGENT" "$ACP_AGENT_COMMAND" "$AGENT_PREPARE_CANCELLED" "$AGENT_PREPARE_CANCEL_REASON"',
  ], [
    binDir,
    nodeBinDir,
    callLog,
    updateMarker,
    String(initialAcp),
    doctor,
    consent === true ? 'yes' : consent === false ? 'no' : 'no-tty',
    String(updateFails),
    String(updateStillMissingAcp),
    String(removeAfterUpdate),
    readinessHelper,
  ])
  const marker = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'))
  const fields = marker ? marker.slice('RESULT:'.length).split('|') : []
  return {
    ...result,
    agent: fields[0] || '',
    command: fields[1] || '',
    cancelled: fields[2] === 'true',
    reason: fields.slice(3).join('|'),
    calls: existsSync(callLog)
      ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
      : [],
  }
}

function runControllerListFixture({ agent_type }) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-traecode-'))
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
      agent_type,
      aamp_host: 'https://meshmail.ai',
      environment: { name: 'online' },
      bot: {
        app_id: 'cli_traecode_test',
        app_secret: 'test-only-secret',
        display_name: 'TraeCode test Bot',
        lark_cli_profile: 'traecode-test-profile',
      },
      feishu_config_dir: path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge'),
      state: 'pending',
    }],
  }, null, 2)}\n`)
  return spawnSync(process.execPath, [controller, 'list'], {
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
}
```

Then add these assertions:

```js
test('Trae-family discovery is traex, then coco, then external traecli', () => {
  const scenarios = [
    { names: ['traex', 'coco', 'traecli'], expected: 'traex' },
    { names: ['coco', 'traecli'], expected: 'trae' },
    { names: ['traecli'], expected: 'traecli' },
  ]
  for (const scenario of scenarios) {
    const result = runDiscoveryFixture(scenario.names)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, scenario.expected)
  }
})

test('Trae-family discovery resolves executables without invoking them', () => {
  for (const names of [['traex'], ['coco'], ['traecli']]) {
    const result = runDiscoveryNoExecFixture(names)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(result.callLog), false)
  }
})

test('explicit TraeCode selection rejects a traecli alias of coco', () => {
  const result = runAliasedFixture({ agent: 'traecli', sharedTarget: true })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /Trae CLI（内部版）/)
  assert.match(result.stderr, /TraeCode CLI/)
})

test('explicit and saved TraeCode selection remains exact when traex also exists', () => {
  const result = runPreparedFixture({ names: ['traex', 'traecli'], agent: 'traecli' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /traecli\|.*\/traecli acp serve$/)
  assert.doesNotMatch(result.stdout, /traex acp serve/)
})

test('resolved TraeCode commands quote an executable path containing spaces', () => {
  const result = runPreparedFixture({ names: ['traecli'], agent: 'traecli', pathWithSpace: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^traecli\|".*\/bin with space\/traecli" acp serve$/)
})
```

The fixture helpers create isolated executable files/symlinks, set
`AAMP_TRAE_CLI_BIN=""`, `AAMP_TRAECODE_CLI_BIN=""`, `TRAE_CLI_BIN=""`, and
`TRAECODE_CLI_BIN=""`, and source only the named bootstrap function ranges.
The no-exec fixture proves discovery may resolve files but never runs
`--version`, ACP help, doctor, update, or login.

- [ ] **Step 2: Write failing update and doctor flow tests**

Add these complete behavior cases to the same test file:

```js
test('old TraeCode CLI updates after consent, reprobes ACP, runs doctor, and never logs in', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: true, doctor: 'healthy' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.command, /\/traecli acp serve$/)
  assert.deepEqual(result.calls, [
    'acp serve --help',
    'update',
    'acp serve --help',
    'doctor --json',
  ])
})

test('declining a TraeCode update cancels without doctor or bridge command', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: false, doctor: 'healthy' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.cancelled, true)
  assert.match(result.reason, /用户取消升级/)
  assert.deepEqual(result.calls, ['acp serve --help'])
})

test('non-interactive old TraeCode CLI fails fast with the manual update command', () => {
  const result = runTraeCodePreparation({ initialAcp: false, consent: undefined, doctor: 'healthy' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /traecli update/)
  assert.deepEqual(result.calls, ['acp serve --help'])
})

test('failed or ineffective updates terminate without doctor or CLI Bridge fallback', () => {
  const failed = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', updateFails: true,
  })
  assert.equal(failed.status, 64)
  assert.match(failed.stderr, /升级失败/)
  assert.deepEqual(failed.calls, ['acp serve --help', 'update'])

  const ineffective = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', updateStillMissingAcp: true,
  })
  assert.equal(ineffective.status, 64)
  assert.match(ineffective.stderr, /升级后仍不支持 ACP/)
  assert.deepEqual(ineffective.calls, ['acp serve --help', 'update', 'acp serve --help'])
})

test('successful update must rediscover TraeCode CLI before reprobe', () => {
  const result = runTraeCodePreparation({
    initialAcp: false, consent: true, doctor: 'healthy', removeAfterUpdate: true,
  })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /升级后仍未检测到 TraeCode CLI/)
  assert.deepEqual(result.calls, ['acp serve --help', 'update'])
})

test('doctor model error gives login and /model guidance without a login command', () => {
  const result = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'model' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /打开 TraeCode CLI/)
  assert.match(result.stderr, /\/model/)
  assert.deepEqual(result.calls, ['acp serve --help', 'doctor --json'])
})

test('doctor warning-only result continues and malformed output fails safely', () => {
  const warning = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'warning' })
  assert.equal(warning.status, 0, warning.stderr)
  assert.match(warning.stdout, /诊断警告/)
  const malformed = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'malformed' })
  assert.equal(malformed.status, 64)
  assert.match(malformed.stderr, /诊断结果无法解析/)
})

test('other doctor errors surface only sanitized actionable checks', () => {
  const result = runTraeCodePreparation({ initialAcp: true, consent: false, doctor: 'other' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /auth: authorization unavailable/)
  assert.match(result.stderr, /open TraeCode CLI/)
  assert.doesNotMatch(result.stderr, /\{"checks"/)
})
```

The fake `traecli` writes every argument vector to a call log. Before its update marker exists, `acp serve --help` prints only root help and exits zero; `update` creates the marker; afterwards ACP help prints `Start the ACP server` plus `Usage: trae-cli acp serve [flags]`. Doctor fixtures emit `checks` JSON and use exit `2` for errors, matching the verified `0.120.52` contract. No expected call log contains `login`, `login status`, `/status`, or a CLI Bridge command.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/traecode-one-click.test.mjs
```

Expected: FAIL because `traecli` is still classified with legacy Coco and no TraeCode preparation functions exist.

- [ ] **Step 4: Split executable discovery by product identity**

Add near the existing Trae variables:

```bash
AAMP_TRAECODE_CLI_BIN="${AAMP_TRAECODE_CLI_BIN:-}"
AAMP_TRAECODE_CHECK_TIMEOUT_SECONDS="${AAMP_TRAECODE_CHECK_TIMEOUT_SECONDS:-10}"
AAMP_TRAECODE_READINESS_HELPER="${AAMP_TRAECODE_READINESS_HELPER:-}"
AAMP_TRAECODE_UPDATE_TTY="${AAMP_TRAECODE_UPDATE_TTY:-/dev/tty}"
TRAECODE_CLI_BIN=""
```

Keep `AAMP_TRAE_CLI_BIN`/`TRAE_CLI_BIN` internal-only. In
`find_traex_cli_candidates()`, remove the current `*:traex` escape hatch and
admit an override only when its basename is `traex`. The `coco` finder below
similarly admits only basename `coco`; the external finder is the only function
that reads `AAMP_TRAECODE_CLI_BIN`/`TRAECODE_CLI_BIN`.

Use these exact override clauses in `find_traex_cli_candidates()`:

```bash
if [ -n "$TRAE_CLI_BIN" ] && [ "$(basename "$TRAE_CLI_BIN")" = "traex" ]; then candidates+=("$TRAE_CLI_BIN"); fi
if [ -n "$AAMP_TRAE_CLI_BIN" ] && [ "$(basename "$AAMP_TRAE_CLI_BIN")" = "traex" ]; then candidates+=("$AAMP_TRAE_CLI_BIN"); fi
```

Replace legacy candidate resolution with three exact finders:

```bash
find_coco_cli_candidates() {
  local candidate resolved emitted=""
  local candidates=()
  if [ -n "$TRAE_CLI_BIN" ] && [ "$(basename "$TRAE_CLI_BIN")" = "coco" ]; then candidates+=("$TRAE_CLI_BIN"); fi
  if [ -n "$AAMP_TRAE_CLI_BIN" ] && [ "$(basename "$AAMP_TRAE_CLI_BIN")" = "coco" ]; then candidates+=("$AAMP_TRAE_CLI_BIN"); fi
  candidates+=("coco")
  for candidate in "${candidates[@]}"; do
    resolved="$(resolve_trae_cli_candidate "$candidate" || true)"
    [ -n "$resolved" ] || continue
    case "$emitted" in *"|$resolved|"*) continue ;; esac
    emitted="${emitted}|$resolved|"
    printf '%s\n' "$resolved"
  done
}

find_traecode_cli_candidates() {
  local candidate resolved emitted=""
  local candidates=()
  [ -n "$TRAECODE_CLI_BIN" ] && candidates+=("$TRAECODE_CLI_BIN")
  [ -n "$AAMP_TRAECODE_CLI_BIN" ] && candidates+=("$AAMP_TRAECODE_CLI_BIN")
  candidates+=("traecli")
  for candidate in "${candidates[@]}"; do
    resolved="$(resolve_trae_cli_candidate "$candidate" || true)"
    [ -n "$resolved" ] || continue
    case "$emitted" in *"|$resolved|"*) continue ;; esac
    emitted="${emitted}|$resolved|"
    printf '%s\n' "$resolved"
  done
}

real_executable_path() {
  node -e 'const fs=require("fs"); try { process.stdout.write(fs.realpathSync(process.argv[1])); } catch { process.exit(1); }' "$1"
}

find_coco_cli() {
  local candidate
  candidate="$(find_coco_cli_candidates | head -n 1)"
  [ -n "$candidate" ] || return 1
  TRAE_CLI_BIN="$candidate"
  printf '%s\n' "$candidate"
}

traecode_cli_conflicts_with_coco() {
  local traecli_bin="$1" coco_bin traecli_real coco_real
  coco_bin="$(find_coco_cli || true)"
  [ -n "$coco_bin" ] || return 1
  traecli_real="$(real_executable_path "$traecli_bin" || true)"
  coco_real="$(real_executable_path "$coco_bin" || true)"
  [ -n "$traecli_real" ] && [ "$traecli_real" = "$coco_real" ]
}

find_traecode_cli() {
  local candidate explicit_candidate=""
  if [ -n "$TRAECODE_CLI_BIN" ]; then explicit_candidate="$TRAECODE_CLI_BIN"; fi
  if [ -n "$AAMP_TRAECODE_CLI_BIN" ]; then explicit_candidate="$AAMP_TRAECODE_CLI_BIN"; fi
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if traecode_cli_conflicts_with_coco "$candidate"; then
      # An explicitly supplied external path must fail instead of silently
      # falling through to another product. PATH discovery may skip a known
      # Coco alias and continue to a later distinct candidate.
      if [ -n "$explicit_candidate" ] && [ "$candidate" = "$explicit_candidate" ]; then return 2; fi
      continue
    fi
    TRAECODE_CLI_BIN="$candidate"
    printf '%s\n' "$candidate"
    return 0
  done < <(find_traecode_cli_candidates)
  return 1
}

find_legacy_trae_cli() {
  find_coco_cli
}
```

ACP Bridge's existing executable resolver already handles Windows `PATHEXT`;
keep its canonical `traecli` tests on Windows so `.CMD`/`.EXE` wrappers remain
covered. The Task Agent one-click script remains POSIX-only in this change.

Keep `find_traex_cli()` exact. Update `resolve_trae_cli()` to select `traex`,
`coco`, or `traecli` only from the current canonical `AGENT`; never use the
old generic fallback branch. Add fixtures proving a `traex` override cannot
resolve `coco`/`traecli` and a TraeCode override cannot resolve `traex`.

- [ ] **Step 5: Implement discovery priority and preparation routing**

Extend validation and labels:

```bash
validate_agent_name() {
  case "$1" in
    codex|cursor|trae|traex|traecli|workbuddy) ;;
    *) agent_fail "--agent must be codex, cursor, trae, traex, traecli, or workbuddy" ;;
  esac
}

agent_display_name() {
  case "$1" in
    trae) printf '%s' "Trae CLI（内部版）" ;;
    traex) printf '%s' "Trae CLI Next（内部版）" ;;
    traecli) printf '%s' "TraeCode CLI" ;;
    *) printf '%s' "$1" ;;
  esac
}
```

Add `traecli)` to `agent_cli_detected`, and use this exact Trae-family branch in both `discover_interactive_agents` and `run_internal_discover_agents`:

```bash
if agent_cli_detected traex; then
  agents+=("traex")
elif agent_cli_detected trae; then
  agents+=("trae")
elif agent_cli_detected traecli; then
  agents+=("traecli")
fi
```

Use `DETECTED_AGENTS` instead of `agents` in the interactive variant.

In `ensure_agent_cli`, use exact preparation behavior:

```bash
if [ "$AGENT" = "traecli" ]; then
  local traecode_status
  set +e
  find_traecode_cli >/dev/null 2>&1
  traecode_status=$?
  set -e
  [ "$traecode_status" -ne 2 ] || agent_fail "检测到的 traecli 属于 Trae CLI（内部版），不能作为 TraeCode CLI 启动。"
  [ "$traecode_status" -eq 0 ] || agent_fail "未检测到 TraeCode CLI。请先安装 traecli 后重新运行脚本。"
  return 0
fi

if [ "$AGENT" = "trae" ]; then
  if find_traex_cli >/dev/null 2>&1; then return 0; fi
  if find_coco_cli >/dev/null 2>&1; then return 0; fi
  if find_traecode_cli >/dev/null 2>&1; then return 0; fi
  agent_fail "未检测到 Trae CLI（内部版）、Trae CLI Next（内部版）或 TraeCode CLI。"
fi
```

For historical `AGENT=trae`, `ensure_agent_cli()` deliberately leaves the
stored compatibility identity unchanged. `ensure_agent_login()` is the only
place that assigns the resolved runtime identity: Traex sets `AGENT=traex`,
Coco enters `maybe_upgrade_legacy_trae_cli`, and an unambiguous external
TraeCode binary sets `AGENT=traecli` before `ensure_traecode_ready`. This keeps
ready historical bindings stored as `trae` in the controller while returning
the actual runtime type in the preparation response.

- [ ] **Step 6: Implement ACP update and doctor gating**

Add these functions before `ensure_agent_login()`:

```bash
traecode_readiness_helper_path() {
  if [ -n "$AAMP_TRAECODE_READINESS_HELPER" ]; then printf '%s\n' "$AAMP_TRAECODE_READINESS_HELPER"; return 0; fi
  local helper
  helper="$(task_agent_global_package_dir)/bin/traecode-readiness.mjs"
  [ -r "$helper" ] || return 1
  printf '%s\n' "$helper"
}

run_traecode_check() {
  local action="$1" helper traecode_bin
  helper="$(traecode_readiness_helper_path)" || return 127
  traecode_bin="$(find_traecode_cli)" || return $?
  node "$helper" "$action" "$traecode_bin" "$AAMP_TRAECODE_CHECK_TIMEOUT_SECONDS"
}

confirm_traecode_update() {
  local answer tty_path
  tty_path="${AAMP_TRAECODE_UPDATE_TTY:-/dev/tty}"
  if ! exec 6<>"$tty_path"; then return 2; fi
  printf '%s' '当前 TraeCode CLI 版本较旧，不支持 ACP。是否执行 `traecli update` 升级？[y/N] ' >&6
  if ! IFS= read -r answer <&6; then exec 6>&-; return 2; fi
  exec 6>&-
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

run_traecode_update() {
  local traecode_bin="$1"
  [ -n "$traecode_bin" ] || return 127
  "$traecode_bin" update
}

ensure_traecode_acp() {
  local probe_status confirm_status update_bin
  set +e; run_traecode_check probe-acp >/dev/null; probe_status=$?; set -e
  [ "$probe_status" -eq 0 ] && return 0
  [ "$probe_status" -ne 124 ] || agent_fail "TraeCode CLI ACP 能力检查超时，请稍后重试。"
  [ "$probe_status" -eq 3 ] || agent_fail "无法检查 TraeCode CLI 的 ACP 能力。"

  set +e; confirm_traecode_update; confirm_status=$?; set -e
  if [ "$confirm_status" -eq 2 ]; then
    agent_fail "当前 TraeCode CLI 需要升级。请在交互式终端执行 'traecli update' 后重试。"
  fi
  if [ "$confirm_status" -ne 0 ]; then
    AGENT_PREPARE_CANCELLED="true"
    AGENT_PREPARE_CANCEL_REASON="用户取消升级 TraeCode CLI，本次未启动飞书任务连接。"
    return 0
  fi

  update_bin="$(find_traecode_cli)" || agent_fail "升级前无法重新定位 TraeCode CLI，请手动执行 'traecli update' 后重试。"
  run_traecode_update "$update_bin" || agent_fail "TraeCode CLI 升级失败，请查看上方升级输出，或手动执行 'traecli update' 后重试。"
  hash -r 2>/dev/null || true
  TRAECODE_CLI_BIN=""
  find_traecode_cli >/dev/null 2>&1 || agent_fail "升级后仍未检测到 TraeCode CLI，请检查 PATH 后重试。"
  set +e; run_traecode_check probe-acp >/dev/null; probe_status=$?; set -e
  [ "$probe_status" -eq 0 ] || agent_fail "TraeCode CLI 升级后仍不支持 ACP，请确认升级结果后重试。"
}

ensure_traecode_doctor() {
  local output doctor_status
  set +e; output="$(run_traecode_check doctor 2>&1)"; doctor_status=$?; set -e
  case "$doctor_status" in
    0) [ -z "$output" ] || agent_detail "TraeCode CLI 诊断警告：$output" ;;
    10) agent_fail "TraeCode CLI 尚未准备好。请打开 TraeCode CLI，按提示完成登录，并使用 /model 选择模型后重试。" ;;
    11) agent_fail "TraeCode CLI 诊断未通过：${output:-未知错误}" ;;
    65) agent_fail "TraeCode CLI 诊断结果无法解析，请执行 'traecli doctor --json' 检查后重试。" ;;
    124) agent_fail "TraeCode CLI 诊断超时，请稍后重试。" ;;
    *) agent_fail "TraeCode CLI 诊断执行失败：${output:-请执行 'traecli doctor --json' 检查。}" ;;
  esac
}

ensure_traecode_ready() {
  ensure_traecode_acp
  [ "$AGENT_PREPARE_CANCELLED" = "true" ] && return 0
  ensure_traecode_doctor
}
```

Add the external case to login preparation without invoking any login command:

```bash
traecli)
  ensure_traecode_ready
  ;;
```

Replace the historical compatibility branch with the exact runtime-resolution
order. This is where the actual type is assigned for the controller response:

```bash
trae)
  if find_traex_cli >/dev/null 2>&1; then
    AGENT="traex"
    ensure_traex_login
  elif find_coco_cli >/dev/null 2>&1; then
    maybe_upgrade_legacy_trae_cli
    if [ "$AGENT" = "traex" ]; then ensure_traex_login; fi
  elif find_traecode_cli >/dev/null 2>&1; then
    AGENT="traecli"
    ensure_traecode_ready
  else
    agent_fail "未检测到 Trae CLI（内部版）、Trae CLI Next（内部版）或 TraeCode CLI。"
  fi
  ;;
```

Build its ACP command exactly and shell-safely. `acpx` 0.11.x parses the raw
command with quote awareness, so quote the resolved executable as one command
word rather than trusting whitespace in a user path:

```bash
acp_command_word() {
  local value="$1"
  case "$value" in *$'\n'*|*$'\r'*) return 1 ;; esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

if [ "$AGENT" = "traecli" ]; then
  local traecode_bin traecode_word
  traecode_bin="$(find_traecode_cli)" || agent_fail "TraeCode CLI 不可用，无法启动 ACP 服务。"
  traecode_word="$(acp_command_word "$traecode_bin")" \
    || agent_fail "TraeCode CLI 路径包含不受支持的换行符。"
  ACP_AGENT_COMMAND="$traecode_word acp serve"
  agent_detail "using native TraeCode ACP command: $ACP_AGENT_COMMAND"
  return 0
fi
```

- [ ] **Step 7: Update old Trae tests**

Change old fixtures that treated `traecli` alone as `trae` to use `coco`; keep the existing `traex` login tests unchanged. Replace obsolete wording assertions with the approved labels and assert that the source contains no user-facing `旧版 Coco`.

- [ ] **Step 8: Verify distribution-aware preparation is GREEN**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test \
  test/traecode-readiness.test.mjs \
  test/traecode-one-click.test.mjs \
  test/trae-one-click.test.mjs \
  test/bootstrap.test.mjs
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
npm test
cd ../..
git diff --check
```

Expected: all Task Agent tests pass; fake call logs contain only
`acp serve --help`, optional `update`, and `doctor --json` for TraeCode CLI.

- [ ] **Step 9: Commit distribution-aware preparation**

```bash
git add packages/aamp-feishu-task-agent
git commit -m "feat(task-agent): detect and prepare TraeCode CLI"
```

---

### Task 4: Persist, Normalize, and Display TraeCode Bindings

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs`

**Interfaces:**
- Consumes: bootstrap preparation may return `prepared.agent_type === 'traecli'` for explicit TraeCode or a resolved historical `trae` binding.
- Produces: canonical allowlist entry, stable saved identity, pending-only `trae -> traecli` normalization, runtime-name display, and exact subsequent restart behavior.

- [ ] **Step 1: Write failing controller contract tests**

Add to `test/traecode-one-click.test.mjs`:

```js
test('controller has approved Trae product labels', () => {
  const source = readFileSync(controller, 'utf8')
  const helpers = functionRange(source, 'function agentSelectionDisplayName(', 'function bindingCancellationReason(')
  const values = new Function(`${helpers}\nreturn { agentSelectionDisplayName, agentBindingDisplayName };`)()
  assert.equal(values.agentSelectionDisplayName('trae'), 'Trae CLI（内部版）')
  assert.equal(values.agentSelectionDisplayName('traex'), 'Trae CLI Next（内部版）')
  assert.equal(values.agentSelectionDisplayName('traecli'), 'TraeCode CLI')
  assert.equal(values.agentBindingDisplayName('trae'), 'Trae CLI（兼容配置）')
  assert.equal(values.agentBindingDisplayName('traecli'), 'TraeCode CLI')
})

test('pending legacy bindings normalize to Traex or TraeCode, ready bindings do not rewrite', () => {
  const source = readFileSync(controller, 'utf8')
  const helper = functionRange(source, 'function normalizePendingAgentBindings(', 'function bindingCancellationReason(')
  const normalize = new Function('AGENT_TYPES', `${helper}\nreturn normalizePendingAgentBindings;`)(
    ['codex', 'cursor', 'trae', 'traex', 'traecli', 'workbuddy'],
  )
  const host = 'https://meshmail.ai'
  for (const resolved of ['traex', 'traecli']) {
    const pending = [{ agent_type: 'trae', aamp_host: host, state: 'pending' }]
    assert.equal(normalize(pending, host, 'trae', resolved), resolved)
    assert.equal(pending[0].agent_type, resolved)
    const ready = [{ agent_type: 'trae', aamp_host: host, state: 'ready', agent_target_email: 'saved@example.com' }]
    assert.equal(normalize(ready, host, 'trae', resolved), 'trae')
    assert.equal(ready[0].agent_type, 'trae')
  }
})

test('resolved runtime labels are used for ready historical compatibility bindings', () => {
  const source = readFileSync(controller, 'utf8')
  const helpers = functionRange(source, 'function agentSelectionDisplayName(', 'function bindingCancellationReason(')
  const values = new Function('AGENT_TYPES', `${helpers}\nreturn { bindingLabel, normalizePendingAgentBindings };`)(
    ['codex', 'cursor', 'trae', 'traex', 'traecli', 'workbuddy'],
  )
  const binding = {
    agent_type: 'trae',
    bot: { app_id: 'cli_test', display_name: 'Trae test Bot' },
  }
  assert.match(values.bindingLabel(binding), /^Trae CLI（兼容配置）/)
  assert.match(values.bindingLabel(binding, 'traex'), /^Trae CLI Next（内部版）/)
  assert.match(values.bindingLabel(binding, 'traecli'), /^TraeCode CLI/)
})

test('saved TraeCode binding is accepted and listed without secrets', () => {
  const result = runControllerListFixture({ agent_type: 'traecli' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /TraeCode CLI/)
  assert.doesNotMatch(result.stdout, /test-only-secret/)
})

test('runtime startup renders resolved product labels instead of raw agent keys', () => {
  const source = readFileSync(controller, 'utf8')
  assert.match(source, /runtimeAgentNames[^;]+\.map\(agentSelectionDisplayName\)/s)
  assert.match(source, /bindingLabel\(binding, runtimeAgentType\)/)
})
```

- [ ] **Step 2: Run controller-focused tests and confirm RED**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/traecode-one-click.test.mjs test/trae-one-click.test.mjs test/workbuddy-one-click.test.mjs
```

Expected: FAIL because `traecli` is absent from `AGENT_TYPES`, normalization only accepts `traex`, and labels are raw/stale.

- [ ] **Step 3: Implement allowlist, normalization, and labels**

Use this allowlist:

```js
const AGENT_TYPES = ['codex', 'cursor', 'trae', 'traex', 'traecli', 'workbuddy'];
```

Update the validation error to list `codex/cursor/trae/traex/traecli/workbuddy`.

Replace the label helpers with:

```js
function agentSelectionDisplayName(agent) {
  if (agent === 'trae') return 'Trae CLI（内部版）';
  if (agent === 'traex') return 'Trae CLI Next（内部版）';
  if (agent === 'traecli') return 'TraeCode CLI';
  return agent;
}

function agentBindingDisplayName(agent) {
  if (agent === 'trae') return 'Trae CLI（兼容配置）';
  if (agent === 'traex') return 'Trae CLI Next（内部版）';
  if (agent === 'traecli') return 'TraeCode CLI';
  return agent;
}
```

Permit only historical `trae` normalization to the two real runtime identities:

```js
if (requestedAgentType !== 'trae' || !['traex', 'traecli'].includes(resolvedAgentType)) {
  throw new Error(`unexpected prepared Agent type: ${requestedAgentType} -> ${resolvedAgentType}`);
}
```

Render the bridge startup line with approved labels:

```js
const runtimeAgentNames = agents
  .map((agent) => group.runtimeAgentTypes.get(agent.name) || agent.name)
  .map(agentSelectionDisplayName);
console.log(`[aamp-one-click] 正在启动本地 Agent Bridge (${runtimeAgentNames.join(', ')})...`);
```

Add TraeCode-specific failure guidance while retaining the complete WorkBuddy
branch:

```js
function agentFailureMessage(agentType, message) {
  const text = String(message || 'Agent Bridge 启动失败');
  if (agentType === 'traecli') {
    return `${text}\n请执行 'traecli doctor --json' 检查 TraeCode CLI，修复后重试。`;
  }
  if (agentType !== 'workbuddy') return text;
  if (/^WorkBuddy (?:is not logged in|login expired)\./i.test(text)) return text;
  return `${text}\n如果尚未登录，请打开 WorkBuddy 完成登录后重试。`;
}
```

Change the no-agent guidance to mention TraeCode CLI. On preparation failure,
continue to key `group.failures` by the requested binding identity; only a
successful preparation may add the resolved runtime type.

- [ ] **Step 4: Update shared assertions**

Update all shared help/allowlist regexes to include `traecli`. Replace historical saved-binding expected label `Trae CLI` with `Trae CLI（兼容配置）`; keep WorkBuddy's standard-path and authentication assertions unchanged.

- [ ] **Step 5: Verify controller behavior is GREEN**

Run:

```bash
cd packages/aamp-feishu-task-agent
npm test
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
cd ../..
git diff --check
```

Expected: full Task Agent tests pass. `feishu-task-agent list/start` labels
saved `traecli` as TraeCode CLI and never switches it to Traex.

- [ ] **Step 6: Commit persistence and labels**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs \
  packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs \
  packages/aamp-feishu-task-agent/test/workbuddy-one-click.test.mjs
git commit -m "feat(task-agent): persist TraeCode CLI bindings"
```

---

### Task 5: Documentation, Regression, Package, and Native Verification

**Files:**
- Modify: `packages/aamp-feishu-task-agent/README.md`
- Modify: `docs/AGENT_SETUP.md`
- Verify: `packages/aamp-acp-bridge/**`
- Verify: `packages/aamp-feishu-task-agent/**`
- Verify: `packages/aamp-feishu-bridge/src/task/runtime.test.ts` (unchanged stream-to-human-readable-step consumer regression)

**Interfaces:**
- Consumes: canonical identities and commands delivered by Tasks 1–4.
- Produces: user-facing setup/remediation documentation and an evidence record separating deterministic tests, native ACP smoke, and Feishu Task end-to-end acceptance. No `packages/aamp-feishu-bridge/**` source change is required; controlled E2E covers its unchanged consumer path.

- [ ] **Step 1: Add documentation assertions before editing docs**

Extend the existing Task Agent documentation test with exact assertions:

```js
assert.match(readmeSource, /--agent codex\|cursor\|trae\|traex\|traecli\|workbuddy/)
assert.match(readmeSource, /Trae CLI（内部版）/)
assert.match(readmeSource, /Trae CLI Next（内部版）/)
assert.match(readmeSource, /TraeCode CLI/)
assert.match(readmeSource, /traex.*coco.*traecli/is)
assert.match(readmeSource, /traecli update/)
assert.match(readmeSource, /traecli doctor --json/)
assert.match(readmeSource, /\/model/)
assert.match(readmeSource, /saved.*traecli.*TraeCode CLI/is)
assert.doesNotMatch(readmeSource, /TraeCode CLI.*aamp-cli-bridge/is)
```

Add equivalent `docs/AGENT_SETUP.md` assertions to
`test/traecode-one-click.test.mjs`: the connector table and known-agent table
must each contain canonical `traecli`/`traecli acp serve`, and the document must
not call `traecli` legacy. Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/trae-one-click.test.mjs test/traecode-one-click.test.mjs
```

Expected: FAIL because the README still describes `traecli` as legacy Coco
and the setup guide has no canonical TraeCode row.

- [ ] **Step 2: Rewrite the user-facing Trae section**

In `packages/aamp-feishu-task-agent/README.md`, document:

```markdown
The Trae-family choice uses this order:

1. `traex` → Trae CLI Next（内部版）
2. `coco` → Trae CLI（内部版） and the existing Next upgrade prompt
3. only when `coco` is absent, `traecli` → TraeCode CLI

TraeCode CLI is stored as `agent_type: traecli` and starts native ACP with
`traecli acp serve`. If that command is unavailable, the launcher asks before
running `traecli update`, then checks ACP again. It runs `traecli doctor --json`
without entering the TUI; model errors ask you to open TraeCode CLI and use
`/model`. The launcher never runs a TraeCode login/status command and never
falls back to CLI Bridge.
```

Document that saved `traecli` bindings remain TraeCode CLI even after Traex is installed, while ready historical `trae` bindings keep their stored identity and show their resolved runtime when started.

In `docs/AGENT_SETUP.md`, add this ACP-first row and note:

```markdown
| `traecli` (TraeCode CLI) | `aamp-acp-bridge` with native `traecli acp serve` | no CLI Bridge fallback |

`traecli` is the external TraeCode CLI identity. `coco` is the internal Trae
CLI executable and remains a separate legacy profile; ACP Bridge does not
infer product distribution when a direct caller explicitly requests
`--agent traecli`.
```

- [ ] **Step 3: Run every deterministic regression suite and package check**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build
npm pack --dry-run

cd ../aamp-feishu-task-agent
npm test
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
npm pack --dry-run

cd ../aamp-feishu-bridge
npx tsx --test src/task/runtime.test.ts
npm run build

cd ../..
git diff --check
git status --short
```

Expected: all tests/builds pass; ACP/Task Agent dry-run package manifests
include their required runtime files, including `bin/traecode-readiness.mjs`;
the unchanged Feishu runtime stream/step regression passes; no `.tgz`,
generated `dist`, or unrelated file is staged.

- [ ] **Step 4: Verify the real installed TraeCode capability and doctor contract read-only**

Run with the repository helper so both commands are bounded and no login/TUI
path is invoked:

```bash
TRAECODE_BIN="$(command -v traecli)"
TRAE_HELPER="$PWD/packages/aamp-feishu-task-agent/bin/traecode-readiness.mjs"
"$TRAECODE_BIN" --version
if command -v timeout >/dev/null 2>&1; then
  timeout 12 node "$TRAE_HELPER" probe-acp "$TRAECODE_BIN" 10
else
  node "$TRAE_HELPER" probe-acp "$TRAECODE_BIN" 10
fi
set +e
if command -v timeout >/dev/null 2>&1; then
  timeout 12 "$TRAECODE_BIN" doctor --json </dev/null >"${TMPDIR:-/tmp}/aamp-traecode-doctor.json"
else
  node - "$TRAECODE_BIN" "${TMPDIR:-/tmp}/aamp-traecode-doctor.json" <<'NODE'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const [command, output] = process.argv.slice(2)
const file = fs.openSync(output, 'w')
const child = spawn(command, ['doctor', '--json'], { stdio: ['ignore', file, 'inherit'] })
const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 500).unref() }, 10_000)
child.once('close', (code) => { clearTimeout(timer); fs.closeSync(file); process.exit(typeof code === 'number' ? code : 124) })
child.once('error', () => { clearTimeout(timer); fs.closeSync(file); process.exit(127) })
NODE
fi
traecode_doctor_exit=$?
set -e
node - "${TMPDIR:-/tmp}/aamp-traecode-doctor.json" "$traecode_doctor_exit" <<'NODE'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const [file, exit] = process.argv.slice(2)
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.ok([0, 1, 2].includes(Number(exit)))
assert.ok(Array.isArray(data.checks))
for (const check of data.checks) {
  assert.equal(typeof check.name, 'string')
  assert.equal(typeof check.severity, 'string')
  assert.equal(typeof check.message, 'string')
}
console.log(`doctor_exit=${exit} checks=${data.checks.length} errors=${data.checks.filter((c) => c.severity === 'error').length}`)
NODE
rm -f -- "${TMPDIR:-/tmp}/aamp-traecode-doctor.json"
```

Expected on the verified local `0.120.52`: the bounded ACP probe succeeds;
doctor returns structured checks. Exit `2` with a `model` error is a valid
blocked-readiness result, not command failure. The command deletes only the
explicit doctor JSON temp file after recording the count; it contains local
diagnostic paths.

- [ ] **Step 5: Run a native ACP stream smoke only when doctor is ready**

First call the helper's `doctor` action. Exit `10`/`11` means not ready: print
its already-sanitized diagnostics and record `Native ACP smoke skipped:
TraeCode doctor not ready`; exit `65`/`70`/`124`/`127` is a smoke preflight
failure. When the helper returns `0`, run this exact smoke with cleanup
guaranteed by a trap:

```bash
TRAECODE_SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aamp-traecode-smoke.XXXXXX")"
TRAECODE_SMOKE_LOG="$(mktemp "${TMPDIR:-/tmp}/aamp-traecode-stream.XXXXXX")"
TRAECODE_SMOKE_SESSION="aamp-traecode-smoke-$$"
traecode_smoke_cleanup() {
  acpx --agent "traecli acp serve" --cwd "$TRAECODE_SMOKE_DIR" \
    sessions close "$TRAECODE_SMOKE_SESSION" >/dev/null 2>&1 || true
  case "$TRAECODE_SMOKE_DIR" in "${TMPDIR:-/tmp}"/aamp-traecode-smoke.*) rm -rf -- "$TRAECODE_SMOKE_DIR" ;; esac
  case "$TRAECODE_SMOKE_LOG" in "${TMPDIR:-/tmp}"/aamp-traecode-stream.*) rm -f -- "$TRAECODE_SMOKE_LOG" ;; esac
}
trap traecode_smoke_cleanup EXIT INT TERM

acpx --approve-all --cwd "$TRAECODE_SMOKE_DIR" \
  --agent "traecli acp serve" \
  sessions ensure --name "$TRAECODE_SMOKE_SESSION"

acpx --approve-all --cwd "$TRAECODE_SMOKE_DIR" \
  --format json --json-strict --timeout 60 --max-turns 1 \
  --agent "traecli acp serve" \
  prompt --session "$TRAECODE_SMOKE_SESSION" \
  "Do not call tools or modify files. Reply exactly: ACP_TRAECODE_OK" \
  >"$TRAECODE_SMOKE_LOG"

acpx --agent "traecli acp serve" --cwd "$TRAECODE_SMOKE_DIR" \
  sessions close "$TRAECODE_SMOKE_SESSION"

node - "$TRAECODE_SMOKE_LOG" <<'NODE'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const records = fs.readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse)
const chunks = records.flatMap((record) => {
  const update = record?.params?.update
  if (record?.method !== 'session/update' || update?.sessionUpdate !== 'agent_message_chunk') return []
  return typeof update?.content?.text === 'string' ? [update.content.text] : []
})
const stopReason = records.map((record) => record?.result?.stopReason).find(Boolean)
assert.equal(chunks.join(''), 'ACP_TRAECODE_OK')
assert.equal(stopReason, 'end_turn')
console.log(`chunks=${chunks.length} stopReason=${stopReason}`)
NODE

trap - EXIT INT TERM
traecode_smoke_cleanup
```

The parser intentionally reads JSON-RPC envelopes instead of assuming a
flattened event schema. It concatenates `session/update`
`agent_message_chunk` text, requires `ACP_TRAECODE_OK`, requires final
`stopReason === 'end_turn'`, and records the chunk count. Cleanup touches only
the two prefix-validated `mktemp` paths after closing the session.

- [ ] **Step 6: Perform controlled Feishu Task acceptance or record the exact skip boundary**

When a test Bot and isolated Task Agent state directory are authorized:

1. Run `feishu-task-agent install --agent traecli` against the isolated state.
2. Confirm selection/start output says TraeCode CLI.
3. Dispatch one real Feishu Task that requests a fixed sentinel reply without file changes.
4. Verify at least one human-readable Task execution step, the final comment/result, and terminal task status.
5. Stop, install/retain `traex`, restart the saved binding, and verify it still resolves `agent_type: traecli` and `traecli acp serve`.

If controlled Bot credentials or sender authorization are unavailable, report: `Feishu Task E2E skipped: controlled Bot/sender authorization unavailable`. Do not treat ACP smoke or a `bridge.running` event as E2E success.

- [ ] **Step 7: Commit documentation and final verification evidence**

Run:

```bash
git add packages/aamp-feishu-task-agent/README.md docs/AGENT_SETUP.md \
  packages/aamp-feishu-task-agent/test/trae-one-click.test.mjs \
  packages/aamp-feishu-task-agent/test/traecode-one-click.test.mjs
git commit -m "docs: document TraeCode CLI one-click support"
git log -6 --oneline
git status --short --branch
```

Expected commit sequence begins with the standalone ACP Bridge identity commit followed by Task Agent readiness/detection/persistence commits. The worktree is clean. Do not push or publish until explicitly requested.

---

## Completion Evidence Checklist

- [ ] Standalone ACP commit contains only `packages/aamp-acp-bridge/**`.
- [ ] `KNOWN_AGENTS` exposes `traex`, `traecli`, and `workbuddy` once each, but not `trae` or `coco`.
- [ ] Automatic one-click discovery is `traex -> coco -> traecli`.
- [ ] Explicit/saved `traecli` remains exact and rejects a known Coco alias conflict.
- [ ] ACP root-help false positives are covered even with exit zero.
- [ ] Update is opt-in, foreground, single-attempt, followed by rediscovery and reprobe.
- [ ] Doctor exit `2` is parsed structurally; warnings continue; every error blocks; model errors mention `/model`.
- [ ] No TraeCode path executes login/status or CLI Bridge.
- [ ] Controller labels and persisted identities match the approved product names.
- [ ] ACP Bridge tests/build and Task Agent tests/syntax/package dry runs pass.
- [ ] Native ACP smoke and Feishu Task E2E are reported separately with explicit pass/skip evidence.
