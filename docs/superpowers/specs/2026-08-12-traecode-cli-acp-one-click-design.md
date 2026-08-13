# TraeCode CLI ACP One-click Integration Design

Status: approved section by section on 2026-08-12; implementation has not started.

## Summary

Extend the Feishu Task one-click flow and `aamp-acp-bridge` with the external
Trae distribution, whose executable is `traecli` and whose user-facing name is
**TraeCode CLI**. TraeCode CLI uses its native ACP server:

```text
traecli acp serve
```

This work keeps the internal and external Trae distributions as separate
canonical agent identities. Automatic discovery prefers internal Trae CLI Next
(`traex`), then internal Trae CLI/Coco (`coco`), and only treats `traecli` as
TraeCode CLI when no `coco` executable is present. An older TraeCode CLI that
does not expose ACP is offered an explicit `traecli update`; it never falls back
to `aamp-cli-bridge`.

## Background

Three command surfaces can exist on a developer machine:

| Distribution | Generation | Executable | User-facing name |
| --- | --- | --- | --- |
| Internal | 1.0 / Coco | `coco`, sometimes with a `traecli` alias | Trae CLI（内部版） |
| Internal | 2.0 | `traex` | Trae CLI Next（内部版） |
| External | TraeCode CLI | `traecli` | TraeCode CLI |

The current branch already supports internal `traex` through native ACP and
retains a compatibility flow for Coco. It currently groups `traecli` with the
legacy Coco commands, so a machine with only the external distribution is
misclassified and directed into the internal upgrade flow.

Local feasibility evidence from TraeCode CLI `0.120.52` shows:

- `traecli acp serve --help` exposes a native ACP server;
- `traecli doctor --json` is fast and non-interactive and returns structured
  readiness checks;
- `traecli login`, `traecli login status`, and non-interactive `/status`
  invocations are not reliable login APIs and may enter or emulate the TUI;
- an unknown command with `--help` may print root help and exit zero, so ACP
  capability detection cannot rely on exit status alone.

These observations establish a viable ACP path, but they are not an end-to-end
Feishu Task acceptance result.

## Goals

1. Add TraeCode CLI as canonical agent type `traecli` in
   `aamp-acp-bridge` and `aamp-feishu-task-agent`.
2. Distinguish internal Coco from external TraeCode CLI with deterministic
   discovery and stable persisted identities.
3. Route Trae CLI Next and TraeCode CLI directly through native ACP.
4. Offer a consented `traecli update` when an installed external client is too
   old to expose ACP, then revalidate the upgraded executable.
5. Use `traecli doctor --json` as a bounded readiness check without invoking
   interactive login/status commands.
6. Preserve existing ready bindings and make every start, failure, and success
   message show the actual resolved product name.
7. Cover discovery, upgrade, readiness, persistence, and ACP streaming with
   deterministic tests plus a real Feishu Task smoke test.

## Non-goals

- Do not route TraeCode CLI through `aamp-cli-bridge`.
- Do not rename or modify the existing `coco` CLI Bridge profile.
- Do not automate input inside the TraeCode CLI TUI.
- Do not read, persist, or infer authentication tokens.
- Do not silently update TraeCode CLI without user confirmation.
- Do not migrate already-ready historical bindings merely to make stored names
  uniform.
- Do not expand the one-click launcher to native Windows in this change.
- Do not bump package versions or publish npm packages as part of the
  implementation commit.

## Canonical identities and labels

The stored agent type represents a product identity, not merely an executable
alias:

| Canonical `agent_type` | Meaning | Runtime command | Display name |
| --- | --- | --- | --- |
| `traex` | Internal Trae CLI 2.0 | `traex acp serve` | Trae CLI Next（内部版） |
| `trae` | Historical/internal Coco compatibility identity | resolved at preparation time | Trae CLI（内部版） when Coco is detected; otherwise Trae CLI（兼容配置） until resolved |
| `traecli` | External Trae distribution | `traecli acp serve` | TraeCode CLI |

`coco` remains an executable name, not a new stored Task Agent type. A pending
Coco binding that successfully upgrades is normalized to `traex` before it is
made ready.

## Discovery and selection

### Automatic discovery

The launcher exposes at most one Trae-family choice, using this strict order:

1. If `traex` is executable, expose `traex`.
2. Otherwise, if `coco` is executable, expose `trae` as Trae CLI（内部版）.
   A simultaneous `traecli` is treated as Coco's possible alias and is not
   exposed separately.
3. Otherwise, if `traecli` is executable, expose `traecli` as TraeCode CLI.
4. Otherwise, expose no Trae-family choice.

Discovery performs only executable resolution. It must not run login, update,
doctor, or ACP server commands.

### Explicit and saved selection

`--agent traex`, `--agent trae`, and `--agent traecli` are distinct requests.
A saved `traecli` binding continues to request TraeCode CLI even if `traex` is
installed later; it must not silently change products. Likewise, explicit
`traecli` never falls back to `coco` or `traex`.

Because the name `traecli` may also be an internal Coco alias, exact selection
must avoid knowingly running that alias as TraeCode CLI. If `coco` and
`traecli` resolve to the same real executable during an explicit/saved
TraeCode preparation, preparation fails with a conflict message instead of
misclassifying the internal client. A distinct explicitly selected `traecli`
path remains eligible.

Path override variables must be identity-aware. A `traex` override is accepted
only for `traex`; a `coco` override only for the legacy internal flow; and a
TraeCode override only for `traecli`. A generic override must not make one
identity silently resolve to another.

### Historical `trae` bindings

Historical ready bindings remain stored as `trae` to preserve mailbox and
pairing state. Each start resolves their runtime in this order:

```text
traex -> coco -> external traecli
```

- `traex` is reused directly and displayed as Trae CLI Next（内部版）.
- `coco` enters the internal upgrade/cancellation flow; it is never launched as
  ACP.
- an otherwise-unambiguous external `traecli` enters the TraeCode flow.

New or still-pending `trae` bindings are normalized to the resolved `traex` or
`traecli` identity before becoming ready. Ready historical records are not
rewritten; runtime labels and errors use the resolved identity.

## Component responsibilities

### `aamp-acp-bridge`

The ACP Bridge adds `traecli` to its known-agent registry and maps it to:

```text
traecli acp serve
```

Its resolver, discovery output, JSON init, default command generation, and
missing-command warning use the canonical `traecli` identity. Explicit
nonblank `acpCommand` values remain authoritative, matching the existing
configuration contract.

The ACP Bridge does not distinguish internal versus external distributions,
prompt for upgrades, or run `doctor`. Those are one-click product-preparation
concerns. Direct ACP Bridge users who choose `--agent traecli` are explicitly
requesting that executable.

### `aamp-feishu-task-agent`

The Task Agent owns:

- distribution-aware discovery and display labels;
- the `traecli` controller allowlist and binding persistence;
- internal Coco-to-Traex upgrade behavior;
- TraeCode ACP capability detection and optional update;
- TraeCode structured readiness checks;
- construction of the exact resolved ACP command passed to ACP Bridge;
- normalization of pending bindings and runtime labels for ready compatibility
  bindings.

The internal preparation response continues to return `agent_type` and
`acp_command`; it returns the actual resolved type so the controller can use
the correct runtime group, lease, identity, failure, and display label.

### `aamp-cli-bridge`

No change. Its existing Coco profile remains available to direct CLI Bridge
users, but the Feishu Task Agent neither renames it nor uses it for TraeCode
CLI.

## TraeCode preparation flow

### 1. Resolve an exact executable

Resolve `traecli` once for the requested external identity and retain that
exact executable for the capability probe and, if needed, the update command.
Do not substitute `coco` or `traex`.

### 2. Probe native ACP capability

Run the equivalent of:

```text
<resolved-traecli> acp serve --help
```

The probe is non-interactive, has a short configurable timeout, and captures
bounded output. Exit code zero alone is insufficient: the client can print its
root help and return zero for unknown subcommands. The output must contain
ACP-serve-specific usage and description markers, such as an `acp serve` usage
line plus the ACP server description, rather than only listing `acp` among the
root commands.

### 3. Offer an update when ACP is absent

If the probe does not establish ACP support, display:

```text
当前 TraeCode CLI 版本较旧，不支持 ACP。是否执行 `traecli update` 升级？[y/N]
```

- Only an affirmative answer starts the update.
- The exact resolved executable is invoked with `update` in the foreground and
  inherits the terminal's input/output.
- Without a readable interactive terminal, do not wait for input; fail with an
  instruction to run `traecli update` manually.
- Refusal cancels this Agent cleanly and does not start either bridge.
- Update failure reports the original failure and the manual command.

After a successful update, refresh the shell command cache, clear cached
resolution, rediscover `traecli`, recheck the Coco-alias conflict, and repeat
the ACP capability probe. Failure to rediscover the command or to expose ACP
after the update is terminal; there is no CLI Bridge fallback.

### 4. Run the structured readiness check

After ACP support is confirmed, run:

```text
<resolved-traecli> doctor --json
```

The check is non-interactive, has a short configurable timeout, and captures
bounded stdout/stderr. Exit codes `0`, `1`, and `2` are interpreted together
with the JSON `checks` array rather than treating every nonzero exit as process
failure:

- no `error` checks: continue; warnings may be logged and do not block startup;
- `model` error: block and ask the user to open TraeCode CLI, complete login if
  prompted, use `/model` to select a model, and retry;
- any other error: block and show only sanitized check names, messages, and
  available remediation text;
- timeout, signal, unsupported exit code, malformed JSON, or missing `checks`:
  fail safely with a concise diagnostic.

The launcher never runs `traecli login`, `traecli login status`, or scripted
`/status`, because these are not reliable non-interactive authentication APIs.
`doctor` establishes operational readiness, not a claim that login state was
independently verified.

### 5. Start native ACP

When readiness passes, return a shell-safe form of:

```text
<resolved-traecli> acp serve
```

The controller initializes and starts `aamp-acp-bridge` through the existing
per-host/per-agent lifecycle. ACP sessions, permission handling, cancellation,
streaming, final result parsing, and Feishu Task updates use the existing
runtime pipeline without a Trae-specific stream adapter.

## Runtime data flow

```text
feishu-task-agent discover
  -> traex present?                -> expose Trae CLI Next（内部版）
  -> otherwise coco present?       -> expose Trae CLI（内部版）
  -> otherwise traecli present?    -> expose TraeCode CLI

selected/saved TraeCode CLI
  -> exact traecli resolution
  -> bounded `acp serve --help`
  -> if absent: confirm -> `traecli update` -> rediscover -> reprobe
  -> bounded `doctor --json`
  -> `traecli acp serve`
  -> aamp-acp-bridge
  -> ACP session updates and result
  -> aamp-feishu-bridge
  -> Feishu Task steps, comments, and status
```

## Error and cancellation behavior

| Failure | Required behavior |
| --- | --- |
| No Trae-family executable | omit the automatic Trae choice; explicit selection reports the missing exact product |
| Coco selected/detected | retain the existing consented Trae CLI Next upgrade flow; never invoke Coco ACP/login |
| `traecli` is the same executable as `coco` | report an internal-alias conflict for explicit TraeCode selection |
| ACP probe times out | fail quickly with the TraeCode CLI command and retry guidance |
| ACP probe returns root help only | treat ACP as unsupported and offer update |
| No interactive terminal for update confirmation | do not block; instruct the user to run `traecli update` manually |
| User declines update | cancel this Agent cleanly; start no TraeCode bridge |
| `traecli update` fails | preserve useful updater output and provide the manual retry command |
| Updated binary is missing or still lacks ACP | fail explicitly; never fall back to CLI Bridge |
| `doctor` reports only warnings | continue and retain concise warnings in the run log |
| `doctor` reports missing model | ask the user to open TraeCode CLI, complete any prompted login, and choose `/model` |
| `doctor` reports another error | show sanitized actionable checks and stop |
| `doctor` times out or emits invalid JSON | fail quickly; never enter a login/status TUI |
| ACP Bridge startup fails | preserve the original bridge error and add TraeCode-specific retry guidance |

One Agent's cancellation or preparation failure remains isolated by the
existing controller behavior so other selected bindings can continue.

## User-visible behavior matrix

| Installed commands / state | Automatic result |
| --- | --- |
| none of `traex`, `coco`, `traecli` | no Trae-family choice |
| only `traex` | Trae CLI Next（内部版）, native ACP |
| `traex`, `coco`, and `traecli` | Trae CLI Next（内部版）, native ACP |
| `coco` and `traecli`, no `traex` | Trae CLI（内部版）, internal upgrade prompt |
| only ACP-capable `traecli` | TraeCode CLI, doctor check, native ACP |
| only non-ACP `traecli` | TraeCode CLI, consented `traecli update` |
| non-ACP `traecli`, update declined | clean cancellation, no bridge |
| update fails or ACP remains absent | explicit failure, no CLI Bridge fallback |
| doctor has a `model` error | guidance to open TraeCode CLI and choose `/model` |
| doctor times out or returns invalid JSON | bounded failure, no TUI invocation |
| saved `traecli`, later `traex` installed | continue to start TraeCode CLI exactly |
| historical `trae` resolves to another runtime | keep ready stored binding; display the actual runtime product |

## Testing strategy

### Deterministic automated tests

Tests use temporary executable fixtures, isolated `PATH`/config directories,
and controlled terminal/input descriptors. They must not depend on the
developer's installed Trae products, login state, home configuration, network,
or real package publication.

ACP Bridge coverage:

1. `traecli` appears once in the known-agent registry.
2. Resolver discovery maps it to `traecli acp serve` and reads its version.
3. Missing executable produces the canonical warning/default.
4. JSON and interactive init retain explicit nonblank commands.
5. Existing Traex, WorkBuddy, Codex, and generic-agent behavior remains
   unchanged.

Task Agent discovery and identity coverage:

1. `traex` wins over both other commands.
2. `coco` wins over a simultaneous `traecli` when `traex` is absent.
3. only `traecli` produces canonical `traecli`.
4. explicit/saved `traecli` never falls back to `traex` or `coco`.
5. a `traecli` path resolving to the same executable as `coco` is rejected as
   an internal alias during explicit external preparation.
6. pending compatibility bindings normalize to their actual runtime type;
   ready historical bindings retain stored identity while displaying runtime
   identity.
7. help, selection lists, start output, success output, and failures use the
   approved product labels.

Capability/update coverage:

1. ACP-specific help passes.
2. root help with exit zero does not pass.
3. probe failure or timeout offers/fails with the defined behavior.
4. affirmative update runs the same resolved executable in the foreground,
   rediscovery occurs, and ACP is reprobed.
5. refusal, no TTY, updater failure, missing post-update executable, and
   post-update non-ACP behavior are distinct and deterministic.
6. no path invokes CLI Bridge or a TraeCode login/status command.

Doctor coverage:

1. healthy checks and warning-only checks continue.
2. valid JSON with exit two is parsed rather than treated as a generic command
   failure.
3. a `model` error emits the login/model guidance.
4. other errors are sanitized and block startup.
5. timeout, malformed JSON, missing checks, and unsupported exit status fail
   safely.

Regression suites include existing one-click bootstrap/controller, Trae/Traex,
WorkBuddy, Task step/stream, ACP Bridge resolver/init/discovery/runtime, and
package build tests.

### Native ACP smoke test

On a machine with a prepared TraeCode CLI, run an isolated ACP prompt through
the exact generated command and verify:

- ACP initialization and session creation;
- more than one streamed update when the agent emits them;
- final result and `end_turn` completion;
- graceful session/process cleanup.

This smoke test must not modify the user's normal AAMP binding store.

### Feishu Task end-to-end acceptance

With an approved test Bot and isolated Task Agent config:

1. discover and select TraeCode CLI;
2. create or reuse an isolated binding;
3. dispatch a real Feishu Task;
4. verify human-readable Task steps, final comment/result, and terminal task
   status;
5. stop and restart the saved binding and verify it still starts TraeCode CLI
   even if Trae CLI Next is also installed.

A successful package build, ACP probe, bridge startup line, or npm publication
alone is not acceptance.

## Documentation changes

- Update ACP Bridge supported-agent documentation with canonical `traecli` and
  `traecli acp serve`.
- Update Task Agent help/README with the three approved product labels,
  discovery order, external update behavior, doctor remediation, and exact
  saved-binding semantics.
- Keep Coco/CLI Bridge documentation separate and state that it is not a
  TraeCode fallback.

## Implementation boundaries

The expected production changes are limited to:

- `packages/aamp-acp-bridge` resolver/discovery/init documentation and tests;
- `packages/aamp-feishu-task-agent` bootstrap, controller, documentation, and
  tests.

No Feishu Bridge stream-schema change is required because both Trae CLI Next
and TraeCode CLI feed the existing ACP event pipeline.
