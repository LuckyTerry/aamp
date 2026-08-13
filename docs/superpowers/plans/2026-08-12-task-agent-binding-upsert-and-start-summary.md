# Task Agent Binding Upsert and Startup Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve existing Task Agent bindings across `install`, explicitly and atomically replace duplicate Bot bindings after confirmation, persist install selections before startup, and print concrete success/failure/cancellation lists while retaining the existing success/planned count.

**Architecture:** Keep the existing controller and JSON schema, but replace single-record append/whole-store replacement with one config-lock-protected batch upsert keyed by `bot.app_id`. Selection produces immutable upsert intents containing the binding snapshot the user approved; `install` persists every accepted draft as `pending` before starting it and promotes only successful starts to `ready`. A pure summary formatter turns final runtime outcomes into deterministic lines used by both `install` and `start`.

**Tech Stack:** Node.js ESM, built-in `node:test`, atomic JSON rename writes, Bash bootstrap syntax validation.

## Global Constraints

- The unique Bot key remains `bot.app_id`; the store must never contain duplicate `app_id` or `binding_id` values.
- A replacement gets a new `binding_id`, new runtime path, `state: pending`, fresh timestamps, and no inherited `agent_target_email` or `runtime` fields.
- A rejected replacement is a user cancellation, not a system failure, and leaves the old record unchanged.
- `install` writes accepted bindings before Agent preparation/pairing/start; a startup failure leaves the new record pending.
- A running Bridge is never hot-switched or stopped by `add`; saved changes take effect on the next `start`.
- Startup counts remain `successful/planned`, so one success from two planned configurations is `1/2`.
- Startup output lists successful, failed, and cancelled bindings; `启动失败：` must not have a blank line immediately before it.
- At least one successful Bridge keeps the command running; all failures still produce an overall startup failure.
- Do not change the config schema, package versions, lockfiles, runtime-session lease, or npm package selection.

---

### Task 1: Atomic batch upsert and duplicate confirmation

**Files:**
- Create: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:494-524`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:1832-1921`

**Interfaces:**
- Produces: `bindingExpectation(binding) -> { binding_id, updated_at }`.
- Produces: `upsertBindings(intents) -> Promise<{ bindings, replacedCount }>` where each intent is `{ binding, expected }` and `expected` is `undefined` for an approved new Bot or the exact snapshot returned by `bindingExpectation` for an approved replacement.
- Produces: `createDraft(agents, selectedAppIds) -> Promise<Binding>`; `selectedAppIds` blocks selecting the same Bot twice in one command but does not reject a persisted duplicate before confirmation.
- Consumes: existing `withConfigLock`, `loadStore`, `validateStore`, `writeJsonAtomic`, `confirm`, and `bindingLabel`.

- [ ] **Step 1: Replace the persistence scaffold with failing atomic-upsert tests**

Write real filesystem tests in `binding-persistence.test.mjs`. Import the controller after setting isolated environment paths, build valid pending/ready fixtures, and assert all of these in separate tests:

```js
function expectedFeishuConfigDir(bindingId) {
  return path.join(runtimeHome, 'bindings', bindingId, 'feishu-bridge')
}

function expectedRuntime(bindingId) {
  const root = expectedFeishuConfigDir(bindingId)
  return {
    im_config_dir: path.join(root, 'task-runtime', 'instances', 'im'),
    task_config_dir: path.join(root, 'task-runtime', 'instances', 'task'),
    feishu_bridge_email: `${bindingId}@meshmail.ai`,
  }
}

function pendingBinding(runtimeHome, bindingId, appId) {
  return {
    binding_id: bindingId,
    agent_type: 'codex',
    aamp_host: 'https://meshmail.ai',
    environment: { name: 'online' },
    bot: {
      app_id: appId,
      app_secret: `secret-${appId}`,
      display_name: appId,
      lark_cli_profile: `profile-${appId}`,
    },
    feishu_config_dir: expectedFeishuConfigDir(bindingId),
    state: 'pending',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
  }
}

function readyBinding(runtimeHome, bindingId, appId) {
  return {
    ...pendingBinding(runtimeHome, bindingId, appId),
    state: 'ready',
    agent_target_email: `${bindingId}@meshmail.ai`,
    runtime: expectedRuntime(bindingId),
  }
}

test('upsertBindings appends new Bots without removing existing bindings', async () => {
  const existing = readyBinding(runtimeHome, '11111111-1111-4111-8111-111111111111', 'cli_old')
  writeStore([existing])

  const fresh = pendingBinding(runtimeHome, '22222222-2222-4222-8222-222222222222', 'cli_new')
  const result = await controller.upsertBindings([{ binding: fresh, expected: undefined }])

  assert.equal(result.replacedCount, 0)
  assert.deepEqual(readStore().bindings.map(({ bot }) => bot.app_id), ['cli_old', 'cli_new'])
})

test('upsertBindings atomically replaces the approved Bot in its original position', async () => {
  const old = readyBinding(runtimeHome, '11111111-1111-4111-8111-111111111111', 'cli_same')
  const untouched = readyBinding(runtimeHome, '22222222-2222-4222-8222-222222222222', 'cli_keep')
  writeStore([old, untouched])

  const replacement = pendingBinding(runtimeHome, '33333333-3333-4333-8333-333333333333', 'cli_same')
  const result = await controller.upsertBindings([{
    binding: replacement,
    expected: controller.bindingExpectation(old),
  }])

  assert.equal(result.replacedCount, 1)
  const bindings = readStore().bindings
  assert.deepEqual(bindings.map(({ binding_id }) => binding_id), [
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
  ])
  assert.equal(bindings[0].state, 'pending')
  assert.equal('runtime' in bindings[0], false)
  assert.equal('agent_target_email' in bindings[0], false)
})

test('upsertBindings rejects a stale approval without partially writing the batch', async () => {
  const approved = readyBinding(runtimeHome, '11111111-1111-4111-8111-111111111111', 'cli_same')
  writeStore([approved])
  const expectation = controller.bindingExpectation(approved)
  writeStore([{
    ...approved,
    binding_id: '22222222-2222-4222-8222-222222222222',
    feishu_config_dir: expectedFeishuConfigDir('22222222-2222-4222-8222-222222222222'),
    runtime: expectedRuntime('22222222-2222-4222-8222-222222222222'),
    updated_at: '2026-08-12T22:00:00.000Z',
  }])

  await assert.rejects(
    controller.upsertBindings([
      { binding: pendingBinding(runtimeHome, '33333333-3333-4333-8333-333333333333', 'cli_same'), expected: expectation },
      { binding: pendingBinding(runtimeHome, '44444444-4444-4444-8444-444444444444', 'cli_other'), expected: undefined },
    ]),
    /绑定已发生变化，请重新执行/,
  )
  assert.deepEqual(readStore().bindings.map(({ binding_id }) => binding_id), [
    '22222222-2222-4222-8222-222222222222',
  ])
})
```

Add source-level interaction assertions only for wiring that cannot be driven without lark-cli credentials:

```js
test('install and add explicitly confirm persisted duplicate Bots', () => {
  const source = readFileSync(controllerPath, 'utf8')
  assert.match(source, /Bot .* 已存在绑定/)
  assert.match(source, /拟替换为/)
  assert.match(source, /await confirm\('是否替换绑定？', false\)/)
  assert.doesNotMatch(source, /mode === 'add'\s*\?\s*store\.bindings/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: FAIL because `bindingExpectation` and `upsertBindings` are not exported/implemented and the controller still rejects persisted duplicates before confirmation.

- [ ] **Step 3: Implement the minimal atomic upsert**

In the controller, replace `replaceBindings` and `appendBinding` with this contract:

```js
function bindingExpectation(binding) {
  return {
    binding_id: binding.binding_id,
    updated_at: binding.updated_at,
  };
}

async function upsertBindings(intents) {
  return withConfigLock(async () => {
    const store = await loadStore();
    const intentByAppId = new Map();
    for (const intent of intents) {
      const appId = intent.binding.bot.app_id;
      if (intentByAppId.has(appId)) throw new Error(`Bot ${appId} 在本次操作中重复选择`);
      intentByAppId.set(appId, intent);
    }

    let replacedCount = 0;
    const consumed = new Set();
    const bindings = store.bindings.map((current) => {
      const appId = current.bot.app_id;
      const intent = intentByAppId.get(appId);
      if (!intent) return current;
      const expected = intent.expected;
      if (!expected
        || current.binding_id !== expected.binding_id
        || current.updated_at !== expected.updated_at) {
        throw new Error(`Bot ${appId} 的绑定已发生变化，请重新执行`);
      }
      consumed.add(appId);
      replacedCount += 1;
      return intent.binding;
    });

    for (const [appId, intent] of intentByAppId) {
      if (consumed.has(appId)) continue;
      if (intent.expected) throw new Error(`Bot ${appId} 的绑定已发生变化，请重新执行`);
      bindings.push(intent.binding);
    }

    const next = validateStore({ ...emptyStore(), bindings });
    await writeJsonAtomic(CONFIG_FILE, next);
    return { bindings: intents.map(({ binding }) => binding), replacedCount };
  });
}
```

Export both functions for direct tests. Update selection so `createDraft` only guards the per-session `selectedAppIds`. In `runBindingSession`, keep an `existingByAppId` snapshot, print old/new labels for a duplicate, ask `是否替换绑定？` with default `false`, and append `{ binding: draft, expected: bindingExpectation(existing) }` only after confirmation. A declined replacement goes into `cancelled` with reason `用户取消替换已有绑定` and remains counted in `selectedCount`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: all persistence and confirmation tests PASS; no temporary state escapes the isolated test directory.

- [ ] **Step 5: Commit the atomic upsert unit**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
git commit -m "fix(task-agent): preserve and replace saved bindings"
```

---

### Task 2: Persist install drafts before startup and retain pending failures

**Files:**
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:1863-1997`

**Interfaces:**
- Consumes: `upsertBindings(intents)` from Task 1.
- Produces: `runBindingSession('add'|'install')` result fields `{ saved, succeeded, failed, cancelled, selectionFailures, running, selectedCount, replacedCount }`.
- Preserves: `updateBinding(readyBinding)` remains the only pending-to-ready promotion path after a real Bridge startup.

- [ ] **Step 1: Add failing install-order and pending-retention tests**

Add structural assertions that encode the required order without invoking real Agent/Bot services:

```js
test('install saves accepted pending bindings before Agent setup and promotes one at a time', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  assert.ok(session.indexOf('await upsertBindings(bindingIntents)') < session.indexOf('await setupAgentGroups(saved)'))
  assert.match(session, /await updateBinding\(paired\.binding\)/)
  assert.doesNotMatch(session, /replaceBindings\(bound\.succeeded\)/)
})

test('a failed install start keeps the already-saved pending binding', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const session = functionRange(source, 'async function runBindingSession(', 'async function runInstall(')
  const failureBranch = session.slice(session.indexOf('catch (error)', session.indexOf('await bindOneDraft')))
  assert.doesNotMatch(failureBranch, /removeBinding|replaceBindings/)
  assert.match(failureBranch, /failed\.push\(\{ binding: draft, reason \}\)/)
})

test('add saves one batch and never starts Agent groups', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const addBranch = functionRange(source, "if (mode === 'add')", "console.log('\\n=== 建立绑定并启动 ===')")
  assert.match(addBranch, /await upsertBindings\(bindingIntents\)/)
  assert.doesNotMatch(addBranch, /setupAgentGroups|bindOneDraft/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
```

Expected: FAIL because `install` still pairs before persistence and `add` still saves one draft at a time.

- [ ] **Step 3: Reorder add/install around one atomic save**

Restructure `runBindingSession` so it builds `bindingIntents`, then performs one save before branching:

```js
const persisted = bindingIntents.length
  ? await upsertBindings(bindingIntents)
  : { bindings: [], replacedCount: 0 };
const saved = persisted.bindings;

if (mode === 'add') {
  for (const binding of saved) {
    succeeded.push(binding);
    await setBindingStatus(binding, 'bind', 'saved');
    console.log(`🟢 已保存：${bindingLabel(binding)}`);
  }
  return { groups: new Map(), saved, succeeded, failed, cancelled,
    selectionFailures, running, selectedCount, replacedCount: persisted.replacedCount };
}

const groups = await setupAgentGroups(saved);
for (const draft of saved) {
  try {
    const paired = await bindOneDraft(draft, groups, mode);
    if (!paired.process) throw new Error('完成绑定后未获得可监督的 Feishu Bridge 进程');
    try {
      await updateBinding(paired.binding);
    } catch (error) {
      await stopManagedProcess(paired.process);
      throw error;
    }
    succeeded.push(paired.binding);
    running.push({ binding: paired.binding, process: paired.process,
      group: paired.group, runtimeAgentType: paired.runtimeAgentType });
  } catch (error) {
    const reason = redact(error.message || error);
    failed.push({ binding: draft, reason });
    await setBindingStatus(draft, 'bind', 'failed', reason);
    await recordError('binding', reason, draft);
  }
}
```

Remove `replaceBindings(bound.succeeded)` from `runInstall`. Keep failed/cancelled pending records untouched. If no accepted draft was saved because every replacement was declined, return a cancellation result without starting groups or changing the store. In `runAdd`, treat cancellation-only results as a normal no-change result. If `replacedCount > 0 && await hasActiveAgentLease()`, print `当前已运行的 Bridge 不受影响；替换将在下一次 feishu-task-agent start 时生效。`.

- [ ] **Step 4: Run Task Agent persistence and existing runtime tests**

Run:

```bash
node --test \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
```

Expected: both files PASS. Update obsolete static assertions only when they encode the old replace-after-start behavior; retain every unrelated network assertion.

- [ ] **Step 5: Commit the install-order unit**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
git commit -m "fix(task-agent): save bindings before install startup"
```

---

### Task 3: Concrete startup outcome summaries

**Files:**
- Create: `packages/aamp-feishu-task-agent/test/startup-summary.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:1610-1705`
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:1957-1987`
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs:319-328`

**Interfaces:**
- Produces: `startupSummaryLines({ title, plannedCount, running, failed, cancelled }) -> string[]`.
- Produces: `printStartupSummary(options)` which emits a single deterministic block using the pure formatter.
- Consumes: runtime entries shaped as `{ binding, runtimeAgentType? }` and failure/cancellation entries shaped as `{ binding, reason }`.

- [ ] **Step 1: Write failing formatter tests**

Create `startup-summary.test.mjs`, import `startupSummaryLines`, and assert exact lines:

```js
test('partial success keeps the planned denominator and lists success then failure without a blank line', () => {
  const lines = startupSummaryLines({
    title: '已成功启动',
    plannedCount: 2,
    running: [{ binding: binding('codex', 'Codex Bot', 'cli_ok') }],
    failed: [{ binding: binding('traex', 'Trae Bot', 'cli_bad'), reason: 'Trae CLI Next 未登录' }],
    cancelled: [],
  })

  assert.deepEqual(lines, [
    '已成功启动 1/2 个配置。',
    '启动成功：',
    '- codex ↔ Codex Bot (cli_ok)',
    '启动失败：',
    '- traex ↔ Trae Bot (cli_bad)',
    '  原因：Trae CLI Next 未登录',
  ])
  assert.doesNotMatch(lines.join('\n'), /\n\n启动失败：/)
})

test('summary uses the resolved runtime type and omits empty sections', () => {
  const lines = startupSummaryLines({
    title: '已成功建立绑定并启动',
    plannedCount: 1,
    running: [{ binding: binding('coco', 'Trae Bot', 'cli_ok'), runtimeAgentType: 'traex' }],
    failed: [],
    cancelled: [],
  })
  assert.deepEqual(lines, [
    '已成功建立绑定并启动 1/1 个配置。',
    '启动成功：',
    '- traex ↔ Trae Bot (cli_ok)',
  ])
})

test('cancelled bindings have a separate section and are not failures', () => {
  const lines = startupSummaryLines({
    title: '已成功启动',
    plannedCount: 2,
    running: [{ binding: binding('codex', 'Codex Bot', 'cli_ok') }],
    failed: [],
    cancelled: [{ binding: binding('coco', 'Trae Bot', 'cli_cancel'), reason: '用户取消升级' }],
  })
  assert.deepEqual(lines.slice(-3), [
    '已取消：',
    '- coco ↔ Trae Bot (cli_cancel)',
    '  原因：用户取消升级',
  ])
})
```

- [ ] **Step 2: Run the formatter test and verify RED**

Run:

```bash
node --test packages/aamp-feishu-task-agent/test/startup-summary.test.mjs
```

Expected: FAIL because `startupSummaryLines` is not exported or implemented.

- [ ] **Step 3: Implement and wire the deterministic summary**

Add the pure formatter near `bindingLabel`:

```js
function startupSummaryLines({ title, plannedCount, running, failed, cancelled }) {
  const lines = [`${title} ${running.length}/${plannedCount} 个配置。`];
  if (running.length) {
    lines.push('启动成功：');
    for (const item of running) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
    }
  }
  if (failed.length) {
    lines.push('启动失败：');
    for (const item of failed) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
      lines.push(`  原因：${redact(item.reason)}`);
    }
  }
  if (cancelled.length) {
    lines.push('已取消：');
    for (const item of cancelled) {
      lines.push(`- ${bindingLabel(item.binding, item.runtimeAgentType)}`);
      lines.push(`  原因：${redact(item.reason)}`);
    }
  }
  return lines;
}

function printStartupSummary(options) {
  console.log(`\n${startupSummaryLines(options).join('\n')}`);
}
```

Export `startupSummaryLines`. Ensure every successful runtime entry retains `runtimeAgentType`: change `startOneBinding` to return `{ process, runtimeAgentType }`, and push both values from the pending and ready start branches. After reconciliation, append runtime failures to `failed` before formatting.

Call the formatter from both paths:

```js
printStartupSummary({
  title: '已成功启动',
  plannedCount: bindings.length,
  running,
  failed,
  cancelled,
});
```

and:

```js
printStartupSummary({
  title: '已成功建立绑定并启动',
  plannedCount: result.selectedCount,
  running: result.running,
  failed: [...result.failed, ...result.runtimeFailures],
  cancelled: result.cancelled,
});
```

Print the summary before the all-failed error branch so a `0/N` run still names every failed binding. Print the green keep-terminal line only when at least one Bridge is alive.

- [ ] **Step 4: Run summary and runtime tests and verify GREEN**

Run:

```bash
node --test \
  packages/aamp-feishu-task-agent/test/startup-summary.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
```

Expected: PASS. The exact output contains `1/2`, both binding labels and the failure reason, and does not contain `\n\n启动失败：`.

- [ ] **Step 5: Commit the summary unit**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/startup-summary.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
git commit -m "feat(task-agent): show startup binding outcomes"
```

---

### Task 4: User documentation and full verification

**Files:**
- Modify: `packages/aamp-feishu-task-agent/README.md:86-117`

**Interfaces:**
- Documents: `install` and `add` confirmation/upsert behavior, pending retention after startup failure, next-start activation for a running Bridge, and concrete outcome summaries.
- Verifies: all Task Agent behavior and syntax without changing package metadata.

- [ ] **Step 1: Update the README contract**

Replace the existing command bullets with explicit behavior equivalent to:

```markdown
- `install` preserves saved pairs, atomically adds each accepted pair as pending,
  and then pairs/starts it. If the Bot App ID is already bound, replacement
  requires confirmation. A startup failure leaves the pending pair available
  for a later `start` retry.
- `add` uses the same confirmed atomic add/replace behavior, but never starts a
  Bridge. When another Task Agent is already running, its Bridges are unchanged;
  the saved configuration is used by the next `start`.
- `start` and `install` retain the successful/planned count and list the concrete
  successful, failed, and cancelled pairs.
```

Keep the existing `remove`, runtime-session lease and App Secret statements intact.

- [ ] **Step 2: Run the complete Task Agent suite**

Run:

```bash
npm --prefix packages/aamp-feishu-task-agent test
```

Expected: exit 0 with every test passing and zero failures/cancellations.

- [ ] **Step 3: Run syntax and whitespace verification**

Run:

```bash
bash -n packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh
node --check packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs
node --check packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
node --check packages/aamp-feishu-task-agent/test/startup-summary.test.mjs
git diff --check
```

Expected: every command exits 0 with no output from syntax or diff checks.

- [ ] **Step 4: Audit the scoped diff**

Run:

```bash
git status --short
git diff --stat HEAD~3..HEAD
git diff HEAD~3..HEAD -- \
  packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs \
  packages/aamp-feishu-task-agent/test/startup-summary.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs \
  packages/aamp-feishu-task-agent/README.md
```

Expected: no package version, lockfile, `.tgz`, `.agents/.run_state.json`, or unrelated file appears in the implementation diff.

- [ ] **Step 5: Commit documentation**

```bash
git add packages/aamp-feishu-task-agent/README.md
git commit -m "docs(task-agent): explain incremental binding updates"
```

- [ ] **Step 6: Re-run completion verification after the final commit**

Run:

```bash
npm --prefix packages/aamp-feishu-task-agent test && \
bash -n packages/aamp-feishu-task-agent/bootstrap/aamp-feishu-task-agent-bootstrap.sh && \
node --check packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs && \
git diff --check HEAD~4..HEAD
```

Expected: exit 0, all Task Agent tests pass, and no syntax or whitespace errors are reported.
