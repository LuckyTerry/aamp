# TraeCLI Native ACP Support Design

Status: design approved on 2026-08-10; implementation has not started.

## Summary

Add Trae 2.0 as the canonical `trae` agent in `aamp-acp-bridge`. The bridge
will discover either `traecli` or `traex`, start the detected executable's
native ACP server, and reuse the bridge's existing ACP session and streaming
pipeline. `aamp-cli-bridge` and its existing `coco` profile remain unchanged.

The generated ACP command is one of:

```text
traecli acp serve
traex acp serve
```

The bridge will not parse Trae's private CLI JSONL format and will not silently
fall back to Coco.

## Context and feasibility evidence

The current ACP bridge already supports raw ACP commands. An `acpCommand` that
contains whitespace is passed to `acpx` through `--agent`, while normal agent
names use an `acpx` built-in subcommand. The existing Hermes integration uses
the same raw-command mechanism with `hermes acp`.

The locally installed Trae 2.0 client exposes the required native server on
both executable names:

```text
traecli 0.200.19(internal edition)
traecli acp serve
traex acp serve
```

A pre-design smoke test completed an ACP initialize, streamed multiple
`agent_message_chunk` events, returned a final `result`, and closed the
session successfully through `acpx --agent "traecli acp serve"`. This proves
the native ACP boundary is viable; it is not by itself an end-to-end AAMP task
sign-off.

## Goals

- Make `trae` a known ACP bridge agent in interactive and JSON discovery.
- Detect `traecli` first and use `traex` as a compatible executable fallback.
- Preserve standard ACP session reuse, cancellation, streaming, and final
  result handling.
- Preserve explicit and previously configured `acpCommand` values.
- Produce clear diagnostics when neither executable is available.
- Add deterministic automated coverage that does not depend on a developer's
  installed Trae binary.

## Non-goals

- Do not add a Trae 2.0 profile to `aamp-cli-bridge`.
- Do not change or remove the existing `coco` CLI profile.
- Do not implement a Trae-specific JSONL parser.
- Do not add a fallback from Trae 2.0 to Coco.
- Do not change the ACP bridge's global permission policy or AAMP stream
  schema.
- Do not add a package version bump or release automation in this change.

## User-visible behavior

The stable AAMP identity is `trae`; executable aliases are an installation
detail.

| Local state | Discovery result | Generated `acpCommand` |
| --- | --- | --- |
| Both executables installed | detected via `traecli` | `traecli acp serve` |
| Only `traecli` installed | detected via `traecli` | `traecli acp serve` |
| Only `traex` installed | detected via `traex` | `traex acp serve` |
| Neither installed | not detected, with a warning | `traecli acp serve` as the documented default |
| Existing `acpCommand` present | retain the existing value | unchanged |
| Explicit JSON-init `acpCommand` supplied | use the requested value | unchanged |

The missing-binary warning will identify both accepted aliases:

```text
traecli or traex was not found on PATH.
```

Detection is deterministic and does not probe the second executable after the
selected command starts. If `traecli` exists but its ACP server fails, the
bridge reports that failure instead of hiding it by retrying with `traex`.

## Architecture and data flow

```text
task.dispatch
  -> aamp-acp-bridge
  -> AcpxClient
  -> acpx --agent "<detected executable> acp serve"
  -> Trae native ACP server over stdio
  <- ACP session updates and final result
  -> existing AAMP task stream
  -> task.result or task.help_needed
```

No Trae-specific runtime adapter is introduced. Once the resolver returns the
raw ACP command, all later processing follows the existing `AcpxClient` and
`AgentBridge` paths.

## Component design

### Known-agent registry and resolver

`agent-resolver.ts` will own the known-agent name list so interactive init and
JSON discovery cannot drift apart. Both current duplicated lists will consume
that shared value.

Trae resolution uses ordered executable candidates:

```text
trae -> [traecli, traex]
```

For the first candidate found on `PATH`, the resolver returns:

- `command`: the selected executable name;
- `acpCommand`: `<command> acp serve`;
- `version`: the first line of `<command> --version`, using the existing
  `installed` fallback when version detection fails.

All other agents keep their current resolution behavior. Hermes continues to
use `hermes acp`, and the macOS Codex application fallback remains unchanged.

For `trae`, an existing non-empty `acpCommand` remains authoritative. This
includes customized commands with model, tool, sandbox, or `--yolo` options.
When no previous or explicit value exists, current detection selects the
generated command; if detection fails, the canonical default is
`traecli acp serve`.

### Interactive init and JSON discovery

Interactive `init --agent trae` recognizes `trae` as a known name. It only
offers or initializes Trae when one of its executable aliases is detected,
matching current behavior for other known agents.

`discover --json` always includes one canonical `trae` candidate. It reports:

- `id` and `displayName` as `trae`;
- the selected alias in `command` when detected, or the canonical executable
  hint `traecli` when neither alias is installed;
- the resolved or previously configured raw command in `acpCommand`;
- `detected: false` and the two-alias warning when neither command exists.

JSON init remains an upsert operation. An explicit input command wins, then an
existing configured command, then automatic detection, then the canonical
default. Existing credentials, mailbox identity, pairing state, and sender
policies are not migrated or rewritten by this feature.

### ACP runtime and streaming

The raw command contains whitespace, so the existing client invokes it as one
`--agent` argument rather than as an `acpx` built-in agent alias. This avoids a
dependency on whether a particular `acpx` release includes its own `trae`
mapping and supports both executable names.

Existing ACP-to-AAMP behavior is reused:

| ACP update | Existing AAMP behavior |
| --- | --- |
| `agent_message_chunk` | buffered realtime `text.delta` events |
| `agent_thought_chunk` | phase marker plus realtime `text.delta` events |
| `tool_call` / `tool_call_update` | `tool_call` events |
| `plan` | `todo` events |
| final `result` | parsed into `task.result` or `task.help_needed` |

ACP `usage_update` events remain available inside the ACP event stream but are
not added to the AAMP task stream because the current AAMP stream schema has no
usage event type. Adding that schema is outside this change.

Session creation, task-derived session names, cancellation, attachment
materialization, result parsing, and text-mode fallback for older `acpx`
versions require no Trae-specific changes.

### Authentication and permissions

Trae authentication remains owned by TraeCLI. Users complete login with the
Trae client; AAMP neither reads nor stores Trae credentials. Authentication or
ACP initialization failures follow the bridge's existing error path.

The generated command deliberately omits `--yolo`. The ACP bridge currently
passes `acpx --approve-all`, which auto-approves ACP permission requests, but
that does not itself disable Trae's sandbox. Adding Trae's `--yolo` would also
disable sandboxing and is therefore not a safe default. Advanced users may set
an explicit command such as `traecli acp serve --yolo`; documentation will
label that mode as dangerous.

## Error handling

| Failure | Required behavior |
| --- | --- |
| Neither executable is on `PATH` | discovery returns the explicit two-alias warning; interactive init reports Trae as not installed |
| `--version` fails | detection still succeeds with version `installed` |
| ACP process cannot start | preserve the existing formatted `acpx` command error |
| Trae is not authenticated | surface the ACP initialization/authentication failure; do not read, create, or rewrite Trae credentials; normal AAMP mailbox credentials remain under bridge init ownership |
| ACP stream is unsupported by an older `acpx` | preserve the existing plain-text compatibility fallback |
| A task is cancelled | preserve the current process cancellation and late-result suppression |
| Existing custom command is invalid | report its failure; do not replace it silently |

## Documentation changes

- Add Trae to the known-agent list in `packages/aamp-acp-bridge/README.md`.
- Document canonical name `trae`, alias order, generated ACP commands, login
  ownership, and the reason `--yolo` is omitted.
- Add `trae` to `docs/AGENT_SETUP.md` as an ACP-first agent.
- Keep `coco` in the CLI profile table and state that it is a separate profile,
  not an automatic fallback or migration target.

## Test strategy

### Automated tests

Add a package test script using Node's test runner through `tsx`. Tests will
use temporary executable fixtures and a controlled `PATH`; they must not
depend on a real Trae installation, login state, network access, or files under
the user's AAMP configuration directory.

Resolver coverage:

1. Both aliases present selects `traecli`.
2. Only `traecli` present selects `traecli acp serve`.
3. Only `traex` present selects `traex acp serve`.
4. Neither present returns no resolution and the two-alias warning.
5. Version is read from the selected executable.
6. The canonical default is `traecli acp serve` when nothing is detected.
7. A previous customized `acpCommand`, including one with `--yolo`, is
   preserved.
8. Existing Hermes, Codex, and generic-agent resolution behavior is unchanged.

Discovery coverage:

1. `trae` appears exactly once in known candidates.
2. Detected output exposes canonical ID `trae`, selected `command`, exact raw
   `acpCommand`, high confidence, and no warning.
3. Missing output uses `command: traecli`, has low confidence, and includes the
   explicit two-alias warning.
4. An existing configured command remains in discovery output.

Required local verification commands:

```bash
cd packages/sdks/nodejs
npm ci
npm test
npm run build

cd ../../aamp-acp-bridge
npm ci
npm test
npm run build
```

### Native ACP smoke test

On a machine with an authenticated TraeCLI, use an isolated empty directory
and a disposable session name to verify:

1. session ensure succeeds with the raw command;
2. a strict JSON prompt emits incremental assistant chunks;
3. the final result contains the requested sentinel response;
4. session close succeeds;
5. the smoke directory remains unchanged.

The smoke command must omit `--yolo` and must instruct the agent not to call
tools or modify files.

### AAMP end-to-end verification

Full sign-off requires a controlled AAMP bridge instance to receive one test
`task.dispatch`, emit at least one realtime text event, and send the matching
authoritative final result. If an authorized mailbox and sender are not
available, implementation can be reported as unit/build/ACP-smoke verified,
but not as end-to-end AAMP verified. Automated tests must never register a
production mailbox.

## Expected file impact

| File | Change |
| --- | --- |
| `packages/aamp-acp-bridge/src/agent-resolver.ts` | shared known-agent registry and Trae alias resolution |
| `packages/aamp-acp-bridge/src/discovery.ts` | consume shared registry and expose Trae fallback command cleanly |
| `packages/aamp-acp-bridge/src/cli/init.ts` | consume shared registry so `init --agent trae` is accepted |
| `packages/aamp-acp-bridge/test/agent-resolver.test.ts` | deterministic resolver coverage |
| `packages/aamp-acp-bridge/test/discovery.test.ts` | discovery/config preservation coverage |
| `packages/aamp-acp-bridge/package.json` | add the package test script |
| `packages/aamp-acp-bridge/README.md` | Trae setup and safety documentation |
| `docs/AGENT_SETUP.md` | recommend ACP bridge for Trae 2.0 |

No changes are expected under `packages/aamp-cli-bridge`.

## Acceptance criteria

- The branch remains based on the approved `main` commit.
- `discover --json` and interactive init recognize canonical agent `trae`.
- `traecli` is preferred and `traex` works when it is the only alias present.
- Generated commands start native ACP with `acp serve` and omit `--yolo`.
- Existing explicit commands and bridge state remain intact.
- Text, thought, tool, plan, cancellation, and final-result paths use the
  existing standardized ACP implementation without a Trae parser.
- Missing binaries and ACP/authentication failures are explicit and do not
  trigger a Coco fallback.
- New automated tests, existing SDK tests, and TypeScript builds pass.
- Native ACP smoke verification passes; AAMP end-to-end status is reported
  separately and is only claimed when a real controlled task completes.
