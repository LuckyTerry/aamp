# Task Agent Layered Bridge Startup Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将多绑定启动从 ACP Agent 串行加 Feishu 绑定串行，改为交互预检串行、ACP Bridge 内 Agent 有界并发、Feishu Bridge 按绑定有界并发。

**Architecture:** 相同 `aamp_host` 继续只启动一个 ACP Bridge 进程；该进程内部最多同时启动四个 AgentBridge，全部尝试完成后再发出 `bridge.running`。Task Agent 等 ACP 阶段结束后串行完成所有可能交互的 Feishu 预检，再以稳定输入顺序收集最多四个并发启动结果；pending 绑定通过按 `aamp_host + agent_type` 分组的串行队列保护 pairing 文件。

**Tech Stack:** Node.js ESM、TypeScript、JavaScript `.mjs`、Node `node:test`、`tsx`、现有 AAMP/ACP/Feishu Bridge CLI。

## Global Constraints

- 相同 `aamp_host` 只运行一个 ACP Bridge 进程，相同稳定 `agent_type` 只加载一次。
- ACP AgentBridge 与 Feishu Bridge 的默认并发上限固定为 `4`，本次不新增 CLI 参数或环境变量。
- Agent 探测、登录、升级、Coco 归一化和 lark-cli profile/auth 预检保持串行。
- Task Agent 必须等待整个 ACP 阶段发出 `bridge.running` 后，才进入 Feishu 预检和启动阶段。
- `codex`、`cursor`、`coco`、`traex`、`traecli`、`workbuddy` 继续走 ACP Bridge；不改 CLI Bridge 路由。
- 不改变绑定 schema、Agent mailbox、runtime 路径、credentials、pairing、sender-policy 或用户展示文案。
- 并发结果和 `bridge.running.agents` 必须按输入顺序输出，不得按完成顺序漂移。
- 单项失败不得阻止无依赖关系的 Agent 或绑定；全部失败、仅取消和停止信号保持现有退出语义。
- 日志必须继续脱敏 App Secret、mailbox token、pairing code、OAuth device code 和其他凭据。
- 真实验收必须覆盖飞书任务事件、ACP 流式结果、评论、Step 和最终状态，不能只检查进程 ready。

---

## File Structure

- Modify: `packages/aamp-acp-bridge/src/bridge.ts` — ACP Bridge 内 Agent 的有界并发启动、清理、停止和耗时事件。
- Create: `packages/aamp-acp-bridge/src/bridge.test.ts` — 可控 fake AgentBridge 的并发、顺序和失败隔离测试。
- Create: `packages/aamp-feishu-task-agent/bin/runtime-concurrency.mjs` — Task Agent 专属的有界 settled map、分层调度、keyed 串行队列和串行任务 writer。
- Create: `packages/aamp-feishu-task-agent/test/runtime-concurrency.test.mjs` — 并发工具的时序、上限、稳定顺序和错误恢复测试。
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs` — 串行预检、并发 Feishu 启动、pending pairing 串行化、manifest/errors 安全写入和稳定结果汇总。
- Create: `packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs` — Controller 使用的分层启动语义和稳定结果回归。
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs` — install 并发重构后仍先保存 pending、成功后逐项原子升级 ready。
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs` — 并发 ACP 事件顺序下的整组网络重试和 writer flush 回归。
- Modify: `packages/aamp-feishu-task-agent/test/startup-summary.test.mjs` — 并发完成顺序不同于选择顺序时的摘要稳定性回归。

---

### Task 1: ACP Bridge 有界并发生命周期

**Files:**
- Modify: `packages/aamp-acp-bridge/src/bridge.ts:1-132`
- Create: `packages/aamp-acp-bridge/src/bridge.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig`、`AgentConfig`、`AgentBridgeStartOptions` 和现有 `AgentBridge`。
- Produces: `AampAcpBridgeOptions`、可注入的 `AgentBridgeHandle`、并发上限为 4 的 `AampAcpBridge.start()`/`stop()`；`agent.started`、`agent.failed`、`bridge.running` 增加 `durationMs: number`。

- [ ] **Step 1: 写出并发上限、稳定结果顺序和部分失败的 RED 测试**

在新文件 `packages/aamp-acp-bridge/src/bridge.test.ts` 中加入可控 fake：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AampAcpBridge, type AgentBridgeHandle } from './bridge.js'
import type { AgentConfig, BridgeConfig } from './config.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

function config(names: string[]): BridgeConfig {
  return {
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: names.map((name) => ({ name, acpCommand: `${name} acp` })),
  }
}

test('starts at most four agents concurrently and reports successful agents in config order', async () => {
  const gates = new Map(['a', 'b', 'c', 'd', 'e'].map((name) => [name, deferred()]))
  const entered: string[] = []
  const events: Array<Record<string, unknown>> = []
  let active = 0
  let peak = 0

  const bridge = new AampAcpBridge(config(['a', 'b', 'c', 'd', 'e']), {
    maxAgentConcurrency: 4,
    createAgentBridge(agent: AgentConfig): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          entered.push(agent.name)
          active += 1
          peak = Math.max(peak, active)
          await gates.get(agent.name)!.promise
          active -= 1
        },
        async stop() {},
      }
    },
  })

  const starting = bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['a', 'b', 'c', 'd'])
  assert.equal(peak, 4)
  gates.get('b')!.resolve()
  await until(() => entered.includes('e'))
  for (const gate of gates.values()) gate.resolve()
  await starting

  const running = events.find((event) => event.type === 'bridge.running')
  assert.ok(running)
  assert.deepEqual(running?.agents, ['a', 'b', 'c', 'd', 'e'].map((name) => ({
    name,
    email: `${name}@meshmail.ai`,
  })))
  assert.equal(Number.isFinite(Number(running.durationMs)) && Number(running.durationMs) >= 0, true)
  const runningIndex = events.indexOf(running)
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const startingIndex = events.findIndex((event) => event.type === 'agent.starting' && event.agent === name)
    const startedIndex = events.findIndex((event) => event.type === 'agent.started' && event.agent === name)
    assert.ok(startingIndex < startedIndex && startedIndex < runningIndex)
    assert.equal(Number.isFinite(Number(events[startedIndex].durationMs)), true)
  }
})

test('one failed agent is cleaned without blocking successful agents', async () => {
  const stopped: string[] = []
  const events: Array<Record<string, unknown>> = []
  const bridge = new AampAcpBridge(config(['bad', 'good']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {
          if (agent.name === 'bad') throw new Error('bad startup')
        },
        async stop() { stopped.push(agent.name) },
      }
    },
  })

  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  assert.deepEqual(stopped, ['bad'])
  assert.equal(events.some((event) => event.type === 'agent.failed' && event.agent === 'bad'), true)
  assert.equal(events.some((event) => event.type === 'agent.started' && event.agent === 'good'), true)
  assert.deepEqual(
    events.find((event) => event.type === 'bridge.running')?.agents,
    [{ name: 'good', email: 'good@meshmail.ai' }],
  )
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd packages/aamp-acp-bridge
npx tsx --test src/bridge.test.ts
```

Expected: FAIL，提示 `AgentBridgeHandle`/第二个 constructor 参数不存在，或断言显示启动顺序仍为串行。

- [ ] **Step 3: 实现最小有界 settled executor 和可注入 AgentBridge factory**

在 `bridge.ts` 增加下列接口和 executor；executor 必须保留输入索引，并将 rejection 作为结果返回：

```ts
export interface AgentBridgeHandle {
  readonly email: string
  readonly isConnected: boolean
  readonly isUsingPollingFallback: boolean
  readonly isBusy: boolean
  start(options?: AgentBridgeStartOptions): Promise<void>
  stop(): Promise<void>
}

export interface AampAcpBridgeOptions {
  maxAgentConcurrency?: number
  createAgentBridge?: (
    config: AgentConfig,
    aampHost: string,
    rejectUnauthorized: boolean,
  ) => AgentBridgeHandle
  now?: () => number
}

type Settled<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('concurrency limit must be a positive integer')
  }
  const results = new Array<Settled<R>>(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  const width = Math.min(items.length, limit)
  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}
```

imports 改为以下形态：

```ts
import { AgentBridge, type AgentBridgeStartOptions } from './agent-bridge.js'
import type { AgentConfig, BridgeConfig } from './config.js'
```

在现有 `AampAcpBridge` class 内，用下面代码替换 fields 和 constructor；其余 methods 留在
同一个 class 内：

```ts
private agents = new Map<string, AgentBridgeHandle>()
private config: BridgeConfig
private onEvent: ((event: BridgeRuntimeEvent) => void) | undefined
private maxAgentConcurrency: number
private createAgentBridge: NonNullable<AampAcpBridgeOptions['createAgentBridge']>
private now: () => number

constructor(config: BridgeConfig, options: AampAcpBridgeOptions = {}) {
  this.config = config
  this.maxAgentConcurrency = options.maxAgentConcurrency ?? 4
  this.createAgentBridge = options.createAgentBridge
    ?? ((agent, host, rejectUnauthorized) => new AgentBridge(agent, host, rejectUnauthorized))
  this.now = options.now ?? Date.now
}
```

每个 fake 也必须提供 `isBusy: false`。默认并发上限为 4。`start()` 的 worker 在
单项完成时立即发出事件。删除原串行 `for` 和旧的 map-order 输出块，以下代码同时替代二者，
并用配置顺序重建 map、控制台列表和最终 agents：

```ts
const startedAt = this.now()
await settleWithConcurrency(this.config.agents, this.maxAgentConcurrency, async (agentConfig) => {
  const agentStartedAt = this.now()
  this.emit({ type: 'agent.starting', bridge: 'acp-bridge', agent: agentConfig.name })
  const bridge = this.createAgentBridge(
    agentConfig,
    this.config.aampHost,
    this.config.rejectUnauthorized,
  )
  try {
    await bridge.start({ quiet: options.quiet, onEvent: options.onEvent, debug: options.debug })
    this.agents.set(agentConfig.name, bridge)
    this.emit({
      type: 'agent.started',
      bridge: 'acp-bridge',
      agent: agentConfig.name,
      email: bridge.email,
      connected: bridge.isConnected,
      pollingFallback: bridge.isUsingPollingFallback,
      durationMs: this.now() - agentStartedAt,
    })
  } catch (error) {
    await bridge.stop().catch((cleanupError) => {
      console.warn(`[${agentConfig.name}] Failed to clean up after startup: ${describeBridgeError(cleanupError)}`)
    })
    this.emit({
      type: 'agent.failed',
      bridge: 'acp-bridge',
      agent: agentConfig.name,
      message: describeBridgeEventError(error),
      durationMs: this.now() - agentStartedAt,
    })
    console.error(`[${agentConfig.name}] Failed to start: ${describeBridgeError(error)}`)
  }
})

if (this.agents.size === 0) {
  throw new Error('No agents started successfully')
}

const orderedEntries = this.config.agents.flatMap(({ name }) => {
  const bridge = this.agents.get(name)
  return bridge ? [[name, bridge] as const] : []
})
this.agents = new Map(orderedEntries)
const orderedAgents = orderedEntries.map(([name, bridge]) => ({ name, email: bridge.email }))
console.log(`${options.quiet ? '' : '\n'}Bridge running with ${orderedAgents.length} agent(s):`)
for (const { name, email } of orderedAgents) console.log(`   ${name}: ${email}`)
this.emit({
  type: 'bridge.running',
  bridge: 'acp-bridge',
  agentCount: orderedAgents.length,
  agents: orderedAgents,
  durationMs: this.now() - startedAt,
})
```

- [ ] **Step 4: 运行 focused 测试并确认 GREEN**

Run: `cd packages/aamp-acp-bridge && npx tsx --test src/bridge.test.ts`

Expected: 两个测试 PASS；测试进程不残留 timer 或 ACP 子进程。

- [ ] **Step 5: 增加全部失败、duration 和并发停止的 RED 测试**

继续在 `bridge.test.ts` 增加：

```ts
test('all failures reject without bridge.running and all partial bridges are stopped', async () => {
  const events: Array<Record<string, unknown>> = []
  const stopped: string[] = []
  const bridge = new AampAcpBridge(config(['one', 'two']), {
    now: (() => { let value = 100; return () => value += 5 })(),
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: false,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() { throw new Error(`${agent.name} failed`) },
        async stop() { stopped.push(agent.name) },
      }
    },
  })
  await assert.rejects(
    bridge.start({ quiet: true, onEvent: (event) => events.push(event) }),
    /No agents started successfully/,
  )
  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.equal(events.some((event) => event.type === 'bridge.running'), false)
  assert.equal(events.filter((event) => event.type === 'agent.failed').every((event) => (
    Number.isFinite(Number(event.durationMs)) && Number(event.durationMs) >= 0
  )), true)
})

test('stop attempts every running agent even when one stop fails', async () => {
  const stopped: string[] = []
  const events: Array<Record<string, unknown>> = []
  const stopGate = deferred()
  const bridge = new AampAcpBridge(config(['one', 'two']), {
    createAgentBridge(agent): AgentBridgeHandle {
      return {
        email: `${agent.name}@meshmail.ai`,
        isConnected: true,
        isUsingPollingFallback: false,
        isBusy: false,
        async start() {},
        async stop() {
          stopped.push(agent.name)
          await stopGate.promise
          if (agent.name === 'one') throw new Error('stop failed')
        },
      }
    },
  })
  await bridge.start({ quiet: true, onEvent: (event) => events.push(event) })
  const stopping = bridge.stop()
  await until(() => stopped.length === 2)
  stopGate.resolve()
  await stopping
  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.equal(events.at(-1)?.type, 'bridge.stopped')
})
```

- [ ] **Step 6: 实现并发 stop 和新增事件类型字段**

将 `BridgeRuntimeEvent` 中三个事件扩展为必填非负 `durationMs`。`stop()` 使用相同 executor，
捕获并记录每个 stop 错误，最后无条件清空 map、发出 `bridge.stopped`，不因单项失败 reject：

```ts
async stop(): Promise<void> {
  const entries = [...this.agents.entries()]
  await settleWithConcurrency(entries, this.maxAgentConcurrency, async ([name, bridge]) => {
    this.emit({ type: 'agent.stopping', bridge: 'acp-bridge', agent: name })
    console.log(`[${name}] Stopping...`)
    try {
      await bridge.stop()
    } catch (error) {
      console.warn(`[${name}] Failed to stop cleanly: ${describeBridgeError(error)}`)
    }
  })
  this.agents.clear()
  this.emit({ type: 'bridge.stopped', bridge: 'acp-bridge' })
}
```

- [ ] **Step 7: 运行 ACP Bridge 全量测试和构建**

Run:

```bash
cd packages/aamp-acp-bridge
npm test
npm run build
```

Expected: 全量测试 0 failure；`tsc` exit 0；没有未处理 rejection。

- [ ] **Step 8: 提交 ACP 并发改动**

```bash
git add packages/aamp-acp-bridge/src/bridge.ts packages/aamp-acp-bridge/src/bridge.test.ts
git commit -m "perf(acp-bridge): start agents concurrently"
```

---

### Task 2: Task Agent 并发原语

**Files:**
- Create: `packages/aamp-feishu-task-agent/bin/runtime-concurrency.mjs`
- Create: `packages/aamp-feishu-task-agent/test/runtime-concurrency.test.mjs`

**Interfaces:**
- Consumes: 无生产模块依赖，只使用 Promise。
- Produces: `settleWithConcurrency(items, limit, worker)`、`runLayeredStarts(items, options)`、`createKeyedSerialExecutor()`、`createSerializedRunner(operation)`。

- [ ] **Step 1: 写出有界并发、稳定顺序和分层调度的 RED 测试**

创建 `test/runtime-concurrency.test.mjs`：

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createKeyedSerialExecutor,
  createSerializedRunner,
  runLayeredStarts,
  settleWithConcurrency,
} from '../bin/runtime-concurrency.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('settleWithConcurrency caps active work and preserves input order', async () => {
  let active = 0
  let peak = 0
  const result = await settleWithConcurrency([30, 5, 15, 1, 10], 2, async (delay) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    if (delay === 15) throw new Error('fifteen')
    return delay
  })
  assert.equal(peak, 2)
  assert.deepEqual(result.map(({ status }) => status), [
    'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled',
  ])
  assert.deepEqual(result.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []), [30, 5, 1, 10])
})

test('runLayeredStarts finishes serial preparation before concurrent starts', async () => {
  const events = []
  let activePrepare = 0
  let activeStart = 0
  let peakStart = 0
  const outcomes = await runLayeredStarts(['a', 'bad', 'b', 'c'], {
    concurrency: 2,
    async prepare(item) {
      activePrepare += 1
      assert.equal(activePrepare, 1)
      events.push(`prepare:${item}`)
      await new Promise((resolve) => setImmediate(resolve))
      activePrepare -= 1
      if (item === 'bad') throw new Error('prepare bad')
      return item.toUpperCase()
    },
    async start(prepared) {
      assert.equal(events.filter((event) => event.startsWith('prepare:')).length, 4)
      activeStart += 1
      peakStart = Math.max(peakStart, activeStart)
      await new Promise((resolve) => setImmediate(resolve))
      activeStart -= 1
      return prepared
    },
  })
  assert.equal(peakStart, 2)
  assert.deepEqual(outcomes.map(({ status, phase }) => [status, phase]), [
    ['fulfilled', 'start'],
    ['rejected', 'prepare'],
    ['fulfilled', 'start'],
    ['fulfilled', 'start'],
  ])
})
```

- [ ] **Step 2: 运行并确认模块缺失导致 RED**

Run: `cd packages/aamp-feishu-task-agent && node --test test/runtime-concurrency.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现 settled pool 和分层调度**

创建 `bin/runtime-concurrency.mjs`，使用以下完整返回结构：

```js
export async function settleWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be a positive integer')
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => run(),
  ))
  return results
}

export async function runLayeredStarts(items, { prepare, start, concurrency }) {
  const outcomes = new Array(items.length)
  const prepared = []
  for (let index = 0; index < items.length; index += 1) {
    try {
      prepared.push({ index, value: await prepare(items[index], index) })
    } catch (reason) {
      outcomes[index] = { status: 'rejected', phase: 'prepare', reason, item: items[index], index }
    }
  }
  const started = await settleWithConcurrency(
    prepared,
    concurrency,
    ({ index, value }) => start(value, index, items[index]),
  )
  started.forEach((result, preparedIndex) => {
    const { index } = prepared[preparedIndex]
    outcomes[index] = { ...result, phase: 'start', item: items[index], index }
  })
  return outcomes
}
```

- [ ] **Step 4: 运行 focused 测试并确认 GREEN**

Run: `cd packages/aamp-feishu-task-agent && node --test test/runtime-concurrency.test.mjs`

Expected: 两个测试 PASS。

- [ ] **Step 5: 写 keyed 串行和 serialized runner 错误恢复的 RED 测试**

继续加入：

```js
test('keyed executor serializes equal keys and allows different keys to overlap', async () => {
  const execute = createKeyedSerialExecutor()
  const gate = deferred()
  const events = []
  const first = execute('codex', async () => {
    events.push('codex:1:start')
    await gate.promise
    events.push('codex:1:end')
  })
  const second = execute('codex', async () => { events.push('codex:2') })
  const other = execute('traex', async () => { events.push('traex:1') })
  await other
  assert.deepEqual(events, ['codex:1:start', 'traex:1'])
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(events, ['codex:1:start', 'traex:1', 'codex:1:end', 'codex:2'])
})

test('serialized runner executes latest state in order and recovers after a rejected caller', async () => {
  let state = 1
  let calls = 0
  const written = []
  const runner = createSerializedRunner(async () => {
    calls += 1
    if (calls === 1) throw new Error('first write failed')
    written.push(state)
  })
  await assert.rejects(runner.run(), /first write failed/)
  state = 2
  await runner.run()
  await runner.flush()
  assert.deepEqual(written, [2])
})
```

- [ ] **Step 6: 实现 keyed executor 和 serialized runner**

```js
export function createKeyedSerialExecutor() {
  const tails = new Map()
  return async (key, operation) => {
    const previous = tails.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    tails.set(key, current)
    try {
      return await current
    } finally {
      if (tails.get(key) === current) tails.delete(key)
    }
  }
}

export function createSerializedRunner(operation) {
  let tail = Promise.resolve()
  return {
    run() {
      const current = tail.catch(() => {}).then(operation)
      tail = current
      return current
    },
    flush() {
      return tail
    },
  }
}
```

- [ ] **Step 7: 运行 Task Agent focused 与全量测试**

```bash
cd packages/aamp-feishu-task-agent
node --test test/runtime-concurrency.test.mjs
npm test
```

Expected: focused 和全量测试均 0 failure。

- [ ] **Step 8: 提交并发原语**

```bash
git add packages/aamp-feishu-task-agent/bin/runtime-concurrency.mjs \
  packages/aamp-feishu-task-agent/test/runtime-concurrency.test.mjs
git commit -m "test(task-agent): add bounded startup primitives"
```

---

### Task 3: 并发安全的 manifest 和错误日志

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:10-75,690-730,1840-1870`
- Modify: `packages/aamp-feishu-task-agent/test/runtime-concurrency.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs:285-325`

**Interfaces:**
- Consumes: Task 2 的 `createSerializedRunner()` 和现有 `createSerializedLineWriter()`。
- Produces: `manifestWriter.run()/flush()`、`errorLogWriter.write()/flush()`；所有状态更新完成后 manifest 包含最新 `bindingStatuses` 快照。

- [ ] **Step 1: 写 manifest 最新快照和 errors flush 的 RED 回归**

在 `runtime-concurrency.test.mjs` 增加一个并发快照测试；在 `runtime-network.test.mjs` 增加
controller wiring 断言：

```js
test('serialized snapshot writer cannot let an old snapshot overwrite newer state', async () => {
  const firstGate = deferred()
  const writes = []
  const state = new Map([['a', 'starting']])
  let call = 0
  const runner = createSerializedRunner(async () => {
    call += 1
    const snapshot = Object.fromEntries(state)
    if (call === 1) await firstGate.promise
    writes.push(snapshot)
  })
  const first = runner.run()
  state.set('b', 'running')
  const second = runner.run()
  firstGate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(writes.at(-1), { a: 'starting', b: 'running' })
})

test('controller serializes manifest and errors and flushes them during cleanup', () => {
  assert.match(controller, /const manifestWriter = createSerializedRunner/)
  assert.match(controller, /const errorLogWriter = createSerializedLineWriter/)
  assert.match(controller, /await manifestWriter\.flush\(\)/)
  assert.match(controller, /await errorLogWriter\.flush\(\)/)
  const signalStart = controller.indexOf("for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])")
  const signalEnd = controller.indexOf('\nlet isMainModule = false', signalStart)
  const signalBlock = controller.slice(signalStart, signalEnd)
  assert.doesNotMatch(signalBlock, /process\.exit\(/)
})
```

- [ ] **Step 2: 运行 focused 测试并确认 controller wiring RED**

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/runtime-concurrency.test.mjs test/runtime-network.test.mjs
```

Expected: snapshot utility PASS；controller wiring 断言 FAIL。

- [ ] **Step 3: 将 manifest 和 errors 写入接入串行 writer**

在 controller 顶部导入，并在 `bindingStatuses` 声明之后实例化：

```js
import { createSerializedRunner } from './runtime-concurrency.mjs';

const errorLogWriter = createSerializedLineWriter((content) => appendPrivate(ERRORS_LOG, content));
const manifestWriter = createSerializedRunner(async () => {
  const statuses = [...bindingStatuses.entries()].map(([bindingId, status]) => ({
    binding_id: bindingId,
    ...status,
  }));
  await writeJsonAtomic(MANIFEST_FILE, {
    schema: 'aamp.local_logs.run.v2',
    run_id: RUN_ID,
    task_agent_version: process.env.AAMP_TASK_AGENT_VERSION || '',
    command: COMMAND,
    started_at: process.env.AAMP_TASK_RUN_STARTED_AT || RUN_STARTED_AT,
    config_file: CONFIG_FILE,
    runtime_home: RUNTIME_HOME,
    bindings: statuses,
    errors_log: ERRORS_LOG,
    log_dir: RUN_LOG_DIR,
  });
});

async function writeManifest() {
  await manifestWriter.run();
}
```

`recordError()` 保留现有字段和脱敏，只把底层 append 换为串行 writer：

```js
async function recordError(component, message, binding) {
  await errorLogWriter.write(`${JSON.stringify({
    timestamp: nowIso(),
    level: 'error',
    component,
    binding_id: binding?.binding_id,
    app_id: binding?.bot?.app_id,
    message: redact(message),
  })}\n`);
}
```

`cleanupAll()` 的 process/lease 清理仍只创建一个
共享 promise，但每次调用都要在该 promise 后再次 flush；这样 signal handler 的早期清理和
`main().finally()` 的最终清理之间即使还有状态写入，最终调用也不会漏掉：

```js
async function cleanupAll() {
  if (!cleanupPromise) {
    cleanupPromise = (async () => {
      while (managedProcesses.size || transientProcesses.size || heldLeases.size) {
        const records = [...managedProcesses].reverse();
        for (const record of records) {
          managedProcesses.delete(record);
          await stopManagedProcess(record).catch(() => {});
        }
        for (const record of [...transientProcesses].reverse()) {
          transientProcesses.delete(record);
          await stopManagedProcess(record).catch(() => {});
        }
        for (const lease of [...heldLeases]) await releaseLease(lease).catch(() => {});
      }
    })();
  }
  await cleanupPromise;
  await Promise.allSettled([
    manifestWriter.flush(),
    errorLogWriter.flush(),
  ]);
}
```

signal handler 只设置 `stopRequested`、恢复终端并触发一次 best-effort `cleanupAll()`，不得在
handler 中 `process.exit(0)`；唯一的最终 flush 机会留给现有 `main().finally()`：

```js
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopRequested) return;
    stopRequested = true;
    stopSignal = signal;
    if (terminal?.input?.isRaw) terminal.input.setRawMode(false);
    terminal?.output?.write('\x1b[?25h');
    void cleanupAll().catch(() => {});
  });
}
```

正常调用 `setBindingStatus()` 仍等待当前 manifest write；写入错误必须传播给该调用方。

- [ ] **Step 4: 运行 focused 与全量测试**

```bash
cd packages/aamp-feishu-task-agent
node --test test/runtime-concurrency.test.mjs test/runtime-network.test.mjs
npm test
```

Expected: 全部 PASS，临时 manifest 和 errors 每行均可解析。

- [ ] **Step 5: 提交状态写入改动**

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/runtime-concurrency.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
git commit -m "fix(task-agent): serialize concurrent runtime state"
```

---

### Task 4: 拆分 Feishu 串行预检与非交互启动

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:1420-1765,2000-2075`
- Create: `packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs:165-235`

**Interfaces:**
- Consumes: 现有 `resolveGroup()`、`prepareFeishuProcess()`、`startPreparedFeishuUntilReady()`、`updateBinding()`。
- Produces: `prepareBindingStart(binding, groups, mode)`、`executePreparedReadyBindingStart(prepared)`、`executePreparedPendingBindingStart(prepared)` 和 `executePreparedBindingStart(prepared)`；此任务只做等价重构，调用方仍串行执行。

- [ ] **Step 1: 写 ready/pending 描述符和“启动前已完成所有交互预检”的 RED 测试**

新建 `test/startup-concurrency.test.mjs`，首先对 controller 内的准备/执行阶段边界做回归：

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const controllerPath = path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs')
const source = readFileSync(controllerPath, 'utf8')

test('controller separates binding preparation from non-interactive execution', () => {
  assert.match(source, /async function prepareBindingStart\(binding, groups, mode\)/)
  assert.match(source, /async function executePreparedBindingStart\(prepared\)/)
  const prepareStart = source.indexOf('async function prepareBindingStart(')
  const executeStart = source.indexOf('async function executePreparedReadyBindingStart(')
  const prepareBody = source.slice(prepareStart, executeStart)
  assert.match(prepareBody, /resolveGroup\(groups, binding\)/)
  assert.match(prepareBody, /prepareFeishuProcess/)
  assert.doesNotMatch(prepareBody, /startPreparedFeishuUntilReady|aamp-acp-bridge.*pair/)
})

test('pending execution updates the persisted binding only after pairing is ready', () => {
  const executeStart = source.indexOf('async function executePreparedPendingBindingStart(')
  const executeEnd = source.indexOf('\nasync function executePreparedBindingStart(', executeStart)
  assert.notEqual(executeStart, -1)
  assert.notEqual(executeEnd, -1)
  const body = source.slice(executeStart, executeEnd)
  assert.ok(body.indexOf('startPreparedFeishuUntilReady') < body.indexOf('updateBinding'))
  assert.match(body, /await stopManagedProcess\(feishu\)/)
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `cd packages/aamp-feishu-task-agent && node --test test/startup-concurrency.test.mjs`

Expected: FAIL，因为两个新函数尚不存在。

- [ ] **Step 3: 提取准备描述符**

以现有 `bindOneDraft()` 和 `startOneBinding()` 为基础新增：

```js
async function prepareBindingStart(binding, groups, mode) {
  await setBindingStatus(binding, mode === 'install' ? 'bind' : 'start', 'starting');
  throwIfStopping();
  const { group, email, runtimeAgentType } = resolveGroup(groups, binding);
  const pending = bindingNeedsInitialStart(binding);
  const activeBinding = pending
    ? { ...binding, state: 'ready', agent_target_email: email, updated_at: nowIso() }
    : binding;
  if (!pending) {
    if (email !== binding.agent_target_email) {
      throw new Error('当前 Agent mailbox 与绑定记录不一致，请重新绑定');
    }
    await validateSavedRuntime(binding);
  }
  throwIfStopping();
  const preparedFeishu = await prepareFeishuProcess(activeBinding, mode, runtimeAgentType);
  return {
    originalBinding: binding,
    binding: activeBinding,
    group,
    mode,
    pending,
    email,
    runtimeAgentType,
    preparedFeishu,
  };
}
```

这里包含所有可能触发 lark-cli profile/auth 的步骤，但不创建 pairing、不启动 Feishu
子进程。

- [ ] **Step 4: 提取非交互执行函数并保持调用方串行**

ready 和 pending 执行拆成两个函数，dispatcher 只负责选择。pending 函数创建 pairing、等待
消费、读取 runtime、校验并更新 store：

```js
async function executePreparedReadyBindingStart(prepared) {
  const { binding, group, runtimeAgentType, preparedFeishu } = prepared;
  let feishu;
  try {
    feishu = await startPreparedFeishuUntilReady(
      preparedFeishu,
      { agentTargetEmail: binding.agent_target_email },
      { stage: 'feishu-start' },
    );
    await setBindingStatus(binding, 'start', 'running');
    return { binding, process: feishu, group, runtimeAgentType };
  } catch (error) {
    if (feishu) await stopManagedProcess(feishu);
    throw error;
  }
}

async function executePreparedPendingBindingStart(prepared) {
  const {
    originalBinding, binding, group, mode, email,
    runtimeAgentType, preparedFeishu,
  } = prepared;
  let feishu;
  try {
    const pairResult = await runCapture(
      ACP_PACKAGE,
      'aamp-acp-bridge',
      ['pair', '--agent', originalBinding.agent_type, '--config', group.configFile, '--json', '--no-start'],
      { logFile: group.logFile },
    );
    const pairing = parseJsonDocument(pairResult.stdout, 'ACP pairing');
    if (!pairing.connectUrl || !pairing.pairingFile || pairing.mailbox !== email) {
      throw new Error('ACP Bridge 返回的配对信息不完整或 mailbox 不一致');
    }
    feishu = await startPreparedFeishuUntilReady(
      preparedFeishu,
      { pairingUrl: pairing.connectUrl },
      { stage: mode === 'install' ? 'feishu-install-bind' : 'feishu-add-bind', pairingFile: pairing.pairingFile },
    );
    binding.runtime = await readInitialRuntimeMetadata(binding, feishu, email);
    await validateSavedRuntime(binding);
    await updateBinding(binding);
    await setBindingStatus(binding, 'start', 'running');
    return { binding, process: feishu, group, runtimeAgentType };
  } catch (error) {
    if (feishu) await stopManagedProcess(feishu);
    throw error;
  }
}

async function executePreparedBindingStart(prepared) {
  return prepared.pending
    ? executePreparedPendingBindingStart(prepared)
    : executePreparedReadyBindingStart(prepared);
}
```

将 `startSelectedBindings()` 和 `runBindingSession('install')` 临时改为逐项调用这两个函数，
确认此任务不改变并发行为。原来外层的 `updateBinding(paired.binding)` 必须删除，因为 pending
executor 已在 runtime 校验后完成原子更新。两个串行 loop 的成功分支分别使用：

```js
const prepared = await prepareBindingStart(binding, groups, 'start');
const started = await executePreparedBindingStart(prepared);
running.push(started);
printBindingStarted(started.binding, started.runtimeAgentType);
```

```js
const prepared = await prepareBindingStart(draft, groups, mode);
const started = await executePreparedBindingStart(prepared);
succeeded.push(started.binding);
if (mode === 'install') running.push(started);
```

删除旧 `bindOneDraft()`/`startOneBinding()`，避免两套实现漂移。

- [ ] **Step 5: 更新 install 持久化回归并运行 focused 测试**

将 `binding-persistence.test.mjs` 中对 `bindOneDraft` 的源码断言改为：

```js
assert.ok(
  session.indexOf('await upsertBindings(bindingIntents)')
    < session.indexOf('await setupAgentGroups(saved)'),
)
assert.match(session, /prepareBindingStart/)
assert.match(session, /executePreparedBindingStart/)
assert.doesNotMatch(session, /removeBinding|replaceBindings/)
```

Run:

```bash
cd packages/aamp-feishu-task-agent
node --test test/startup-concurrency.test.mjs test/binding-persistence.test.mjs
```

Expected: PASS；pending 仍先落盘，只有配对和 runtime 校验成功后才更新 ready。

- [ ] **Step 6: 运行 Task Agent 全量测试并提交等价重构**

```bash
cd packages/aamp-feishu-task-agent
npm test
cd ../..
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs
git commit -m "refactor(task-agent): split Feishu startup phases"
```

Expected: 全量测试 0 failure；用户输出和启动顺序仍与修改前相同。

---

### Task 5: Feishu Bridge 按绑定有界并发

**Files:**
- Modify: `packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs:45-75,1600-1775,1995-2080`
- Modify: `packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/startup-summary.test.mjs`
- Modify: `packages/aamp-feishu-task-agent/test/runtime-network.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `runLayeredStarts()` 和 `createKeyedSerialExecutor()`，Task 4 的 prepare/execute 描述符。
- Produces: `startBindingsWithGroups(bindings, groups, mode)`，返回稳定顺序的 `{ running, failed, cancelled }`；`orderStartupItems(bindings, items)` 统一恢复用户选择顺序；`start` 和 `install` 共用该入口。

- [ ] **Step 1: 写串行预检、四路并发、稳定顺序和 pairing key 的 RED 测试**

扩展 `startup-concurrency.test.mjs`，直接测试 Task 2 的 engine，并断言 controller 的 wiring：

```js
import { runLayeredStarts } from '../bin/runtime-concurrency.mjs'

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition was not reached')
}

test('four Feishu starts overlap after every preparation has completed', async () => {
  const prepared = []
  const entered = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const execution = runLayeredStarts(['traex', 'workbuddy', 'codex', 'cursor'], {
    concurrency: 4,
    async prepare(item) {
      assert.equal(entered.length, 0)
      prepared.push(item)
      return item
    },
    async start(item) {
      assert.equal(prepared.length, 4)
      entered.push(item)
      await gate
      return item
    },
  })
  while (entered.length < 4) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(entered, ['traex', 'workbuddy', 'codex', 'cursor'])
  release()
  const outcomes = await execution
  assert.deepEqual(outcomes.map(({ value }) => value), ['traex', 'workbuddy', 'codex', 'cursor'])
})

test('a fifth Feishu start waits until one of four slots is released', async () => {
  const entered = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const execution = runLayeredStarts(['a', 'b', 'c', 'd', 'e'], {
    concurrency: 4,
    async prepare(item) { return item },
    async start(item) {
      entered.push(item)
      if (item !== 'e') await gate
      return item
    },
  })
  await until(() => entered.length === 4)
  assert.deepEqual(entered, ['a', 'b', 'c', 'd'])
  release()
  await until(() => entered.includes('e'))
  await execution
})

test('one Feishu start failure does not block independent starts', async () => {
  const outcomes = await runLayeredStarts(['traex', 'bad', 'codex'], {
    concurrency: 3,
    async prepare(item) { return item },
    async start(item) {
      if (item === 'bad') throw new Error('ready timeout')
      return item
    },
  })
  assert.deepEqual(outcomes.map(({ status }) => status), [
    'fulfilled', 'rejected', 'fulfilled',
  ])
  assert.deepEqual(
    outcomes.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
    ['traex', 'codex'],
  )
})

test('Agent preparation stays serial and Feishu starts only after bridge.running', () => {
  const setupStart = source.indexOf('async function setupAgentGroups(')
  const setupEnd = source.indexOf('\nfunction resolveGroup(', setupStart)
  const setup = source.slice(setupStart, setupEnd)
  assert.match(setup, /for \(const \[host, agentBindings\] of byHost\)/)
  assert.match(setup, /for \(const \[agentType, sampleBinding\] of agentBindings\)/)
  assert.match(setup, /await runBootstrapHelper\('__prepare-agent'/)
  assert.match(setup, /await waitForEvent\(process, \(event\) => event\.type === 'bridge\.running'\)/)

  const selectedStart = source.indexOf('async function startSelectedBindings(')
  const selectedEnd = source.indexOf('\nasync function markRuntimeFailed(', selectedStart)
  const selected = source.slice(selectedStart, selectedEnd)
  assert.ok(
    selected.indexOf('await setupAgentGroups(onlineBindings)')
      < selected.indexOf("startBindingsWithGroups(onlineBindings, groups, 'start')"),
  )
})

test('controller gates pending pairing by host and stable agent type', () => {
  assert.match(source, /const runPairingSerially = createKeyedSerialExecutor\(\)/)
  assert.match(source, /function pairingQueueKey\(prepared\)/)
  assert.match(source, /`\$\{prepared\.group\.host\}\\u0000\$\{prepared\.binding\.agent_type\}`/)
  assert.match(source, /runPairingSerially\(pairingQueueKey\(prepared\)/)
})

test('start and install share the same layered binding launcher', () => {
  assert.match(source, /async function startBindingsWithGroups\(bindings, groups, mode\)/)
  assert.match(source, /startSelectedBindings[\s\S]*startBindingsWithGroups\(onlineBindings, groups, 'start'\)/)
  assert.match(source, /runBindingSession[\s\S]*startBindingsWithGroups\(saved, groups, mode\)/)
})
```

- [ ] **Step 2: 运行 focused 测试并确认 wiring RED**

Run: `cd packages/aamp-feishu-task-agent && node --test test/startup-concurrency.test.mjs`

Expected: engine 测试 PASS；controller wiring 断言 FAIL。

- [ ] **Step 3: 接入并发常量、pairing keyed executor 和共享启动入口**

在 controller 顶部加入：

```js
import {
  createKeyedSerialExecutor,
  runLayeredStarts,
} from './runtime-concurrency.mjs';

const FEISHU_START_CONCURRENCY = 4;
const runPairingSerially = createKeyedSerialExecutor();

function pairingQueueKey(prepared) {
  return `${prepared.group.host}\u0000${prepared.binding.agent_type}`;
}

function orderStartupItems(bindings, items) {
  const order = new Map(bindings.map((binding, index) => [binding.binding_id, index]));
  return [...items].sort((left, right) => (
    (order.get(left.binding.binding_id) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.binding.binding_id) ?? Number.MAX_SAFE_INTEGER)
  ));
}
```

将 Task 4 的 pending 分支包入：

```js
return runPairingSerially(pairingQueueKey(prepared), async () => {
  return executePreparedPendingBindingStart(prepared);
});
```

ready 分支不进入 keyed 队列。

- [ ] **Step 4: 实现共享 `startBindingsWithGroups()`**

函数先同步分类取消项，再调用 `runLayeredStarts()`；prepare callback 中执行所有 profile/auth
预检，start callback 只执行非交互启动：

```js
async function startBindingsWithGroups(bindings, groups, mode) {
  const cancelled = [];
  const candidates = [];
  for (const binding of bindings) {
    throwIfStopping();
    const reason = bindingCancellationReason(groups, binding);
    if (reason) {
      cancelled.push({ binding, reason });
      await setBindingStatus(binding, mode === 'install' ? 'bind' : 'start', 'cancelled', reason);
      printBindingCancelled(binding, reason);
    } else {
      candidates.push(binding);
    }
  }

  const outcomes = await runLayeredStarts(candidates, {
    concurrency: FEISHU_START_CONCURRENCY,
    prepare: (binding) => prepareBindingStart(binding, groups, mode),
    start: (prepared) => executePreparedBindingStart(prepared),
  });
  if (stopRequested) throw new Error(`已收到 ${stopSignal || '停止信号'}，不再启动新的 Bridge`);

  const running = [];
  const failed = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') {
      running.push(outcome.value);
      if (mode === 'start') {
        printBindingStarted(outcome.value.binding, outcome.value.runtimeAgentType);
      }
      continue;
    }
    const binding = outcome.item;
    const reason = redact(outcome.reason?.message || outcome.reason);
    const runtimeAgentType = groups.get(binding.aamp_host)?.runtimeAgentTypes?.get(binding.agent_type)
      || binding.agent_type;
    failed.push({ binding, reason, runtimeAgentType });
    await setBindingStatus(binding, 'start', 'failed', reason);
    await recordError('startup', reason, binding);
    console.error(`🔴 启动失败：${bindingLabel(binding, runtimeAgentType)}\n   原因：${reason}`);
    if (mode === 'install') {
      console.error('   绑定配置已保存，可稍后运行 feishu-task-agent start 重试。');
    } else {
      console.error('   已跳过该项，继续启动下一项。');
    }
  }
  return {
    running: orderStartupItems(bindings, running),
    failed: orderStartupItems(bindings, failed),
    cancelled: orderStartupItems(bindings, cancelled),
  };
}
```

`startSelectedBindings()` 合并 Online 校验失败与返回结果后再 reconcile。`runBindingSession()`
将 `running` 映射到 `succeeded`，并保留 saved pending 失败项。两处都不得按 Promise 完成顺序
push 结果。

`startSelectedBindings()` 用以下顺序组合结果；`validationFailures` 是前面的 Online schema
校验失败，不能被并发 launcher 的结果覆盖：

```js
const launched = await startBindingsWithGroups(onlineBindings, groups, 'start');
const reconciled = await reconcileRetainedBindings(launched.running);
const orderedRunning = orderStartupItems(bindings, reconciled.alive);
const orderedFailed = orderStartupItems(bindings, [
  ...validationFailures,
  ...launched.failed,
  ...reconciled.failed,
]);
const orderedCancelled = orderStartupItems(bindings, launched.cancelled);
printStartupSummary({
  title: '已成功启动',
  plannedCount: bindings.length,
  running: orderedRunning,
  failed: orderedFailed,
  cancelled: orderedCancelled,
});
```

`runBindingSession('install')` 则按已保存顺序写回各个 bucket；pairing 成功的 binding 已由
Task 4 的 pending executor 逐项原子升级为 ready：

```js
const launched = await startBindingsWithGroups(saved, groups, mode);
running.push(...launched.running);
succeeded.push(...launched.running.map(({ binding }) => binding));
failed.push(...launched.failed);
cancelled.push(...launched.cancelled);
```

- [ ] **Step 5: 补充摘要稳定顺序和并发 ACP 事件重试测试**

把 `orderStartupItems` 加入 controller 的 test export。在 `startup-summary.test.mjs` 构造完成
顺序为 cursor、traex、codex，但选择顺序为 traex、codex、cursor，直接断言排序结果；再把
排序结果传给摘要函数。在 `runtime-network.test.mjs` 增加乱序事件：

```js
const {
  installHasOnlyCancellations,
  orderStartupItems,
  startupSummaryLines,
} = await import(pathToFileURL(controllerPath).href)

test('concurrent completion order is restored to binding selection order', () => {
  const selected = [
    { binding_id: 'traex', ...binding('traex', 'Trae', 'cli_traex') },
    { binding_id: 'codex', ...binding('codex', 'Codex', 'cli_codex') },
    { binding_id: 'cursor', ...binding('cursor', 'Cursor', 'cli_cursor') },
  ]
  const completed = [selected[2], selected[0], selected[1]].map((item) => ({ binding: item }))
  assert.deepEqual(
    orderStartupItems(selected, completed).map(({ binding: item }) => item.binding_id),
    ['traex', 'codex', 'cursor'],
  )
})
```

```js
test('ACP retry detection is independent of concurrent event completion order', () => {
  const events = [
    { type: 'agent.started', agent: 'cursor' },
    { type: 'agent.failed', agent: 'codex', message: 'fetch failed | code=ECONNRESET' },
    { type: 'agent.started', agent: 'traex' },
    { type: 'bridge.running', agents: [{ name: 'traex' }, { name: 'cursor' }] },
  ]
  assert.equal(
    runtimeNetwork.classifyNetworkError(
      runtimeNetwork.agentStartRetryError(events, ['codex', 'cursor', 'traex'], 1, 3),
    ),
    'connection_reset',
  )
})
```

- [ ] **Step 6: 运行 focused 测试并修复所有 RED**

```bash
cd packages/aamp-feishu-task-agent
node --test \
  test/startup-concurrency.test.mjs \
  test/startup-summary.test.mjs \
  test/binding-persistence.test.mjs \
  test/runtime-network.test.mjs
```

Expected: 全部 PASS；测试必须证明 peak concurrency 为 4、preflight peak 为 1、结果顺序稳定。

- [ ] **Step 7: 运行 Task Agent 全量回归并提交**

```bash
cd packages/aamp-feishu-task-agent
npm test
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
node --check bin/feishu-task-agent-controller.mjs
cd ../..
git diff --check
```

Expected: 全量测试 0 failure；shell/Node 语法和 diff check 均 exit 0。

```bash
git add packages/aamp-feishu-task-agent/bin/feishu-task-agent-controller.mjs \
  packages/aamp-feishu-task-agent/test/startup-concurrency.test.mjs \
  packages/aamp-feishu-task-agent/test/startup-summary.test.mjs \
  packages/aamp-feishu-task-agent/test/binding-persistence.test.mjs \
  packages/aamp-feishu-task-agent/test/runtime-network.test.mjs
git commit -m "perf(task-agent): start Feishu bindings concurrently"
```

---

### Task 6: 全量验证、性能测量与真实任务验收

**Files:**
- Verify only: `packages/aamp-acp-bridge/**`
- Verify only: `packages/aamp-feishu-task-agent/**`
- Verify only: `packages/aamp-feishu-bridge/**`
- Verify only: `docs/superpowers/specs/2026-08-13-layered-bridge-startup-concurrency-design.md`

**Interfaces:**
- Consumes: Tasks 1–5 的最终分支。
- Produces: 可复核的自动化测试结果、本地 tgz、三轮耗时日志和四 Agent 飞书任务链路证据；本任务不发布 npm、不修改版本号。

- [ ] **Step 1: 运行三个包的最终自动化验证**

```bash
cd packages/aamp-acp-bridge
npm test
npm run build

cd ../aamp-feishu-task-agent
npm test
bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh
node --check bin/feishu-task-agent-controller.mjs

cd ../aamp-feishu-bridge
npx tsx --test "src/**/*.test.ts"
npm run build

cd ../..
git diff --check
git status --short
```

Expected: 所有测试和 build exit 0；只有本功能预期文件发生变化；`.agents/.run_state.json`
继续保持未跟踪且不进入提交。

- [ ] **Step 2: 本地打包三个测试包，不发布 npm**

```bash
repo_root="$(git rev-parse --show-toplevel)"
mkdir -p "$repo_root/.superpowers/artifacts/layered-startup"

(cd packages/aamp-acp-bridge && npm pack --pack-destination "$repo_root/.superpowers/artifacts/layered-startup")
(cd packages/aamp-feishu-bridge && npm pack --pack-destination "$repo_root/.superpowers/artifacts/layered-startup")
(cd packages/aamp-feishu-task-agent && npm pack --pack-destination "$repo_root/.superpowers/artifacts/layered-startup")

ls -lh "$repo_root/.superpowers/artifacts/layered-startup"/*.tgz

for archive in "$repo_root/.superpowers/artifacts/layered-startup"/*.tgz; do
  if tar -tzf "$archive" | grep -E '(^|/)(\.agents|\.aamp)(/|$)|(^|/)(credentials\.json|pairing\.json|sender-policies\.json|errors\.jsonl|manifest\.json|bindings-v1\.json)$'; then
    echo "unexpected local runtime artifact in $archive" >&2
    exit 1
  fi
done
```

Expected: 生成 ACP Bridge、Feishu Bridge、Task Agent 三个 tgz；tarball 中不包含源码外的凭据、
本地日志或 `.agents/.run_state.json`。

- [ ] **Step 3: 用本地 tgz 安装并连续测量三轮四绑定 ready 启动**

先把本地 Task Agent 安装到现有 AAMP npm prefix，并显式关闭自动更新、覆盖两个 Bridge
包路径：

```bash
repo_root="$(git rev-parse --show-toplevel)"
artifact_dir="$repo_root/.superpowers/artifacts/layered-startup"
ACP_TGZ="$(find "$artifact_dir" -maxdepth 1 -name '*aamp-acp-bridge*.tgz' -print -quit)"
FEISHU_TGZ="$(find "$artifact_dir" -maxdepth 1 -name '*aamp-feishu-bridge*.tgz' -print -quit)"
TASK_TGZ="$(find "$artifact_dir" -maxdepth 1 -name '*aamp-feishu-task-agent*.tgz' -print -quit)"

test -f "$ACP_TGZ" && test -f "$FEISHU_TGZ" && test -f "$TASK_TGZ"
npm install -g --prefix "$HOME/.aamp/npm-global" --force "$TASK_TGZ"

AAMP_TASK_AUTO_UPDATE=false \
ACP_BRIDGE_PKG="$ACP_TGZ" \
FEISHU_BRIDGE_PKG="$FEISHU_TGZ" \
"$HOME/.aamp/npm-global/bin/feishu-task-agent" start
```

`start` 会在成功后常驻，因此不能用 shell 命令退出时间衡量。每轮看到启动摘要后，在另一
终端取本轮最新 run directory，并用 manifest 的开始时间和最后一个成功 Bridge stage 的
时间计算：

```bash
RUN_DIR="$(find "$HOME/.aamp/logs/runs" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)" \
node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const dir = process.env.RUN_DIR;
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const events = fs.readdirSync(dir)
  .filter((name) => name.endsWith(".jsonl"))
  .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/))
  .filter(Boolean)
  .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const completed = events.filter((event) => (
  event.type === "bridge.stage" && event.status === "succeeded" && event.timestamp
));
if (completed.length === 0) throw new Error("no successful bridge stages found");
const startedAt = Date.parse(manifest.started_at);
const completedAt = Math.max(...completed.map((event) => Date.parse(event.timestamp)));
console.log(JSON.stringify({
  runDir: dir,
  startupSeconds: (completedAt - startedAt) / 1000,
}, null, 2));
'
```

记录结果后在启动终端按 Ctrl+C，确认进程清理，再重复两轮。

Expected:

- 三轮中位数不超过 50 秒，任一轮不超过 60 秒；
- 相比设计文档记录的修改前 120 秒下界，中位数至少下降 58.3%，因此满足“下降至少
  50%”的相对目标；
- ACP 日志中四个 `agent.starting` 在第一个 `agent.started/failed` 之前出现；
- ACP 峰值并发为 4，只有一个 ACP Bridge PID；
- Feishu 四个 `bridge.process status=started` 的时间区间重叠；
- 日志显示 ACP 总耗时接近最慢 Agent、Feishu 总耗时接近最慢绑定；
- 无登录、升级、首次 npm 下载或网络重试混入性能样本。

- [ ] **Step 4: 验证两个 ready 加两个 pending 的配对场景**

创建或选择两个 pending 绑定与两个 ready 绑定，沿用 Step 3 的本地 tgz、耗时脚本和
Ctrl+C 清理方式连续启动三次，取 `startupSeconds` 中位数。每轮检查：

- pending 绑定在启动前已经存在于 `bindings-v1.json`；
- 不同 Agent 的 pairing 区间允许重叠；
- 如果同 Agent 有两个 pending 绑定，第二个 `pairing.created` 只能在第一个 pairing 被消费
  后出现；
- 成功项升级为 ready，失败项仍为 pending；
- 总耗时中位目标不超过 70 秒。

- [ ] **Step 5: 验证失败隔离和停止语义**

先用 Tasks 1 和 5 新增的 fake 精确覆盖 Agent 非网络失败、Feishu ready 失败、全部失败和
stop 尽力清理：

```bash
cd packages/aamp-acp-bridge
npx tsx --test \
  --test-name-pattern='one failed agent|all failures|stop attempts' \
  src/bridge.test.ts

cd ../aamp-feishu-task-agent
node --test \
  --test-name-pattern='one Feishu start failure|fifth Feishu start|concurrent completion order|reconciled runtime failure' \
  test/startup-concurrency.test.mjs \
  test/startup-summary.test.mjs
```

Expected: 所选测试全部 PASS；单项失败后其他项 fulfilled，第五项在一个 slot 释放前不进入
start callback，全部失败不发 `bridge.running`，stop 即使一项报错仍尝试全部 Agent。

再用 Step 3 的本地 tgz 启动四个 ready 绑定。看到 Feishu 启动日志后，在第二个终端记录本轮
所有受管 PID：

```bash
RUN_DIR="$(find "$HOME/.aamp/logs/runs" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)"
PID_FILE="$(mktemp -t aamp-layered-start-pids)"
RUN_DIR="$RUN_DIR" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const dir = process.env.RUN_DIR;
for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "bridge.process" && event.status === "started" && Number.isInteger(event.pid)) {
        console.log(event.pid);
      }
    } catch {}
  }
}
' | sort -nu > "$PID_FILE"
test "$(wc -l < "$PID_FILE" | tr -d ' ')" -ge 5
cat "$PID_FILE"
```

回到启动终端按 Ctrl+C，等待 Task Agent 退出，再执行：

```bash
while IFS= read -r managed_pid; do
  if kill -0 "$managed_pid" 2>/dev/null; then
    echo "managed process is still alive: $managed_pid" >&2
    exit 1
  fi
done < "$PID_FILE"

test ! -d "$HOME/.aamp/feishu-task-agent/runtime-v1/leases/runtime-session.lock"
if find "$HOME/.aamp/feishu-task-agent/runtime-v1/leases" \
  -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .; then
  echo 'managed lease was not released' >&2
  exit 1
fi
```

最后再启动一轮，用同一 run directory 中 `bridge.process.label` 区分 ACP 和 Feishu PID：

```bash
RUN_DIR="$(find "$HOME/.aamp/logs/runs" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)"
PROCESS_FILE="$(mktemp -t aamp-layered-start-processes)"
RUN_DIR="$RUN_DIR" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const dir = process.env.RUN_DIR;
for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "bridge.process" || event.status !== "started" || !Number.isInteger(event.pid)) continue;
      if (event.label.startsWith("ACP Bridge ")) console.log(`acp ${event.pid}`);
      if (event.label.startsWith("Feishu Bridge ")) console.log(`feishu ${event.pid}`);
    } catch {}
  }
}
' | sort -u > "$PROCESS_FILE"

ACP_PID="$(awk '$1 == "acp" { print $2; exit }' "$PROCESS_FILE")"
test -n "$ACP_PID"
test "$(awk '$1 == "feishu" { count += 1 } END { print count + 0 }' "$PROCESS_FILE")" -eq 4
kill -TERM "$ACP_PID"
sleep 3
while read -r kind managed_pid; do
  test "$kind" = feishu || continue
  if kill -0 "$managed_pid" 2>/dev/null; then
    echo "Feishu Bridge survived ACP exit: $managed_pid" >&2
    exit 1
  fi
done < "$PROCESS_FILE"
```

回到 Task Agent 终端按 Ctrl+C 完成收尾。这验证 `supervise()` 的“ACP 退出即停止该 host
下 Feishu Bridge”路径，而不是只验证启动结果。

逐项确认：

- 无依赖关系的绑定仍成功并保持运行；
- 最终摘要的分母仍为计划启动数；
- 成功、失败、取消按选择顺序展示；
- ACP 退出会停止其 host 下的 Feishu Bridge；
- SIGINT 后没有新的 Bridge 被启动，全部受管进程和 leases 被清理；
- manifest、errors JSONL 和 binding store 与输出一致。

- [ ] **Step 6: 完成四 Agent 真实飞书任务验收**

保持一个四绑定 `feishu-task-agent start` 进程运行，分别向 `traex`、`workbuddy`、`codex`、
`cursor` 派发一条代表性任务。每条任务都确认：

1. 对应 Feishu Task event 被正确 binding 消费；
2. 任务发送到正确 Agent mailbox；
3. ACP 流式事件持续更新 Step，而不是只返回最终占位文案；
4. 最终回答写入任务评论或产物；
5. 任务最终状态正确；
6. 其他三个 Agent 没有串收任务。

Expected: 四条链路全部通过。只看到 `agent.started`、`bridge.running` 或 Feishu Bridge ready
不能记为通过。

- [ ] **Step 7: 最终审查并提交验证中产生的必要测试修复**

若步骤 1–6 暴露实现缺陷，先为缺陷增加最小回归测试，再修复并重复全部验证。最终执行：

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: Tasks 1–5 的提交存在且顺序清晰；没有版本号、lockfile、tgz、日志或
`.agents/.run_state.json` 被提交。若没有验证期修复，本步骤不创建空提交。
