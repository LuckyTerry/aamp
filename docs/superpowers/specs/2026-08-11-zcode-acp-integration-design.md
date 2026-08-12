# ZCode ACP Integration Design

- **Date:** 2026-08-11
- **Status:** Approved
- **Scope:** `packages/aamp-acp-bridge`
- **Target platform:** macOS, ZCode installed as `/Applications/ZCode.app`

## Summary

ZCode 3.7.5 ships a stdio `app-server`, but that server speaks ZCode Protocol v1 rather than Agent Client Protocol (ACP). A direct ACP handshake therefore fails. This change adds a ZCode-to-ACP adapter to the existing `aamp-acp-bridge` npm package and makes ZCode available through the existing one-step setup flow:

```bash
npx aamp-acp-bridge init --agent zcode
```

The package will expose a second executable, `aamp-zcode-acp`. The setup command detects the installed ZCode application and persists `aamp-zcode-acp serve` as the agent's ACP command. The bridge continues to use `acpx` as its ACP client, while the new executable translates standard ACP requests and events to and from ZCode Protocol v1.

The adapter launches ZCode's official `app-server`. It does not patch ZCode, write its SQLite databases, or depend on undocumented database layouts. Model access remains owned by the ZCode CLI: an unconfigured CLI receives an actionable instruction to run the official `zcode login` flow.

## Goals

- Make the installed macOS ZCode application usable as a standard ACP agent from AAMP/acpx.
- Preserve the existing one-command onboarding experience without requiring a separately installed adapter package.
- Support the ACP features needed for real AAMP task execution:
  - initialization;
  - new, resumed, listed, and closed sessions;
  - streamed assistant text and reasoning;
  - tool-call lifecycle updates;
  - permission requests;
  - cancellation;
  - mode and model switching;
  - plan and usage updates;
  - structured error propagation.
- Reject incompatible ZCode protocol versions explicitly instead of silently guessing.
- Keep all existing agent integrations unchanged.

## Non-goals

- Supporting Windows or Linux ZCode installations in the first release.
- Making sessions appear in ZCode Desktop's task list as an acceptance requirement.
- Writing ZCode's task index, CLI session database, or other private persistence directly.
- Implementing every optional ACP extension in the first release.
- Advertising ACP image, audio, embedded-resource, or ACP-transport MCP capabilities before they are implemented and tested.
- Replacing `acpx` inside the AAMP bridge.

## Confirmed Local Compatibility Baseline

The target machine currently has:

- `/Applications/ZCode.app`, application version 3.7.5, build 3.7.5.4641;
- embedded CLI `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, CLI version 0.16.1;
- `zcode.cjs app-server`, described by the CLI as the ZCode Protocol stdio app server;
- ZCode Protocol v1 methods such as `session/create`, `session/resume`, `session/send`, `session/stop`, `session/setMode`, and `session/setModel`;
- `acpx` 0.11.2 with `@agentclientprotocol/sdk` 0.28.x semantics.

The current ZCode CLI has no explicit model provider in `~/.zcode/cli/config.json`; a non-persistent session probe returns `model_config_missing`. This does not change adapter installation, but it means the live prompt smoke test requires the user to complete ZCode's official `zcode login` flow first. The adapter must surface that condition without attempting to copy credentials from ZCode Desktop.

An isolated direct `acpx` probe produced an unknown-request response and timed out because ACP sends methods such as `initialize` and `session/new`, while the current ZCode server expects its own method names and payloads. ZCode's installed migration plugin also refers to old “ACP-era” snapshots, which is consistent with the current runtime having moved to a different protocol.

## Package and Process Architecture

Only `packages/aamp-acp-bridge` is changed. The package gains an official `@agentclientprotocol/sdk` runtime dependency and exposes two npm binaries:

```json
{
  "bin": {
    "aamp-acp-bridge": "dist/index.js",
    "aamp-zcode-acp": "dist/zcode-acp-cli.js"
  }
}
```

The processes are arranged as follows:

```text
AAMP bridge
    |
    | starts acpx with --agent "aamp-zcode-acp serve"
    v
acpx (ACP client)
    |
    | ACP JSON-RPC over stdio
    v
aamp-zcode-acp (ACP agent / protocol translator)
    |
    | ZCode Protocol v1 over NDJSON stdio
    v
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server
```

One adapter process owns one ZCode `app-server` child process. That child may serve multiple sessions. Request IDs, session state, prompt completion, cancellation, and streamed events are correlated inside the adapter so that updates cannot leak between sessions.

The proposed internal modules are:

- `src/zcode-acp/app-locator.ts`: locate and validate the embedded ZCode CLI and query its version;
- `src/zcode-acp/protocol.ts`: minimal typed and runtime-validated ZCode Protocol v1 messages used by the adapter;
- `src/zcode-acp/rpc-client.ts`: child lifecycle, NDJSON framing, request correlation, inbound requests, timeouts, and cleanup;
- `src/zcode-acp/translator.ts`: ACP content, MCP, session metadata, tool, plan, usage, and error conversion;
- `src/zcode-acp/agent.ts`: ACP SDK handlers and per-session prompt state;
- `src/zcode-acp-cli.ts`: the `aamp-zcode-acp serve` executable;
- `src/known-agents.ts`: a shared agent catalog used by setup and discovery, eliminating the current duplicated lists.

Exact file boundaries may be combined when implementation shows that a smaller module is clearer, but protocol transport, translation, and ACP handler responsibilities remain separated and independently testable.

## ZCode Discovery and One-step Setup

`zcode` is added to the shared known-agent catalog. On macOS, discovery checks the following source in order:

1. `AAMP_ZCODE_CLI_PATH`, when explicitly set;
2. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`.

The override is owned by the adapter rather than ZCode, so it is deliberately prefixed `AAMP_`. The resolved target must be a readable regular file. The adapter launches it with `process.execPath` and an argument array, never via a shell-interpolated command.

Detection runs the embedded CLI's `--version` command with a bounded timeout. A successful result produces an agent resolution equivalent to:

```json
{
  "name": "zcode",
  "command": "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  "acpCommand": "aamp-zcode-acp serve",
  "version": "0.16.1"
}
```

`npx aamp-acp-bridge init --agent zcode` then follows the existing mailbox registration, pairing, and config-writing flow. No separate adapter installation and no shell startup-file change are required. When `aamp-acp-bridge` itself is run through npm/npx, npm places all package bins on `PATH`, allowing `acpx` to start the sibling `aamp-zcode-acp` executable. A clean tarball-install smoke test verifies this packaging assumption.

If ZCode is not found, the error lists the default path and the `AAMP_ZCODE_CLI_PATH` override. Discovery and setup must not report ZCode as available merely because the `.app` directory exists; the embedded CLI itself must pass validation.

## ACP Capability Contract

The adapter uses `@agentclientprotocol/sdk` to serve ACP. It does not handcraft ACP framing or validation.

The initial capability response advertises only implemented behavior. In ACP 0.28 terms, it sets `loadSession: true` and provides `sessionCapabilities.list`, `sessionCapabilities.resume`, and `sessionCapabilities.close`. It does not advertise session delete or additional directories.

The remaining advertised behavior is:

- session load, resume, list, and close support;
- text prompts and resource links;
- session modes;
- a model configuration option;
- streamed session updates used by AAMP/acpx.

It does not advertise image, audio, embedded-resource, or ACP-transport MCP support. If a client sends one of those inputs despite the capability response, the request fails before reaching ZCode with a descriptive unsupported-content error.

## Request Mapping

### Initialize

ACP `initialize` returns the protocol version negotiated by the ACP SDK, adapter metadata, and the capabilities above. Starting the adapter launches the ZCode child, but protocol compatibility is accepted only after a ZCode response includes:

```json
{
  "protocol": {
    "name": "ZCode Protocol",
    "version": 1
  }
}
```

A missing or different marker causes an unsupported-version error that includes the detected ZCode CLI version.

### New session

ACP `session/new` maps to ZCode `session/create`:

- ACP `cwd` becomes the ZCode workspace root and must be absolute;
- supported ACP MCP server entries become ZCode `mcpServers`;
- requested/default mode and model are forwarded when present;
- the returned ZCode `sess_*` identifier is returned unchanged as the ACP session ID;
- ZCode's available modes and models are converted into ACP modes and config options.

The first release does not advertise ACP `additionalDirectories`, because the confirmed ZCode `session/create` contract exposes one workspace object and no independently verified additional-root equivalent. A non-empty `additionalDirectories` request is rejected rather than silently collapsed into the primary workspace.

### Load, resume, list, and close

- ACP `session/load` maps to ZCode `session/resume`, followed by `session/read` and/or `session/messages`. Before returning, the adapter replays the complete available conversation history as ordered ACP session updates, as required by ACP load semantics.
- ACP `session/resume` maps to ZCode `session/resume` and returns current session metadata without replaying prior messages.
- ACP `session/list` maps to ZCode `session/list` and translates pagination metadata when present.
- ACP `session/close` maps to ZCode `session/close` and clears local per-session state.

Existing history remains ZCode-owned. Load replay converts stored user, assistant, thought, and tool content without writing it back to ZCode; live-event subscriptions are attached at a revision boundary so the replay and subsequent stream cannot duplicate the same event.

### Prompt

ACP `session/prompt` maps to ZCode `session/send`.

- ACP text blocks retain their order.
- ACP resource links are represented as explicit URI references in the ZCode content rather than fetched by the adapter.
- Unsupported content types fail atomically before any part of the prompt is sent.
- At most one foreground prompt may run per session. Other sessions may run concurrently.
- Prompt completion is correlated by session and ZCode input/turn identifiers, not by assuming that the next global completion event belongs to the caller.

The prompt resolves only when the corresponding ZCode turn completes, fails, or is cancelled.

### Cancel, mode, and model

- ACP `session/cancel` maps to ZCode `session/stop` for the active turn in that session. Cancellation is idempotent.
- ACP `session/set_mode` maps to ZCode `session/setMode` and emits a current-mode update after confirmation.
- ACP `session/set_config_option` with the `model` option maps to ZCode `session/setModel`. ACP 0.28 has no separate model-switch method, so model selection is deliberately represented as a standard session config option.

Unknown modes, models, or config-option IDs are rejected before mutation when the current ZCode snapshot provides an authoritative option list.

### MCP servers

ACP stdio, HTTP, and SSE MCP server definitions are converted into the closest ZCode `mcpServers` representation while preserving command arguments, environment variables, headers, and URLs. Secrets are passed through in memory but are never logged.

ACP-transport MCP entries are rejected in the first release and are not advertised.

## Event Mapping

ZCode events are translated into ACP `session/update` notifications:

| ZCode event or state | ACP update |
| --- | --- |
| assistant text delta from `model.streaming` or text `part.delta` | `agent_message_chunk` |
| reasoning/thought delta | `agent_thought_chunk` |
| `tool.updated` scheduled/started | `tool_call` |
| `tool.updated` progress/result/error | `tool_call_update` |
| todo/plan projection changes | `plan` |
| usage/projection token changes | `usage_update` |
| confirmed mode change | `current_mode_update` |
| confirmed model change | `config_option_update` |
| title or session metadata change | `session_info_update` |
| `turn.completed` | prompt result with `end_turn` |
| stopped/cancelled turn | prompt result with `cancelled` |
| `turn.failed` | structured ACP request error |

The translator maintains the last observed revision and event identity per session. Duplicate snapshots or repeated deltas do not produce duplicate ACP text or tool transitions. Unknown forward-compatible notification fields are ignored; malformed messages that affect request completion fail the affected request with protocol context.

## Permission Flow

ZCode may send a server-to-client `interaction/requestPermission` request envelope. The adapter:

1. finds the owning ACP session and tool call;
2. converts ZCode's permission choices into ACP permission options;
3. calls the ACP client's `session/request_permission` method;
4. maps the selected option or cancellation back to the exact ZCode reply shape;
5. keeps the ZCode request pending until the ACP client answers or the bounded timeout expires.

The current AAMP invocation uses acpx's approve-all mode, so its behavior remains automatic. Other ACP clients can present the choice to a user. The adapter itself never silently approves a permission request.

## Transport and Lifecycle

Both stdio links use newline-delimited JSON with incremental buffering, so split and coalesced stream chunks are handled correctly. The ACP side uses JSON-RPC 2.0; ZCode Protocol v1 uses strict `{id, method, params}`, `{id, result}`, `{id, error}`, and `{method, params}` envelopes without a `jsonrpc` field. ACP protocol output is the only content written to adapter stdout. Diagnostics go to stderr.

The ZCode RPC client maintains:

- a monotonically unique request ID source;
- a pending-request map with bounded timeouts;
- an inbound-request dispatcher for permission interactions;
- per-session active-prompt state;
- a bounded stderr tail for actionable child failures.

On `SIGINT`, `SIGTERM`, ACP EOF, or unrecoverable framing failure, the adapter:

1. stops accepting prompts;
2. rejects pending operations with a stable shutdown error;
3. requests cancellation for active turns when possible;
4. closes the ZCode child stdin;
5. sends `SIGTERM` to the child process group and performs a bounded forced cleanup only if it does not exit.

If the ZCode child exits unexpectedly, every affected ACP request fails once with the exit code and a redacted stderr tail. The adapter does not auto-restart mid-session because doing so could make session and prompt ownership ambiguous.

## Error and Security Behavior

- ZCode-not-found errors name the searched path and override variable.
- ZCode `model_config_missing` errors explain that CLI model access is separate from the adapter and show the official `<embedded-cli> login` command.
- Unsupported protocol errors include the expected and received protocol identifiers.
- Timeout errors name the operation and session but do not include prompt contents.
- Invalid JSON is reported with line/framing context, with payload bodies omitted from normal logs.
- Child stderr is capped to prevent unbounded memory growth.
- Prompt text, authentication material, MCP headers/environment secrets, permission context, and ZCode database contents are never logged.
- The adapter does not use a shell to launch the embedded CLI.
- Existing ZCode authentication and persistence are used only through the official app-server process.

## Compatibility and Migration

Existing bridge configurations and known agents remain valid. `zcode` is additive. Consolidating the duplicated known-agent list must preserve its existing order and values, apart from appending ZCode.

The package version will be bumped according to the repository's normal release convention when the implementation is ready. No automatic rewriting of existing agent entries occurs. A user who already created a custom ZCode entry may keep it; explicitly running `init --agent zcode` produces the new standard command.

## Test Strategy

Implementation follows test-driven development. Each behavior is first represented by a failing test.

### Unit tests

- default and overridden application discovery;
- executable/readability validation and version failures;
- ACP-to-ZCode prompt, mode, model, MCP, and session request conversion;
- ZCode-to-ACP text, thought, tool, plan, usage, metadata, and completion conversion;
- unsupported content and transport rejection;
- unsupported additional-directory rejection;
- permission choice round trips;
- duplicate-event suppression and cross-session isolation;
- error redaction.

### Protocol integration tests

A deterministic fake ZCode Protocol v1 server is spawned as a real child process. Tests exercise:

- split/coalesced NDJSON framing;
- request correlation and out-of-order responses;
- initialize, create, load-with-replay, resume-without-replay, list, prompt, cancel, mode/model, and close flows;
- concurrent sessions;
- permission callbacks;
- malformed JSON, incompatible protocol markers, timeout, and unexpected child exit;
- graceful cleanup with no leftover child process.

The adapter itself is then exercised through the official ACP SDK or acpx so that tests validate the external wire contract rather than only calling internal translator functions.

### Packaging tests

`npm pack` is installed into a temporary project. The test verifies that:

- both binaries are linked;
- `aamp-zcode-acp --help` succeeds;
- `aamp-zcode-acp serve` can start against the fake ZCode server via `AAMP_ZCODE_CLI_PATH`;
- `aamp-acp-bridge` retains its existing entry point;
- package contents include all required runtime files.

### Setup and local smoke tests

- Run `init --agent zcode` with temporary AAMP config/credential locations and controlled service responses, then verify `acpCommand: "aamp-zcode-acp serve"` without modifying the user's current AAMP configuration.
- Connect acpx through the packaged adapter to the installed ZCode app and verify ACP initialization and session creation in an isolated temporary ZCode home where supported.
- If ZCode CLI model access has been configured through its official login flow, run one minimal prompt round trip. Otherwise verify the actionable `model_config_missing` propagation and report the live prompt as blocked by ZCode CLI configuration; deterministic fake-server coverage remains required and cannot be replaced by a startup-only check.

## Acceptance Criteria

The integration is complete when all of the following are true:

1. `npx aamp-acp-bridge init --agent zcode` detects the installed macOS ZCode and writes the standard adapter command.
2. A clean package installation exposes both expected binaries.
3. acpx can initialize the adapter, create or resume a session, send a prompt, receive streamed text/tool updates, and obtain the final stop reason.
4. Permission requests and cancellation complete in both directions without hanging either protocol.
5. Mode and model changes are visible through ACP and applied through ZCode Protocol.
6. Multiple sessions do not exchange events or completion state.
7. ZCode absence, protocol incompatibility, timeout, malformed data, and child crashes produce actionable errors and no orphaned processes.
8. Existing ACP bridge behavior builds and its regression tests pass.
9. No test or implementation writes directly to ZCode's databases or modifies the user's shell startup files.

## Rollout and Maintenance

The first release is explicitly tied to ZCode Protocol v1 and macOS app-bundle discovery. Future platform locators can be added behind `app-locator.ts` without changing ACP behavior. Future ZCode protocol versions require a new validated translator path; the v1 guard must not be relaxed merely to suppress compatibility errors.

Any optional ACP capability added later must be advertised only after its conversion and failure semantics have deterministic coverage.
