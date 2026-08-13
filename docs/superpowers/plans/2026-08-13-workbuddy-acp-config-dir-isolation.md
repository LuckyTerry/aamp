# WorkBuddy ACP Configuration Directory Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WorkBuddy and WorkBuddy AI ACP launches reuse their own desktop login state, while automatically upgrading exact legacy generated commands and preserving custom commands.

**Architecture:** Keep the existing string-based `acpCommand` interface. Generate each native WorkBuddy command with a child-local `env CODEBUDDY_CONFIG_DIR=...` prefix, and treat only the corresponding old bare command as migratable when resolving saved configuration. Discovery and JSON initialization continue to consume `defaultAcpCommand`, so the migration reaches existing bindings without a schema change.

**Tech Stack:** TypeScript, Node.js `node:test`, `tsx`, `acpx`, macOS application-bundled WorkBuddy CLIs.

## Global Constraints

- Canonical Agent names remain exactly `workbuddy` and `workbuddy_ai`.
- WorkBuddy uses `<home>/.workbuddy`; WorkBuddy AI uses `<home>/.workbuddy-ai`.
- Do not fall back to `<home>/.codebuddy`.
- Inject only `CODEBUDDY_CONFIG_DIR`; do not copy unrelated desktop-process environment variables.
- Preserve every nonblank custom `acpCommand` byte-for-byte.
- Migrate only the exact old generated command for the matching Agent type.
- Preserve the explicit `acpCommand` in the current JSON init request, even when it equals an old generated command.
- Do not stage or commit `.agents/.run_state.json`.
- Preserve the existing npm release skill worktree changes and verify their focused test.
- Final history must contain one consolidated commit after `5b2ffa1`, as requested by the user.

## File Structure

- Modify `packages/aamp-acp-bridge/src/agent-resolver.ts`: own native WorkBuddy paths, shell-safe command construction, and exact legacy-default migration.
- Modify `packages/aamp-acp-bridge/test/agent-resolver.test.ts`: prove product-specific command parsing, native detection, migration, and custom-command preservation.
- Modify `packages/aamp-acp-bridge/test/discovery.test.ts`: prove saved legacy commands are upgraded during discovery.
- Modify `packages/aamp-acp-bridge/test/json-init.test.ts`: prove saved legacy commands are upgraded when omitted from the current request and explicit commands are preserved.
- Keep `docs/superpowers/specs/2026-08-13-workbuddy-acp-config-dir-isolation-design.md` as the approved design.
- Add this plan at `docs/superpowers/plans/2026-08-13-workbuddy-acp-config-dir-isolation.md`.

---

### Task 1: Generate Product-Specific Native ACP Commands

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts:1-55`
- Test: `packages/aamp-acp-bridge/test/agent-resolver.test.ts:1-175`
- Test: `packages/aamp-acp-bridge/test/discovery.test.ts:1-95`
- Test: `packages/aamp-acp-bridge/test/json-init.test.ts:1-125`

**Interfaces:**
- Consumes: `defaultAcpCommand(name: string, previousCommand?: string): string` and `detectKnownAgent(name, options)`.
- Produces: unchanged public signatures whose returned WorkBuddy commands carry the correct child-local configuration directory.

- [x] **Step 1: Add a failing command-isolation test**

In `test/agent-resolver.test.ts`, import `homedir` and add a parser that validates shell words rather than relying on substring matching:

```ts
import { homedir } from 'node:os'

function parseAcpCommand(command: string): string[] {
  const parsed = spawnSync('bash', [
    '-c',
    'eval "set -- $1"; printf "%s\\0" "$@"',
    'bash',
    command,
  ], { encoding: 'buffer' })

  assert.equal(parsed.status, 0, parsed.stderr.toString())
  return parsed.stdout.toString().split('\0').filter(Boolean)
}

test('WorkBuddy products launch ACP with their desktop config directories', () => {
  const cases = [
    ['workbuddy', `${homedir()}/.workbuddy`, WORKBUDDY_APP_CLI],
    ['workbuddy_ai', `${homedir()}/.workbuddy-ai`, WORKBUDDY_AI_APP_CLI],
  ] as const

  for (const [name, configDir, cli] of cases) {
    assert.deepEqual(parseAcpCommand(defaultAcpCommand(name)), [
      'env',
      `CODEBUDDY_CONFIG_DIR=${configDir}`,
      cli,
      '--acp',
    ])
  }
})
```

- [x] **Step 2: Run the new test and verify RED**

Run from `packages/aamp-acp-bridge`:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='desktop config directories' test/agent-resolver.test.ts
```

Expected: FAIL because the first parsed word is currently the CLI executable rather than `env`.

- [x] **Step 3: Add shell-safe native command construction**

In `src/agent-resolver.ts`, import `homedir`, add the existing repository shell-word pattern, retain the old commands as migration constants, and construct the new defaults:

```ts
import { homedir } from 'node:os'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value)
}

const WORKBUDDY_APP_CONFIG_DIR = join(homedir(), '.workbuddy')
const WORKBUDDY_AI_APP_CONFIG_DIR = join(homedir(), '.workbuddy-ai')

export const WORKBUDDY_APP_CLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'
export const WORKBUDDY_AI_APP_CLI = '/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'

const WORKBUDDY_APP_LEGACY_ACP_COMMAND = `${WORKBUDDY_APP_CLI} --acp`
const WORKBUDDY_AI_APP_LEGACY_ACP_COMMAND = `'${WORKBUDDY_AI_APP_CLI}' --acp`

const WORKBUDDY_APP_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_APP_CONFIG_DIR)}`,
  shellWord(WORKBUDDY_APP_CLI),
  '--acp',
].join(' ')

const WORKBUDDY_AI_APP_ACP_COMMAND = [
  'env',
  `CODEBUDDY_CONFIG_DIR=${shellWord(WORKBUDDY_AI_APP_CONFIG_DIR)}`,
  shellWord(WORKBUDDY_AI_APP_CLI),
  '--acp',
].join(' ')
```

Extend `workbuddyApp` so each product also exposes its exact old default:

```ts
function workbuddyApp(name: string): {
  cli: string
  acpCommand: string
  legacyAcpCommand: string
  displayName: string
} | undefined {
  if (name === 'workbuddy') {
    return {
      cli: WORKBUDDY_APP_CLI,
      acpCommand: WORKBUDDY_APP_ACP_COMMAND,
      legacyAcpCommand: WORKBUDDY_APP_LEGACY_ACP_COMMAND,
      displayName: 'WorkBuddy',
    }
  }
  if (name === 'workbuddy_ai') {
    return {
      cli: WORKBUDDY_AI_APP_CLI,
      acpCommand: WORKBUDDY_AI_APP_ACP_COMMAND,
      legacyAcpCommand: WORKBUDDY_AI_APP_LEGACY_ACP_COMMAND,
      displayName: 'WorkBuddy AI',
    }
  }
  return undefined
}
```

- [x] **Step 4: Update existing default-command assertions and verify GREEN**

Replace direct old-command expectations in the three test files with
`defaultAcpCommand(name)` where the test is exercising another layer. Reuse
`parseAcpCommand` in the existing WorkBuddy AI shell-word test and assert:

```ts
assert.deepEqual(parseAcpCommand(resolution.acpCommand), [
  'env',
  `CODEBUDDY_CONFIG_DIR=${homedir()}/.workbuddy-ai`,
  WORKBUDDY_AI_APP_CLI,
  '--acp',
])
```

Run:

```bash
./node_modules/.bin/tsx --test test/agent-resolver.test.ts test/discovery.test.ts test/json-init.test.ts
```

Expected: PASS with zero failed tests.

---

### Task 2: Upgrade Exact Saved Legacy Defaults

**Files:**
- Modify: `packages/aamp-acp-bridge/src/agent-resolver.ts:173-185`
- Test: `packages/aamp-acp-bridge/test/agent-resolver.test.ts`
- Test: `packages/aamp-acp-bridge/test/discovery.test.ts`
- Test: `packages/aamp-acp-bridge/test/json-init.test.ts`

**Interfaces:**
- Consumes: `workbuddyApp(name)?.legacyAcpCommand` produced in Task 1.
- Produces: `defaultAcpCommand` migration semantics used unchanged by discovery and JSON initialization.

- [x] **Step 1: Add failing unit and integration migration tests**

Add this unit contract to `test/agent-resolver.test.ts`:

```ts
test('migrates exact legacy WorkBuddy defaults and preserves custom commands', () => {
  const cases = [
    ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
    ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
  ] as const

  for (const [name, legacyCommand] of cases) {
    assert.equal(defaultAcpCommand(name, legacyCommand), defaultAcpCommand(name))
    const customCommand = `${legacyCommand} --model custom`
    assert.equal(defaultAcpCommand(name, customCommand), customCommand)
  }
})
```

Add a discovery test that writes a config containing each exact legacy command
and expects the candidate to use `defaultAcpCommand(name)`:

```ts
test('discovery upgrades exact saved WorkBuddy legacy commands', () => {
  withFakePath([], (directory) => {
    const cases = [
      ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
      ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
    ] as const

    for (const [name, legacyCommand] of cases) {
      const configPath = join(directory, `${name}.json`)
      writeFileSync(configPath, JSON.stringify({
        aampHost: 'https://meshmail.ai',
        rejectUnauthorized: false,
        agents: [{
          name,
          acpCommand: legacyCommand,
          credentialsFile: join(directory, `${name}-credentials.json`),
        }],
      }))
      assert.equal(findCandidate(configPath, name).acpCommand, defaultAcpCommand(name))
    }
  })
})
```

Add a JSON-init test that prewrites the saved legacy command, omits
`acpCommand` in the current request, and asserts the new default is written.
Keep the existing explicit WorkBuddy command test and extend it to both
products so explicit current input remains unchanged.

- [x] **Step 2: Run migration tests and verify RED**

Run:

```bash
./node_modules/.bin/tsx --test --test-name-pattern='legacy|explicit WorkBuddy' test/agent-resolver.test.ts test/discovery.test.ts test/json-init.test.ts
```

Expected: the legacy migration assertions FAIL because the new resolver still
preserves the old bare command as a customization. Explicit-command assertions
remain PASS.

- [x] **Step 3: Implement exact legacy migration**

Update `defaultAcpCommand` so only the matching generated legacy command joins
the existing Codex compatibility exception:

```ts
export function defaultAcpCommand(name: string, previousCommand?: string): string {
  const baseCommand = baseAcpCommand(name)
  const nonblankPreviousCommand = typeof previousCommand === 'string'
    && previousCommand.trim().length > 0
    ? previousCommand
    : undefined
  const legacyWorkbuddyCommand = workbuddyApp(name)?.legacyAcpCommand

  if (nonblankPreviousCommand && nonblankPreviousCommand !== baseCommand) {
    const isMigratableDefault = nonblankPreviousCommand === legacyWorkbuddyCommand
      || (name === 'codex' && nonblankPreviousCommand === CODEX_APP_CLI)
    if (!isMigratableDefault) return nonblankPreviousCommand
  }

  return detectKnownAgent(name)?.acpCommand ?? baseCommand
}
```

- [x] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
./node_modules/.bin/tsx --test test/agent-resolver.test.ts test/discovery.test.ts test/json-init.test.ts
```

Expected: PASS with zero failed tests, including both product migrations and
explicit-command preservation.

---

### Task 3: Full Verification, Live Probes, and Single-Commit Delivery

**Files:**
- Verify: `packages/aamp-acp-bridge/src/agent-resolver.ts`
- Verify: `packages/aamp-acp-bridge/test/*.test.ts`
- Verify: `.agents/skills/aamp-npm-release/scripts/aamp-npm-release.test.mjs`
- Include: approved design and implementation-plan documents
- Exclude: `.agents/.run_state.json`

**Interfaces:**
- Consumes: the generated commands from Tasks 1-2.
- Produces: one verified commit on `feat/one-click-script` and an updated remote branch.

- [x] **Step 1: Run the complete ACP Bridge test suite**

Run from `packages/aamp-acp-bridge`:

```bash
npm test
```

Expected: all tests pass with zero failures.

- [x] **Step 2: Build the ACP Bridge**

Run from `packages/aamp-acp-bridge`:

```bash
npm run build
```

Expected: TypeScript exits 0 with no diagnostics.

- [x] **Step 3: Verify the existing npm release skill change**

Run from the repository worktree root:

```bash
node --test .agents/skills/aamp-npm-release/scripts/aamp-npm-release.test.mjs
```

Expected: all tests pass, including the assertion that the returned one-click
command does not append `--agent`.

- [x] **Step 4: Run a live WorkBuddy probe through the built generated command**

Read the generated command from `dist/agent-resolver.js`, create a uniquely
named temporary session, and close it immediately:

```bash
agent_command="$(node --input-type=module -e 'import("./dist/agent-resolver.js").then((m) => process.stdout.write(m.defaultAcpCommand("workbuddy")))')"
acpx --approve-all --cwd /Users/bytedance --timeout 20 --agent "$agent_command" sessions new --name aamp-workbuddy-fixed-smoke
acpx --approve-all --cwd /Users/bytedance --timeout 20 --agent "$agent_command" sessions close aamp-workbuddy-fixed-smoke
```

Expected: both commands exit 0. The generated command contains
`CODEBUDDY_CONFIG_DIR=/Users/bytedance/.workbuddy`.

- [x] **Step 5: Verify the WorkBuddy AI command targets international state**

Run:

```bash
node --input-type=module -e 'import("./dist/agent-resolver.js").then((m) => console.log(m.defaultAcpCommand("workbuddy_ai")))'
```

Expected: the output contains
`CODEBUDDY_CONFIG_DIR=/Users/bytedance/.workbuddy-ai` and the quoted
`WorkBuddy AI.app` executable. A live ACP session may return the existing
`Authentication required` response until WorkBuddy AI itself is logged in; it
must not succeed by borrowing `~/.codebuddy` state.

- [x] **Step 6: Check scoped diff and formatting**

Run from the worktree root:

```bash
git diff --check
git status --short
git diff -- packages/aamp-acp-bridge .agents/skills/aamp-npm-release docs/superpowers
```

Expected: only the requested npm release skill edits, WorkBuddy fix/tests, and
the two approved documents are deliverable changes. `.agents/.run_state.json`
remains untracked and unstaged.

- [ ] **Step 7: Consolidate the branch work into one commit**

First verify the rewrite boundary:

```bash
git log --oneline 5b2ffa1..HEAD
```

Expected before consolidation: the prior one-click hint commit and the design
commit, with implementation changes still in the worktree. Then consolidate
only the requested work:

```bash
git reset --soft 5b2ffa1
git add -- \
  .agents/skills/aamp-npm-release/SKILL.md \
  .agents/skills/aamp-npm-release/scripts/aamp-npm-release.mjs \
  .agents/skills/aamp-npm-release/scripts/aamp-npm-release.test.mjs \
  packages/aamp-acp-bridge/src/agent-resolver.ts \
  packages/aamp-acp-bridge/test/agent-resolver.test.ts \
  packages/aamp-acp-bridge/test/discovery.test.ts \
  packages/aamp-acp-bridge/test/json-init.test.ts \
  docs/superpowers/specs/2026-08-13-workbuddy-acp-config-dir-isolation-design.md \
  docs/superpowers/plans/2026-08-13-workbuddy-acp-config-dir-isolation.md
git commit -m "fix(task-agent): harden one-click startup"
```

Expected: exactly one commit exists after `5b2ffa1`; the prior hint change,
npm release skill change, WorkBuddy fix, tests, and documentation are included.

- [ ] **Step 8: Verify final history and push safely**

Run the complete tests from Steps 1-3 again after consolidation, then:

```bash
git status --short --branch
git log --oneline 5b2ffa1..HEAD
git diff --check 5b2ffa1..HEAD
git push --force-with-lease origin feat/one-click-script
```

Expected: tests still pass; one commit is listed after `5b2ffa1`; only
`.agents/.run_state.json` remains untracked; the force-with-lease push succeeds.
