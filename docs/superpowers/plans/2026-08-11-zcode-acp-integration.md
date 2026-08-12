# ZCode ACP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready macOS ZCode Protocol v1 to ACP adapter to the existing aamp-acp-bridge package so that one package install and one init command can run ZCode through AAMP/acpx.

**Architecture:** A second package binary, aamp-zcode-acp, serves standard ACP with @agentclientprotocol/sdk and owns one official ZCode app-server child. A strict NDJSON client handles the ZCode request/response/notification envelopes; pure translators and a per-session runtime isolate content, lifecycle, permission, and streaming behavior. Existing AAMP bridge code only gains ZCode discovery and the sibling binary command.

**Tech Stack:** TypeScript 5.4, Node.js ES2022/NodeNext, @agentclientprotocol/sdk 0.28.x, Zod 3, node:test through tsx, acpx 0.11.2, npm.

## Global Constraints

- Work only in /Users/bytedance/WsCodex/LuckyTerry/aamp-worktrees/feat-zcode-acp-support on branch feat/zcode-acp-support.
- Keep production changes inside packages/aamp-acp-bridge; documentation stays under docs/superpowers.
- Implement macOS discovery first. The resolver may accept injected platform/path values for tests, but must not claim Windows or Linux support.
- Launch only the official embedded CLI with process.execPath and an argument array: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server.
- Never write ZCode databases, ZCode Desktop state, ~/.zcode/cli/config.json, credentials, OAuth values, or shell startup files.
- Do not invoke zcode login automatically. Convert model_config_missing into an actionable error that names the official login command.
- The ACP side is JSON-RPC managed by @agentclientprotocol/sdk. The ZCode side is strict NDJSON with {id, method, params}, {id, result}, {id, error}, or {method, params}; never add a jsonrpc field to ZCode messages.
- Keep adapter stdout protocol-clean. All diagnostics go to stderr through an injected logger.
- Advertise only loadSession plus session list, resume, and close. Do not advertise delete, fork, additionalDirectories, images, audio, embedded context, ACP-transport MCP, terminal, or filesystem capabilities.
- Accept ACP text and resource-link prompt blocks. Reject all unsupported content atomically before session/send.
- ACP session/load replays prior history; session/resume does not.
- One foreground prompt is allowed per session, while different sessions may run concurrently.
- Preserve secrets in memory only and redact MCP environment values, headers, model credentials, and ZCode stderr from normal logs.
- Every behavior change follows RED-GREEN-REFACTOR: add one focused test, run it and observe the expected failure, implement the minimum, rerun it, then run the affected suite.
- Do not weaken an assertion just to make a test pass. If a local ZCode response differs from the documented fixture, update the typed boundary and add the observed shape as a fixture.
- Commit after each task only when its focused tests and npm run build pass.

## File Map

### Create

- packages/aamp-acp-bridge/src/known-agents.ts
  - Single source of truth for the setup/discovery agent names.
- packages/aamp-acp-bridge/src/zcode-acp/app-locator.ts
  - macOS embedded CLI resolution, validation, version probe, and login command rendering.
- packages/aamp-acp-bridge/src/zcode-acp/protocol.ts
  - ZCode Protocol v1 envelopes, request/result/event types, Zod boundary validation, and protocol marker guard.
- packages/aamp-acp-bridge/src/zcode-acp/rpc-client.ts
  - Child process lifecycle, bounded NDJSON framing, request correlation, inbound request dispatch, stderr tail, and shutdown.
- packages/aamp-acp-bridge/src/zcode-acp/translator.ts
  - Pure ACP-to-ZCode and snapshot/history/session/model/MCP translation.
- packages/aamp-acp-bridge/src/zcode-acp/event-translator.ts
  - Stateful live event to ACP update translation with text/tool deduplication.
- packages/aamp-acp-bridge/src/zcode-acp/runtime.ts
  - Multi-session orchestration, prompt completion, replay boundary, permissions, cancellation, mode/model mutation, and usage lookup.
- packages/aamp-acp-bridge/src/zcode-acp/agent.ts
  - Typed ACP handler registration and capability response.
- packages/aamp-acp-bridge/src/zcode-acp-cli.ts
  - aamp-zcode-acp serve/version/help entrypoint and signal/EOF cleanup.
- packages/aamp-acp-bridge/test/fixtures/fake-zcode.mjs
  - Deterministic ZCode Protocol child used by transport and end-to-end tests.
- packages/aamp-acp-bridge/test/zcode-app-locator.test.ts
- packages/aamp-acp-bridge/test/zcode-rpc-client.test.ts
- packages/aamp-acp-bridge/test/zcode-translator.test.ts
- packages/aamp-acp-bridge/test/zcode-event-translator.test.ts
- packages/aamp-acp-bridge/test/zcode-runtime.test.ts
- packages/aamp-acp-bridge/test/zcode-agent.test.ts
- packages/aamp-acp-bridge/test/zcode-cli.test.ts
- packages/aamp-acp-bridge/test/zcode-init.test.ts

### Modify

- packages/aamp-acp-bridge/package.json
  - Bump 0.1.28 to 0.1.29, add SDK dependency, test/prepack scripts, and aamp-zcode-acp bin.
- packages/aamp-acp-bridge/package-lock.json
  - Lock the new runtime and test dependencies.
- packages/aamp-acp-bridge/src/agent-resolver.ts
  - Delegate ZCode detection to app-locator and return aamp-zcode-acp serve.
- packages/aamp-acp-bridge/src/cli/init.ts
  - Import the shared known-agent catalog.
- packages/aamp-acp-bridge/src/discovery.ts
  - Import the shared known-agent catalog.
- packages/aamp-acp-bridge/src/index.ts
  - Mention ZCode in help examples.
- packages/aamp-acp-bridge/README.md
  - Document one-step setup, macOS path override, official login prerequisite, capabilities, and troubleshooting.
- docs/superpowers/specs/2026-08-11-zcode-acp-integration-design.md
  - Record approved status and protocol-probe corrections.

---

## Task 1: Establish the Test Harness, Dependency Boundary, and ZCode Discovery

**Files:**

- Create: packages/aamp-acp-bridge/src/known-agents.ts
- Create: packages/aamp-acp-bridge/src/zcode-acp/app-locator.ts
- Create: packages/aamp-acp-bridge/test/zcode-app-locator.test.ts
- Modify: packages/aamp-acp-bridge/package.json
- Modify: packages/aamp-acp-bridge/package-lock.json
- Modify: packages/aamp-acp-bridge/src/agent-resolver.ts
- Modify: packages/aamp-acp-bridge/src/cli/init.ts
- Modify: packages/aamp-acp-bridge/src/discovery.ts

- [ ] **Step 1: Add the failing discovery tests**

Cover all of these cases in zcode-app-locator.test.ts:

~~~ts
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KNOWN_AGENTS } from '../src/known-agents.js'
import {
  DEFAULT_ZCODE_CLI_PATH,
  ZCODE_ACP_COMMAND,
  detectZcodeInstallation,
  renderZcodeLoginCommand,
} from '../src/zcode-acp/app-locator.js'

test('the shared catalog contains zcode once', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'zcode').length, 1)
})

test('the environment override wins over the default app path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aamp-zcode-locator-'))
  const cliPath = join(dir, 'zcode.cjs')
  writeFileSync(cliPath, 'process.stdout.write("0.16.1\\n")')

  const result = detectZcodeInstallation({
    platform: 'darwin',
    env: { AAMP_ZCODE_CLI_PATH: cliPath },
    runVersion: () => '0.16.1',
  })

  assert.deepEqual(result, {
    command: cliPath,
    acpCommand: ZCODE_ACP_COMMAND,
    version: '0.16.1',
  })
  assert.equal(DEFAULT_ZCODE_CLI_PATH.endsWith('/ZCode.app/Contents/Resources/glm/zcode.cjs'), true)
  assert.match(renderZcodeLoginCommand(cliPath), /login$/)
})

test('a missing embedded CLI is not detected', () => {
  assert.equal(detectZcodeInstallation({
    platform: 'darwin',
    env: { AAMP_ZCODE_CLI_PATH: '/missing/zcode.cjs' },
    runVersion: () => '0.16.1',
  }), undefined)
})

test('the first release does not auto-detect ZCode off macOS', () => {
  assert.equal(detectZcodeInstallation({
    platform: 'linux',
    env: {},
    runVersion: () => '0.16.1',
  }), undefined)
})
~~~

Also assert through agent-resolver.ts that detectKnownAgent('zcode'), defaultAcpCommand('zcode'), and missingAgentWarning('zcode') use the locator result and actionable path text. Inject the locator dependencies instead of changing process.platform in tests.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-app-locator.test.ts
~~~

Expected: FAIL with module-not-found for known-agents.ts or app-locator.ts. A passing command means the test is not exercising the new surface.

- [ ] **Step 3: Install and lock the protocol dependencies**

Run:

~~~bash
cd packages/aamp-acp-bridge
npm install @agentclientprotocol/sdk@^0.28.1
npm install --save-dev acpx@0.11.2
~~~

Edit package.json so the scripts and package metadata are exactly:

~~~json
{
  "version": "0.1.29",
  "bin": {
    "aamp-acp-bridge": "dist/index.js",
    "aamp-zcode-acp": "dist/zcode-acp-cli.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "tsx --test test/*.test.ts",
    "start": "node dist/index.js",
    "prepack": "npm run build"
  }
}
~~~

Keep aamp-sdk, qrcode-terminal, zod, the optional acpx peer, and all existing dev dependencies unchanged. Verify package-lock.json records package version 0.1.29, @agentclientprotocol/sdk under dependencies, and acpx under devDependencies.

- [ ] **Step 4: Implement the shared catalog and locator**

known-agents.ts must export one immutable catalog:

~~~ts
export const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
  'hermes', 'zcode',
] as const
~~~

app-locator.ts must export these contracts:

~~~ts
export const DEFAULT_ZCODE_CLI_PATH =
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
export const ZCODE_ACP_COMMAND = 'aamp-zcode-acp serve'
export const ZCODE_CLI_OVERRIDE = 'AAMP_ZCODE_CLI_PATH'

export interface ZCodeInstallation {
  command: string
  acpCommand: typeof ZCODE_ACP_COMMAND
  version: string
}

export interface ZCodeLocatorOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  defaultPath?: string
  runVersion?: (cliPath: string) => string
}

export function resolveZcodeCliPath(options?: ZCodeLocatorOptions): string | undefined
export function detectZcodeInstallation(options?: ZCodeLocatorOptions): ZCodeInstallation | undefined
export function renderZcodeLoginCommand(cliPath: string): string
~~~

Use statSync to require a regular file and accessSync with R_OK to require readability. The default version runner must call execFileSync(process.execPath, [cliPath, '--version'], {timeout: 5000, stdio: 'pipe'}) and return the first non-empty line. Do not use a shell or accept a directory.

Refactor init.ts and discovery.ts to import KNOWN_AGENTS. Add optional resolver dependencies to detectKnownAgent only as needed for deterministic tests, while preserving every existing call site.

- [ ] **Step 5: Run GREEN and the existing build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-app-locator.test.ts
npm run build
~~~

Expected: all locator tests pass and tsc exits 0.

- [ ] **Step 6: Commit Task 1**

Run:

~~~bash
git add packages/aamp-acp-bridge/package.json packages/aamp-acp-bridge/package-lock.json packages/aamp-acp-bridge/src/known-agents.ts packages/aamp-acp-bridge/src/zcode-acp/app-locator.ts packages/aamp-acp-bridge/src/agent-resolver.ts packages/aamp-acp-bridge/src/cli/init.ts packages/aamp-acp-bridge/src/discovery.ts packages/aamp-acp-bridge/test/zcode-app-locator.test.ts
git commit -m "feat: detect ZCode for ACP setup"
~~~

---

## Task 2: Build the Strict ZCode NDJSON Transport

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp/protocol.ts
- Create: packages/aamp-acp-bridge/src/zcode-acp/rpc-client.ts
- Create: packages/aamp-acp-bridge/test/fixtures/fake-zcode.mjs
- Create: packages/aamp-acp-bridge/test/zcode-rpc-client.test.ts

- [ ] **Step 1: Create a deterministic fake ZCode child**

The fixture must support --version and app-server. Under app-server it reads one JSON object per line and switches on FAKE_ZCODE_SCENARIO. Every response must use the ZCode envelope without jsonrpc. Provide scenarios named happy, split-frames, coalesced-frames, runtime-preferences, timeout, malformed, oversized, protocol-error, and crash.

For happy, answer session/list with:

~~~json
{"id":"client-1","result":{"sessions":[]}}
~~~

For runtime-preferences, send this server request before answering session/create:

~~~json
{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_fake","scope":"session"}}
~~~

Record inbound client envelopes to the path in FAKE_ZCODE_RECORD_PATH using append-only NDJSON so tests can assert that jsonrpc and secrets are absent.

- [ ] **Step 2: Add failing transport tests**

zcode-rpc-client.test.ts must prove:

- request IDs are client-1, client-2, and responses may arrive out of order;
- outgoing requests contain only id, method, params, and optional trace;
- split JSON lines and multiple lines in one chunk are parsed;
- malformed JSON, a frame above 1 MiB, request timeout, protocol error, and child crash reject with stable typed errors;
- pending requests are rejected exactly once during close;
- an inbound session/requestRuntimePreferences request can be answered;
- stderr is bounded to 32 KiB, excluded from ordinary successful logs, and redacted before appearing in an error;
- close is idempotent and leaves no child alive.

The first core test should read:

~~~ts
test('sends strict ZCode envelopes and correlates out-of-order responses', async () => {
  const client = await startFakeZcode('coalesced-frames')
  const first = client.request('session/list', {})
  const second = client.request('session/list', { limit: 1 })
  assert.deepEqual(await Promise.all([first, second]), [
    { sessions: [{ sessionId: 'sess_first' }] },
    { sessions: [{ sessionId: 'sess_second' }] },
  ])
  assert.equal(readRecordedMessages().some((message) => 'jsonrpc' in message), false)
  await client.close()
})
~~~

- [ ] **Step 3: Run the transport test and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-rpc-client.test.ts
~~~

Expected: FAIL because protocol.ts and rpc-client.ts do not exist.

- [ ] **Step 4: Define the validated protocol boundary**

protocol.ts must export at least:

~~~ts
export type ZCodeRequestId = string

export interface ZCodeRequest {
  id: ZCodeRequestId
  method: string
  params: unknown
  trace?: unknown
}

export interface ZCodeNotification {
  method: string
  params: unknown
  trace?: unknown
}

export interface ZCodeSuccessResponse {
  id: ZCodeRequestId
  result: unknown
}

export interface ZCodeErrorBody {
  code?: number | string
  message: string
  data?: unknown
}

export interface ZCodeErrorResponse {
  id: ZCodeRequestId
  error: ZCodeErrorBody
}

export type ZCodeInboundEnvelope =
  | ZCodeRequest
  | ZCodeNotification
  | ZCodeSuccessResponse
  | ZCodeErrorResponse

export interface ZCodeProtocolMarker {
  protocol: { name: 'ZCode Protocol'; version: 1 }
}

export function parseZcodeEnvelope(value: unknown): ZCodeInboundEnvelope
export function assertZcodeProtocolV1(value: unknown, cliVersion: string): asserts value is ZCodeProtocolMarker
~~~

Use strict Zod object schemas for envelope discriminants, but passthrough method payloads so unknown forward-compatible fields do not fail. Explicitly reject any inbound envelope containing jsonrpc, an empty method, both result and error, or neither request nor response discriminants.

- [ ] **Step 5: Implement the bounded child client**

rpc-client.ts must export:

~~~ts
export interface ZCodeRpcClientOptions {
  cliPath: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  maxFrameBytes?: number
  maxStderrBytes?: number
  logger?: (message: string) => void
}

export interface ZCodeInboundRequestContext {
  method: string
  params: unknown
  respond: (result: unknown) => Promise<void>
  reject: (error: ZCodeErrorBody) => Promise<void>
}

export class ZCodeRpcClient {
  constructor(options: ZCodeRpcClientOptions)
  start(): Promise<void>
  request<Result>(method: string, params: unknown, timeoutMs?: number): Promise<Result>
  notify(method: string, params: unknown): Promise<void>
  onNotification(listener: (notification: ZCodeNotification) => void): () => void
  onRequest(listener: (request: ZCodeInboundRequestContext) => void | Promise<void>): () => void
  close(): Promise<void>
}
~~~

Spawn process.execPath with [cliPath, 'app-server'], stdio pipe/pipe/pipe, shell false, and detached true on non-Windows. Parse stdout as Buffer data, split only on byte 0x0a, strip one trailing 0x0d, and decode complete frames as UTF-8. Reject before allocating beyond maxFrameBytes. Keep only the last maxStderrBytes bytes.

Use client-N IDs, a Map for pending requests, one timer per request, and serialized stdin writes. Server request responses reuse the server's original ID. A request with no registered handler returns a ZCode error response with code -32601 and a descriptive message.

On close, stop new writes, reject the pending map, end stdin, wait a bounded interval for exit, send SIGTERM to the process group, then SIGKILL only after the second bound. Treat ESRCH as already exited.

- [ ] **Step 6: Run GREEN, leak check, and build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-rpc-client.test.ts
npm run build
~~~

Expected: all transport tests pass, the test process exits without the Node open-handle warning, and tsc exits 0.

- [ ] **Step 7: Commit Task 2**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/protocol.ts packages/aamp-acp-bridge/src/zcode-acp/rpc-client.ts packages/aamp-acp-bridge/test/fixtures/fake-zcode.mjs packages/aamp-acp-bridge/test/zcode-rpc-client.test.ts
git commit -m "feat: add ZCode protocol transport"
~~~

---

## Task 3: Implement Pure ACP and ZCode Translators

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp/translator.ts
- Create: packages/aamp-acp-bridge/test/zcode-translator.test.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/protocol.ts

- [ ] **Step 1: Add failing table-driven translation tests**

Cover:

- absolute cwd to {workspacePath, workspaceKey};
- rejection of relative cwd and non-empty additionalDirectories;
- ordered text plus resource-link conversion;
- atomic rejection of image, audio, and embedded-resource blocks;
- stdio, HTTP, and SSE MCP conversion including env/header arrays;
- rejection of ACP-transport MCP;
- ZCode model reference encode/decode round trip including variant;
- ZCode plan/build/edit/yolo/auto modes;
- snapshot current mode and available model list to ACP modes/configOptions;
- session list metadata and timestamps;
- stored user, assistant, reasoning, and tool parts to ordered ACP replay updates;
- malformed snapshots and unsupported protocol versions.

Use this exact prompt expectation:

~~~ts
assert.equal(toZcodePrompt([
  { type: 'text', text: 'Review this' },
  { type: 'resource_link', name: 'spec', uri: 'file:///tmp/spec.md' },
]), 'Review this\n\n[Resource link: spec]\nURI: file:///tmp/spec.md')
~~~

Use an unsupported-content test that spies on the backend and proves no session/send invocation occurs.

- [ ] **Step 2: Run the translator test and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-translator.test.ts
~~~

Expected: FAIL because translator.ts does not exist.

- [ ] **Step 3: Add the exact pure translator surface**

translator.ts must export:

~~~ts
import type {
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
} from '@agentclientprotocol/sdk'

export interface ZCodeWorkspace {
  workspacePath: string
  workspaceKey: string
}

export interface ZCodeModelRef {
  providerId: string
  modelId: string
  variant?: string
}

export function toZcodeWorkspace(cwd: string, additionalDirectories?: string[]): ZCodeWorkspace
export function toZcodePrompt(blocks: ContentBlock[]): string
export function toZcodeMcpServers(servers: McpServer[]): unknown[]
export function encodeModelRef(model: ZCodeModelRef): string
export function decodeModelRef(value: string): ZCodeModelRef
export function toAcpModes(snapshot: unknown): SessionModeState
export function toAcpConfigOptions(snapshot: unknown): SessionConfigOption[]
export function toAcpSessionInfo(session: unknown): SessionInfo
export function replaySnapshot(snapshot: unknown): SessionUpdate[]
export function rewriteZcodeError(error: unknown, cliPath: string): Error
~~~

workspaceKey must be deterministic and must not expose credentials. Use the resolved absolute workspacePath as workspaceKey unless the live protocol returns an authoritative key.

Encode model refs as URI-encoded path segments joined by slash:

~~~ts
export function encodeModelRef(ref: ZCodeModelRef): string {
  return [ref.providerId, ref.modelId, ref.variant]
    .filter((part): part is string => Boolean(part))
    .map(encodeURIComponent)
    .join('/')
}
~~~

decodeModelRef must accept exactly two or three non-empty segments and reject invalid percent encoding.

For model_config_missing, return an error containing both the original ZCode message and:

~~~text
Configure ZCode model access with: node "<resolved-cli-path>" login
~~~

Do not include config file contents or attempt login.

- [ ] **Step 4: Preserve MCP secrets without logging them**

Convert ACP stdio env maps into ZCode [{name, value}] entries and HTTP/SSE headers into the same pair representation. translator.ts may expose a redactForLog(value) helper, but tests must prove values named token, authorization, api-key, password, secret, and cookie become [REDACTED] recursively.

- [ ] **Step 5: Run GREEN and build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-translator.test.ts
npm run build
~~~

- [ ] **Step 6: Commit Task 3**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/protocol.ts packages/aamp-acp-bridge/src/zcode-acp/translator.ts packages/aamp-acp-bridge/test/zcode-translator.test.ts
git commit -m "feat: translate ACP and ZCode payloads"
~~~

---

## Task 4: Translate Live Events Without Duplicate Output

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp/event-translator.ts
- Create: packages/aamp-acp-bridge/test/zcode-event-translator.test.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/protocol.ts

- [ ] **Step 1: Add failing event-stream tests**

Build fixtures for:

- model.streaming text_start/text_delta/text_end;
- reasoning_start/reasoning_delta/reasoning_end;
- equivalent part.delta events arriving after model.streaming;
- message.upserted snapshots repeated after deltas;
- tool.updated scheduled, started, progress, result, and error;
- todo/plan projection replacement;
- mode, model, title, and session metadata changes;
- event sequence duplicates and out-of-order old events;
- unknown event types;
- two sessions with identical part/tool IDs.

The central assertion must prove the emitted assistant text is exactly Hello once when both live sources report it:

~~~ts
assert.deepEqual(collectText(updates), ['Hel', 'lo'])
assert.equal(collectText(updates).join(''), 'Hello')
~~~

Also assert that sess_a events never mutate or emit updates for sess_b.

- [ ] **Step 2: Run the event test and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-event-translator.test.ts
~~~

Expected: FAIL because event-translator.ts does not exist.

- [ ] **Step 3: Implement per-session translation state**

Export these contracts:

~~~ts
import type { SessionUpdate } from '@agentclientprotocol/sdk'

export interface ZCodeEventTranslation {
  updates: SessionUpdate[]
  completion?: {
    stopReason: 'end_turn' | 'cancelled' | 'max_turn_requests' | 'max_tokens'
    inputId?: string
  }
  failure?: Error
}

export interface ZCodeEventTranslator {
  translate(event: unknown): ZCodeEventTranslation
  reset(): void
  lastSequence(): number
}

export function createZcodeEventTranslator(sessionId: string): ZCodeEventTranslator
~~~

Keep last sequence, a bounded event-ID LRU, per-message/per-part observed buffers, emitted prefixes, and tool states. For dual text sources, append each source into its own buffer and emit only the suffix beyond the longest already emitted prefix for the same logical message/part. Never deduplicate solely by delta text because adjacent equal tokens are valid.

Map tool states as:

| ZCode | ACP |
| --- | --- |
| scheduled | pending |
| started, progress | in_progress |
| result | completed |
| error | failed |

Infer ACP tool kind from normalized tool names: read/search/fetch/edit/delete/move/execute/think/switch_mode; otherwise other. Preserve toolCallId and use the ZCode tool label or name as title.

Map turn result types:

| ZCode resultType | ACP stopReason |
| --- | --- |
| success | end_turn |
| cancelled | cancelled |
| error_max_turns, error_max_tool_calls | max_turn_requests |
| error_max_budget | max_tokens |
| error_during_execution | request error |

Unknown forward-compatible events return no updates. A malformed completion or tool event returns a contextual failure rather than completing the wrong prompt.

- [ ] **Step 4: Run GREEN and build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-event-translator.test.ts
npm run build
~~~

- [ ] **Step 5: Commit Task 4**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/protocol.ts packages/aamp-acp-bridge/src/zcode-acp/event-translator.ts packages/aamp-acp-bridge/test/zcode-event-translator.test.ts
git commit -m "feat: stream ZCode events as ACP updates"
~~~

---

## Task 5: Orchestrate Session Lifecycle, Replay, and Prompt Completion

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp/runtime.ts
- Create: packages/aamp-acp-bridge/test/zcode-runtime.test.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/protocol.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/translator.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/event-translator.ts

- [ ] **Step 1: Define a fakeable backend and add failing runtime tests**

runtime.ts must depend on this narrow backend instead of a concrete child:

~~~ts
export interface ZCodeBackend {
  request<Result>(method: string, params: unknown, timeoutMs?: number): Promise<Result>
  notify(method: string, params: unknown): Promise<void>
  onNotification(listener: (notification: ZCodeNotification) => void): () => void
  onRequest(listener: (request: ZCodeInboundRequestContext) => void | Promise<void>): () => void
  close(): Promise<void>
}
~~~

Use a recording fake to test:

- session/new validates cwd/content roots, calls session/create, validates protocol marker, subscribes continuous with includeSnapshot true, and returns the unchanged sess_* ID;
- omitted mode/model remain omitted so ZCode owns defaults;
- session/resume calls session/resume plus subscribe and emits no historical user/assistant chunks;
- session/load attaches a sequence boundary, buffers live events, paginates session/messages until complete, replays history in order, then flushes only newer buffered events;
- session/list maps metadata without inventing a nextCursor;
- session/close calls session/close and deletes local state;
- two sessions prompt concurrently while a second prompt in the same session fails;
- session/send completion is matched by session plus inputId/turnId, never by global event order;
- session/usage is requested after completion and emitted as usage_update;
- child close rejects every active prompt;
- a protocol marker other than ZCode Protocol v1 fails before session registration.

- [ ] **Step 2: Add runtime-preference tests**

When the backend delivers:

~~~json
{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_a","scope":"session"}}
~~~

the runtime must answer exactly:

~~~json
{
  "nativeSearchEnhancementsEnabled": false,
  "memoryEnabled": false,
  "askUserQuestionAutoResolutionEnabled": true,
  "modelContextBudgetStrategy": "preflight-v1"
}
~~~

Do not set integratedTerminalShell until a ZCode contract and ACP terminal bridge are implemented.

- [ ] **Step 3: Run runtime tests and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-runtime.test.ts
~~~

Expected: FAIL because runtime.ts does not exist.

- [ ] **Step 4: Implement the runtime public surface**

Export:

~~~ts
import type {
  AgentContext,
  CloseSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
} from '@agentclientprotocol/sdk'

export interface ZCodeAcpRuntimeOptions {
  backend: ZCodeBackend
  cliPath: string
  cliVersion: string
  requestTimeoutMs?: number
}

export class ZCodeAcpRuntime {
  constructor(options: ZCodeAcpRuntimeOptions)
  attachClient(client: AgentContext): void
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>
  closeSession(params: CloseSessionRequest): Promise<Record<string, never>>
  prompt(params: PromptRequest): Promise<PromptResponse>
  cancel(sessionId: string): Promise<void>
  setMode(params: SetSessionModeRequest): Promise<Record<string, never>>
  setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>
  close(): Promise<void>
}
~~~

Use one Map keyed by sessionId. Each entry holds workspace, current snapshot, event translator, last sequence, live subscription state, replay buffer, active prompt identifiers, and completion promise.

Create/resume subscription parameters must be:

~~~ts
{
  sessionId,
  deliveryKind: 'continuous',
  includeSnapshot: true,
  afterSeq,
}
~~~

Omit afterSeq when no boundary is known. Notifications arrive as method session/event with the event in params.

For load replay, fetch pages with session/messages using afterMessageId and a limit of 100 until the response returns fewer than 100 messages or no next marker. Establish eventSeq from session/subscribe before emitting replay. Queue live events during replay, discard queued events with seq at or below the boundary, then translate the remainder in ascending seq.

Send ACP updates only through:

~~~ts
await client.notify(methods.client.session.update, {
  sessionId,
  update,
})
~~~

If no ACP client is attached, reject lifecycle methods before creating a ZCode session.

- [ ] **Step 5: Implement prompt completion and stable errors**

Validate the full prompt with toZcodePrompt before calling session/send. Store the accepted inputId/queryId and match completion against it. Resolve exactly once.

After turn.completed, call session/usage. If usage succeeds, emit usage_update and include mapped usage in PromptResponse; if usage lookup fails, log a redacted diagnostic and still return the completed stopReason.

Rewrite model_config_missing with renderZcodeLoginCommand. Preserve the original ZCode error code in RequestError data where ACP permits it. Timeout, child exit, unsupported version, and shutdown messages must name the affected operation and session.

- [ ] **Step 6: Run GREEN, the lower-level suites, and build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-runtime.test.ts test/zcode-event-translator.test.ts test/zcode-translator.test.ts test/zcode-rpc-client.test.ts
npm run build
~~~

- [ ] **Step 7: Commit Task 5**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/runtime.ts packages/aamp-acp-bridge/src/zcode-acp/protocol.ts packages/aamp-acp-bridge/src/zcode-acp/translator.ts packages/aamp-acp-bridge/src/zcode-acp/event-translator.ts packages/aamp-acp-bridge/test/zcode-runtime.test.ts
git commit -m "feat: orchestrate ZCode ACP sessions"
~~~

---

## Task 6: Expose the Typed ACP Agent Contract

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp/agent.ts
- Create: packages/aamp-acp-bridge/test/zcode-agent.test.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/runtime.ts

- [ ] **Step 1: Add failing in-process SDK contract tests**

Use @agentclientprotocol/sdk client() connected directly to the AgentApp. Register:

- a session/update notification collector;
- a session/request_permission handler with a selectable outcome.

Assert initialize returns:

~~~ts
{
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: {
      list: {},
      resume: {},
      close: {},
    },
  },
  agentInfo: {
    name: 'aamp-zcode-acp',
    version: '0.1.29',
  },
}
~~~

Assert no other capability key is advertised. Exercise typed session/new, load, resume, list, close, prompt, set_mode, set_config_option, and cancel calls against the recording runtime.

Also send invalid additionalDirectories and image content through the SDK and assert a JSON-RPC invalid-params error is returned before the backend records mutation.

- [ ] **Step 2: Run the agent tests and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-agent.test.ts
~~~

Expected: FAIL because agent.ts does not exist.

- [ ] **Step 3: Register only the approved methods**

agent.ts must export:

~~~ts
import { agent, methods, PROTOCOL_VERSION, type AgentApp } from '@agentclientprotocol/sdk'

export function createZcodeAcpAgent(
  runtime: ZCodeAcpRuntime,
  version: string,
): AgentApp
~~~

Build the app with agent({ name: 'aamp-zcode-acp' }). Use onConnect to call runtime.attachClient(connection.client), then handlers:

~~~ts
app
  .onRequest(methods.agent.initialize, async () => initializeResponse)
  .onRequest(methods.agent.session.new, async ({ params }) => runtime.newSession(params))
  .onRequest(methods.agent.session.load, async ({ params }) => runtime.loadSession(params))
  .onRequest(methods.agent.session.resume, async ({ params }) => runtime.resumeSession(params))
  .onRequest(methods.agent.session.list, async ({ params }) => runtime.listSessions(params))
  .onRequest(methods.agent.session.close, async ({ params }) => runtime.closeSession(params))
  .onRequest(methods.agent.session.prompt, async ({ params }) => runtime.prompt(params))
  .onRequest(methods.agent.session.setMode, async ({ params }) => runtime.setMode(params))
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => runtime.setConfigOption(params))
  .onNotification(methods.agent.session.cancel, async ({ params }) => runtime.cancel(params.sessionId))
~~~

Do not register delete, fork, authenticate, provider, NES, document, terminal, filesystem, or extension handlers.

Convert domain validation errors to RequestError.invalidParams and unexpected backend/protocol errors to RequestError.internalError with redacted data. Preserve cancellation as a normal PromptResponse rather than an internal error.

- [ ] **Step 4: Run GREEN and build**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-agent.test.ts test/zcode-runtime.test.ts
npm run build
~~~

- [ ] **Step 5: Commit Task 6**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/agent.ts packages/aamp-acp-bridge/src/zcode-acp/runtime.ts packages/aamp-acp-bridge/test/zcode-agent.test.ts
git commit -m "feat: expose ZCode as an ACP agent"
~~~

---

## Task 7: Complete Permission, Cancel, Mode, and Model Control

**Files:**

- Modify: packages/aamp-acp-bridge/src/zcode-acp/runtime.ts
- Modify: packages/aamp-acp-bridge/src/zcode-acp/translator.ts
- Modify: packages/aamp-acp-bridge/test/zcode-runtime.test.ts
- Modify: packages/aamp-acp-bridge/test/zcode-agent.test.ts

- [ ] **Step 1: Add failing permission mapping tests**

Deliver an inbound ZCode permission request shaped as:

~~~json
{
  "requestId": "perm_1",
  "sessionId": "sess_a",
  "turnId": "turn_1",
  "toolCallId": "tool_1",
  "toolName": "write_file",
  "reason": "Modify source",
  "riskLevel": "write",
  "input": {"path":"/tmp/a.ts"},
  "options": [
    {
      "optionId": "once",
      "kind": "allow_once",
      "name": "Allow once",
      "response": {"decision":"allow","reason":"user allowed"}
    },
    {
      "optionId": "deny",
      "kind": "reject_once",
      "name": "Deny",
      "response": {"decision":"deny","reason":"user denied"}
    }
  ]
}
~~~

Assert the ACP client receives session/request_permission with the same session/tool identity and options. A selected once result must return the exact nested ZCode response object from the matching option. A cancelled ACP outcome must return:

~~~json
{"decision":"deny","reason":"ACP permission request cancelled"}
~~~

Add failures for unknown option ID, missing session, client disconnect, and a bounded permission timeout. None may default to allow.

- [ ] **Step 2: Add failing control tests**

Assert:

- two cancel notifications produce at most one session/stop for the active prompt and resolve it as cancelled;
- cancel on an idle/unknown session is harmless;
- set_mode rejects a mode outside the authoritative snapshot list, otherwise calls session/setMode and emits current_mode_update;
- set_config_option rejects IDs other than model;
- a valid encoded model calls session/setModel with providerId/modelId/variant and emits/returns the full updated config option list;
- an unknown model is rejected before session/setModel;
- model/mode requests include expectedRevision when the current snapshot supplies it.

- [ ] **Step 3: Run the focused tests and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test --test-name-pattern="permission|cancel|mode|model" test/zcode-runtime.test.ts test/zcode-agent.test.ts
~~~

Expected: at least one new assertion fails before implementation.

- [ ] **Step 4: Implement permission mediation**

Register one inbound request handler in the runtime. Handle session/requestRuntimePreferences internally. Route the permission method verified in the installed ZCode bundle, currently interaction/requestPermission, through:

~~~ts
const response = await client.request(methods.client.session.requestPermission, {
  sessionId: request.sessionId,
  toolCall: {
    toolCallId: request.toolCallId,
    title: request.reason || request.toolName,
    kind: inferToolKind(request.toolName),
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: safeInputSummary } }],
  },
  options: request.options.map(toAcpPermissionOption),
})
~~~

Use only the selected option ID to choose the ZCode response object already supplied by ZCode. Do not synthesize allow permission updates. Keep raw input out of logs; safeInputSummary must redact secret-like keys.

- [ ] **Step 5: Implement idempotent controls**

Track stopRequested on active prompt state. For setMode and setModel, validate against the last snapshot, issue the ZCode request, merge the authoritative returned snapshot, and then send the ACP update. Do not optimistically emit before confirmation.

Model is the only config option:

~~~ts
{
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: encodeModelRef(current),
  options: available.map(toAcpModelOption),
}
~~~

- [ ] **Step 6: Run GREEN and the runtime suite**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-runtime.test.ts test/zcode-agent.test.ts
npm run build
~~~

- [ ] **Step 7: Commit Task 7**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp/runtime.ts packages/aamp-acp-bridge/src/zcode-acp/translator.ts packages/aamp-acp-bridge/test/zcode-runtime.test.ts packages/aamp-acp-bridge/test/zcode-agent.test.ts
git commit -m "feat: bridge ZCode ACP controls"
~~~

---

## Task 8: Add the Executable and Prove Process Lifecycle

**Files:**

- Create: packages/aamp-acp-bridge/src/zcode-acp-cli.ts
- Create: packages/aamp-acp-bridge/test/zcode-cli.test.ts
- Modify: packages/aamp-acp-bridge/test/fixtures/fake-zcode.mjs
- Modify: packages/aamp-acp-bridge/package.json

- [ ] **Step 1: Add failing subprocess tests**

Spawn the source CLI through process.execPath plus the tsx loader, with AAMP_ZCODE_CLI_PATH set to fake-zcode.mjs. Assert:

- --version prints 0.1.29 and exits 0;
- --help names serve and the path override;
- an unknown command exits 2 with stderr only;
- serve accepts an ACP initialize request on stdin and returns valid JSON-RPC on stdout;
- no child diagnostic appears on stdout;
- split ACP input is handled by SDK framing;
- stdin EOF closes the fake child and exits 0;
- SIGTERM closes the fake child and exits within the bounded timeout;
- malformed ZCode output closes ACP with an error and leaves no child.

Use the SDK client for the normal in-process contract and raw subprocess streams only for binary/stdio lifecycle assertions.

- [ ] **Step 2: Run the CLI tests and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-cli.test.ts
~~~

Expected: FAIL because zcode-acp-cli.ts does not exist.

- [ ] **Step 3: Implement the executable**

zcode-acp-cli.ts starts with:

~~~ts
#!/usr/bin/env node

import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
~~~

Supported commands:

~~~text
aamp-zcode-acp serve
aamp-zcode-acp --version
aamp-zcode-acp --help
~~~

For serve:

1. resolve and version-check the embedded CLI;
2. construct and start ZCodeRpcClient;
3. construct ZCodeAcpRuntime;
4. construct AgentApp;
5. connect with ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
6. await connection.closed;
7. close runtime/backend once.

Install SIGINT and SIGTERM handlers that initiate the same idempotent close path. Keep process.stdout reserved for ACP. Print missing-ZCode and model-login diagnostics only to stderr.

Use package version from a small exported constant or package metadata that survives NodeNext compilation; do not read a path outside the npm tarball.

- [ ] **Step 4: Run GREEN and executable build smoke**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-cli.test.ts
npm run build
node dist/zcode-acp-cli.js --version
node dist/zcode-acp-cli.js --help
~~~

Expected: tests pass, both commands exit 0, and version output is 0.1.29.

- [ ] **Step 5: Commit Task 8**

Run:

~~~bash
git add packages/aamp-acp-bridge/src/zcode-acp-cli.ts packages/aamp-acp-bridge/test/zcode-cli.test.ts packages/aamp-acp-bridge/test/fixtures/fake-zcode.mjs packages/aamp-acp-bridge/package.json packages/aamp-acp-bridge/package-lock.json
git commit -m "feat: add ZCode ACP executable"
~~~

---

## Task 9: Wire One-step Init, Discovery, Packaging, and Documentation

**Files:**

- Create: packages/aamp-acp-bridge/test/zcode-init.test.ts
- Modify: packages/aamp-acp-bridge/src/agent-resolver.ts
- Modify: packages/aamp-acp-bridge/src/cli/init.ts
- Modify: packages/aamp-acp-bridge/src/discovery.ts
- Modify: packages/aamp-acp-bridge/src/index.ts
- Modify: packages/aamp-acp-bridge/README.md
- Modify: packages/aamp-acp-bridge/package.json
- Modify: packages/aamp-acp-bridge/package-lock.json

- [ ] **Step 1: Add failing init and clean-package tests**

Test with temporary HOME/config paths and fake-zcode.mjs:

- discoverAcpBridgeAgents returns zcode as detected/high confidence, embedded CLI version, and aamp-zcode-acp serve;
- runJsonInit with a pre-created temporary credentials file writes a ZCode agent entry with the sibling command and performs no mailbox registration;
- interactive init --agent zcode --no-start accepts non-TTY input and the existing credentials path, then persists the same command;
- missing ZCode reports both the default app path and AAMP_ZCODE_CLI_PATH;
- npm pack --json contains dist/zcode-acp-cli.js and both bin entries;
- installing the tarball in a clean temporary npm project exposes node_modules/.bin/aamp-zcode-acp and node_modules/.bin/aamp-acp-bridge;
- the installed sibling bin can complete an ACP initialize exchange against fake-zcode.mjs.

For init tests, never use real ~/.aamp, never call the live AAMP host, and never overwrite current user config. Supply an unreachable loopback health URL with a short test timeout and an existing fake credentials file.

- [ ] **Step 2: Run the init test and observe RED**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-init.test.ts
~~~

Expected: at least the tarball/bin or ZCode init assertion fails before the final wiring.

- [ ] **Step 3: Complete setup/discovery wiring**

Ensure all setup/discovery paths consume KNOWN_AGENTS and app-locator. Discovery and JSON upsert preserve every previously configured custom acpCommand, including a raw embedded ZCode CLI path. Creating a new ZCode entry, or explicitly rerunning the interactive init --agent zcode flow, writes aamp-zcode-acp serve. No background discovery path rewrites existing config.

Update index.ts help with:

~~~text
npx aamp-acp-bridge init --agent zcode
~~~

Do not add a shell alias, postinstall script, global npm install, or external adapter package.

- [ ] **Step 4: Document the user contract**

Add a ZCode section to README.md containing:

~~~bash
npx aamp-acp-bridge init --agent zcode
~~~

Document:

- macOS default /Applications/ZCode.app path;
- AAMP_ZCODE_CLI_PATH override;
- sibling aamp-zcode-acp serve command;
- official model setup command node "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" login;
- text/resource-link, sessions, streaming, tools, permission, cancel, mode/model support;
- excluded image/audio/embedded-context/additional-directory/ACP-MCP support;
- model_config_missing, missing app, protocol version mismatch, and child timeout troubleshooting;
- stdout is ACP only and logs are on stderr.

- [ ] **Step 5: Run GREEN and clean-install packaging smoke**

Run:

~~~bash
cd packages/aamp-acp-bridge
npx tsx --test test/zcode-init.test.ts
npm run build
npm pack --json
~~~

Capture the generated tarball name and install it in a dedicated temporary directory:

~~~bash
ZCODE_PACKAGE_DIR="$PWD"
ZCODE_TARBALL_NAME="$(npm pack --json | node -e 'let data=""; process.stdin.on("data", chunk => data += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(data)[0].filename))')"
ZCODE_PACK_INSTALL_DIR="$(mktemp -d -t aamp-zcode-pack.XXXXXX)"
cd "$ZCODE_PACK_INSTALL_DIR"
npm init -y
npm install "$ZCODE_PACKAGE_DIR/$ZCODE_TARBALL_NAME"
AAMP_ZCODE_CLI_PATH="$ZCODE_PACKAGE_DIR/test/fixtures/fake-zcode.mjs" ./node_modules/.bin/aamp-zcode-acp --version
~~~

Expected: install exits 0 and prints 0.1.29. Delete only the mktemp directory and generated tarball after recording the result.

- [ ] **Step 6: Commit Task 9**

Run:

~~~bash
git add packages/aamp-acp-bridge/test/zcode-init.test.ts packages/aamp-acp-bridge/src/agent-resolver.ts packages/aamp-acp-bridge/src/cli/init.ts packages/aamp-acp-bridge/src/discovery.ts packages/aamp-acp-bridge/src/index.ts packages/aamp-acp-bridge/README.md packages/aamp-acp-bridge/package.json packages/aamp-acp-bridge/package-lock.json
git commit -m "docs: add one-step ZCode ACP setup"
~~~

---

## Task 10: Full Regression and Local Installed-ZCode Smoke

**Files:**

- Modify only if a failing test identifies a defect in the files above.

- [ ] **Step 1: Run formatting and incomplete-marker guards**

Run from the worktree root:

~~~bash
git diff --check main...HEAD
rg -n "jsonrpc" packages/aamp-acp-bridge/src/zcode-acp
rg -n "console\\.log|process\\.stdout" packages/aamp-acp-bridge/src/zcode-acp packages/aamp-acp-bridge/src/zcode-acp-cli.ts
~~~

Expected:

- git diff --check exits 0;
- jsonrpc appears only in an explicit rejection message/test, never an outbound ZCode envelope;
- process.stdout appears only in the ACP stream hookup and help/version branches that do not run serve;
- no console.log exists in the adapter runtime.

- [ ] **Step 2: Run the complete package suite**

Run:

~~~bash
cd packages/aamp-acp-bridge
npm test
npm run build
~~~

Expected: every test passes and tsc exits 0.

- [ ] **Step 3: Re-run the adjacent SDK baseline**

Run:

~~~bash
cd packages/sdks/nodejs
npm test
npm run build
~~~

Expected: the existing 55-test baseline remains green and build exits 0.

- [ ] **Step 4: Run fake-child end-to-end through acpx**

From packages/aamp-acp-bridge after build:

~~~bash
AAMP_ZCODE_CLI_PATH="$PWD/test/fixtures/fake-zcode.mjs" ./node_modules/.bin/acpx --agent "node $PWD/dist/zcode-acp-cli.js serve" --approve-all --format json --json-strict --timeout 15 "reply with fake-ok"
~~~

Expected: exit 0, valid JSON lines only, one assistant fake-ok stream, and one final end_turn result.

- [ ] **Step 5: Run bounded smoke against the installed ZCode CLI**

First verify without mutation:

~~~bash
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --version
node packages/aamp-acp-bridge/dist/zcode-acp-cli.js --version
~~~

Then run ACP initialize plus session/list through an SDK smoke script or acpx sessions command using:

~~~bash
acpx --agent "node packages/aamp-acp-bridge/dist/zcode-acp-cli.js serve" sessions
~~~

Expected: adapter initialization succeeds, the ZCode child reports protocol-compatible session data, and no credentials/config/database files are changed by the adapter.

If an authenticated model is already configured, run one harmless prompt in the worktree with --deny-all and a 30-second timeout. If the current model_config_missing condition remains, assert the adapter returns an actionable official login command and record the prompt smoke as auth-blocked rather than signing in or copying Desktop credentials.

- [ ] **Step 6: Inspect final scope and package contents**

Run:

~~~bash
git status --short
git diff --stat main...HEAD
git diff --name-only main...HEAD
cd packages/aamp-acp-bridge
npm pack --dry-run
~~~

Expected: only the documented spec/plan plus packages/aamp-acp-bridge files are changed; both binaries and all required runtime modules are present in the tarball; no test fixture, credentials, local config, SQLite file, or generated tgz is staged.

- [ ] **Step 7: Request code review and apply only verified findings**

Use superpowers:requesting-code-review. Check protocol correctness, lifecycle cleanup, secret redaction, replay ordering, multi-session isolation, permission default-deny behavior, and package installability. For every accepted finding, add a reproducing failing test before the fix and rerun the affected suite.

- [ ] **Step 8: Final verification commit if review changed code**

When review fixes exist:

~~~bash
git add packages/aamp-acp-bridge
git commit -m "fix: harden ZCode ACP integration"
~~~

When no review fix is needed, do not create an empty commit.

The branch is complete only after npm test, both builds, fake-child acpx end-to-end, clean tarball install, and the bounded installed-ZCode smoke have fresh evidence.
