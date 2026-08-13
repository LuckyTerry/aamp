# Task Agent Idempotent Binding Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated `install` and `add` selections silently reuse an existing identical Agent-to-Bot relationship while retaining confirmation for real relationship changes.

**Architecture:** Add one pure relationship comparator beside the binding persistence helpers, then classify duplicate `app_id` selections inside `runBindingSession`. Keep new/replacement drafts in the existing atomic upsert path, while passing reused stored records directly to the shared launcher in original selection order.

**Tech Stack:** Node.js ESM, built-in `node:test`, source-level controller wiring assertions, atomic JSON persistence.

## Global Constraints

- Relationship equality compares exactly `agent_type`, `aamp_host`, `environment.name`, and `bot.app_id`.
- `bot.app_secret`, `bot.lark_cli_profile`, `bot.display_name`, persistence identity, timestamps, state, and runtime fields do not participate in equality.
- Reuse preserves the entire stored record; it does not refresh credentials, allocate a new `binding_id`, or write `bindings-v1.json`.
- `install` launches reused ready and pending records through the existing shared launcher.
- `add` treats reused records as accepted without launching a Bridge.
- Same `app_id` with a different relationship retains the existing explicit confirmation and atomic replacement flow.
- Selection order, planned counts, cancellation semantics, secret redaction, and the configuration schema remain unchanged.

---

### Task 1: Define the binding relationship comparator

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs:96-155`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:555-562`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:2607-2628`

**Interfaces:**
- Consumes: validated binding-like objects containing `agent_type`, `aamp_host`, `environment.name`, and `bot.app_id`.
- Produces: `sameBindingRelationship(existing, candidate): boolean`, exported for direct unit tests and used by Task 2.

- [ ] **Step 1: Write failing equality tests**

Add these tests before the existing `upsertBindings` tests:

```js
test('sameBindingRelationship ignores credentials labels and runtime metadata', () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  const candidate = pendingBinding('22222222-2222-4222-8222-222222222222', 'cli_same')
  candidate.bot.app_secret = 'rotated-secret'
  candidate.bot.lark_cli_profile = 'new-local-profile'
  candidate.bot.display_name = 'Renamed Bot'
  candidate.created_at = '2026-08-13T01:00:00.000Z'
  candidate.updated_at = '2026-08-13T01:00:00.000Z'

  assert.equal(controller.sameBindingRelationship(existing, candidate), true)
})

test('sameBindingRelationship rejects every routing-field difference', () => {
  const existing = readyBinding('11111111-1111-4111-8111-111111111111', 'cli_same')
  const candidate = pendingBinding('22222222-2222-4222-8222-222222222222', 'cli_same')
  const changed = [
    ['agent_type', { ...candidate, agent_type: 'cursor' }],
    ['aamp_host', { ...candidate, aamp_host: 'https://other.meshmail.ai' }],
    ['environment.name', { ...candidate, environment: { name: 'boe' } }],
    ['bot.app_id', { ...candidate, bot: { ...candidate.bot, app_id: 'cli_other' } }],
  ]

  for (const [field, value] of changed) {
    assert.equal(controller.sameBindingRelationship(existing, value), false, field)
  }
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: both new tests fail with `TypeError: controller.sameBindingRelationship is not a function`.

- [ ] **Step 3: Implement the minimal pure comparator**

Add this function immediately after `bindingExpectation`:

```js
function sameBindingRelationship(existing, candidate) {
  return Boolean(existing && candidate
    && existing.agent_type === candidate.agent_type
    && existing.aamp_host === candidate.aamp_host
    && existing.environment?.name === candidate.environment?.name
    && existing.bot?.app_id === candidate.bot?.app_id);
}
```

Add `sameBindingRelationship` to the controller export list. Do not compare or copy any other field.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: all tests in `binding-persistence.test.mjs` pass with zero failures.

- [ ] **Step 5: Commit the comparator unit**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
git commit -m "test(task-agent): define reusable binding relationships"
```

---

### Task 2: Reuse identical relationships in install and add

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs:190-223`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:2310-2427`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:2429-2500`

**Interfaces:**
- Consumes: `sameBindingRelationship(existing, candidate): boolean` from Task 1, `upsertBindings(intents)`, and the existing `startBindingsWithGroups(bindings, groups, mode)` launcher.
- Produces: `runBindingSession(mode)` result field `acceptedBindings: Binding[]`, ordered by selection and containing stored records for reuse plus drafts for new/replaced relationships.
- Preserves: `saved` continues to mean only records written by this invocation; `selectedBindings` continues to drive planned-count reconciliation and includes cancelled selections.

- [ ] **Step 1: Write failing session-wiring tests**

Replace the persisted-duplicate source assertion with:

```js
test('install and add silently reuse identical relationships and confirm changed ones', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const reuseStart = session.indexOf('if (existing && sameBindingRelationship(existing, draft))')
  const conflictStart = session.indexOf('else if (existing)', reuseStart)
  const acceptedStart = session.indexOf('if (accepted)', conflictStart)

  assert.notEqual(reuseStart, -1)
  assert.notEqual(conflictStart, -1)
  assert.notEqual(acceptedStart, -1)
  const reuseBranch = session.slice(reuseStart, conflictStart)
  assert.match(reuseBranch, /acceptedBinding = existing/)
  assert.doesNotMatch(reuseBranch, /confirm|bindingIntents\.push|已存在绑定|拟替换为/)

  const conflictBranch = session.slice(conflictStart, acceptedStart)
  assert.match(conflictBranch, /Bot .* 已存在绑定/)
  assert.match(conflictBranch, /拟替换为/)
  assert.match(conflictBranch, /await confirm\('是否替换绑定？', false\)/)
})
```

Replace the current install/add wiring assertions with these tests:

```js
test('install saves draft intents then launches all accepted bindings in selection order', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const persisted = session.indexOf('await upsertBindings(bindingIntents)')
  const setup = session.indexOf('await setupAgentGroups(acceptedBindings)')

  assert.match(session, /const acceptedBindings = \[\]/)
  assert.match(session, /acceptedBindings\.push\(acceptedBinding\)/)
  assert.match(session, /selectedBindings\.push\(accepted \? acceptedBinding : draft\)/)
  assert.match(session, /if \(bindingIntents\.length\)/)
  assert.notEqual(persisted, -1)
  assert.notEqual(setup, -1)
  assert.ok(persisted < setup)
  assert.match(session, /startBindingsWithGroups\(acceptedBindings, groups, mode\)/)
  assert.doesNotMatch(session, /setupAgentGroups\(saved\)|startBindingsWithGroups\(saved/)
})

test('add accepts reused bindings without persisting or starting them', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const addBranch = session.slice(
    session.indexOf("if (mode === 'add')"),
    session.indexOf("console.log('\\n=== 建立绑定并启动 ===')"),
  )
  const runAdd = functionRange(source, 'async function runAdd()', 'async function runList()')

  assert.match(addBranch, /succeeded\.push\(\.\.\.acceptedBindings\)/)
  assert.doesNotMatch(addBranch, /setupAgentGroups|startBindingsWithGroups/)
  assert.match(runAdd, /if \(!result\.acceptedBindings\.length\)/)
})

test('install completion distinguishes accepted bindings from newly saved bindings', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const runInstall = functionRange(source, 'async function runInstall()', 'async function runAdd()')

  assert.match(runInstall, /if \(!result\.acceptedBindings\.length\)/)
  assert.match(runInstall, /\$\{result\.acceptedBindings\.length\} 个绑定配置已保存/)
})
```

Update the existing decline test to find `else if (existing)` instead of `if (existing)`. Update the failed-install preservation test to locate
`await startBindingsWithGroups(acceptedBindings, groups, mode)`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: the new source-wiring tests fail because `acceptedBindings`, the equality branch, and accepted-count checks are not wired yet.

- [ ] **Step 3: Classify and retain accepted bindings in selection order**

In `runBindingSession`, add `acceptedBindings` next to `bindingIntents`, then replace the current duplicate branch with:

```js
const bindingIntents = [];
const acceptedBindings = [];
const selectedBindings = [];
```

```js
const existing = existingByAppId.get(draft.bot.app_id);
let accepted = true;
let acceptedBinding = draft;
if (existing && sameBindingRelationship(existing, draft)) {
  acceptedBinding = existing;
} else if (existing) {
  console.log(`Bot ${draft.bot.app_id} 已存在绑定：${bindingLabel(existing)}`);
  console.log(`拟替换为：${bindingLabel(draft)}`);
  if (!await confirm('是否替换绑定？', false)) {
    accepted = false;
    const reason = '用户取消替换已有绑定';
    cancelled.push({ binding: draft, reason });
    await setBindingStatus(draft, 'bind', 'cancelled', reason);
    printBindingCancelled(draft, reason);
  }
}
selectedBindings.push(accepted ? acceptedBinding : draft);
if (accepted) {
  acceptedBindings.push(acceptedBinding);
  if (acceptedBinding === draft) {
    bindingIntents.push({
      binding: draft,
      expected: existing ? bindingExpectation(existing) : undefined,
    });
  }
  console.log(`已选择：${bindingLabel(acceptedBinding)}`);
}
```

Remove the earlier unconditional `selectedBindings.push(draft)`. This makes launcher results and summary reconciliation share the stored `binding_id` for reused records.

- [ ] **Step 4: Persist only intents and launch all accepted bindings**

Change the empty-selection return condition to `if (!acceptedBindings.length)` and include `acceptedBindings` in every return object.

Replace unconditional persistence with:

```js
let persisted = { bindings: [], replacedCount: 0 };
if (bindingIntents.length) {
  console.log('\n=== 保存绑定配置 ===');
  persisted = await upsertBindings(bindingIntents);
  for (const binding of persisted.bindings) {
    await setBindingStatus(binding, 'bind', 'saved');
    console.log(`🟢 已保存：${bindingLabel(binding)}`);
  }
}
const saved = persisted.bindings;
```

Use accepted bindings in the two command branches:

```js
if (mode === 'add') {
  succeeded.push(...acceptedBindings);
  return {
    groups: new Map(),
    saved,
    acceptedBindings,
    selectedBindings,
    succeeded,
    failed,
    cancelled,
    selectionFailures,
    running,
    selectedCount,
    replacedCount: persisted.replacedCount,
  };
}

console.log('\n=== 建立绑定并启动 ===');
throwIfStopping();
const groups = await setupAgentGroups(acceptedBindings);
throwIfStopping();
const launched = await startBindingsWithGroups(acceptedBindings, groups, mode);
```

Include `acceptedBindings` in the final install return object as well.

- [ ] **Step 5: Make command completion use accepted counts**

In both `runInstall` and `runAdd`, replace `if (!result.saved.length)` with:

```js
if (!result.acceptedBindings.length) {
```

In `runInstall`'s all-failed error, count all retained configurations:

```js
throw new Error(`全部配置启动失败；${result.acceptedBindings.length} 个绑定配置已保存，可稍后运行 feishu-task-agent start 重试`);
```

Keep `replacedCount` based only on actual replacements so an `add` reuse cannot print the running-Bridge replacement warning.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: all persistence, equality, reuse, replacement, order, and command-wiring tests pass.

- [ ] **Step 7: Run full verification**

Run:

```bash
npm test --prefix packages/aamp-feishu-task-agent
node --check packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs
bash -n packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh
git diff --check
```

Expected: the Task Agent suite reports zero failures, both syntax checks exit 0 without output, and `git diff --check` exits 0.

- [ ] **Step 8: Commit the command behavior**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
git commit -m "fix(task-agent): silently reuse identical bindings"
```
