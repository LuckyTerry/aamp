# Local and Remote Agent Execution Design

## Context

The one-click Task Agent flow currently treats every Agent as a process that
runs on the caller's computer. That assumption is correct for the existing
local Agents, but not for Aime:

- `aime-acp` is a local ACP adapter for a remote Aime Agent;
- the Aime Agent executes in a remote sandbox and cannot use the caller's
  working directory, local files, `lark-cli` binary, or local `lark-cli`
  profile;
- the remote Aime environment has its own identity and native Feishu/Lark
  capabilities for reading data such as group messages and documents;
- the local Feishu Bridge must remain the only component that writes comments,
  status changes, and deliveries to the current Feishu Task.

Today the one-click controller installs and probes `lark-cli` for every
binding, and Feishu Task prompt construction injects the selected local CLI
path, profile, shell prefix, working-directory rules, and local-file delivery
requirements. `aime-acp` correctly forwards that prompt to remote Aime, which
then tries to obey requirements that cannot exist in its sandbox. The observed
failure when asking Aime to summarize a Feishu group is therefore a locality
contract error, not an Aime session or result-parser error.

This change introduces an explicit execution-location contract so startup,
prompt construction, file handling, and diagnostics all agree on where an
Agent actually runs.

## Goals

1. Classify every Agent as `local` or `remote`, with `local` as the default.
2. Classify Aime as `remote` without scattering `agent === "aime"` checks
   through the three participating packages.
3. Skip caller-local `lark-cli`, profile, user OAuth, filesystem, and shell
   requirements for remote Agents.
4. Let remote Aime use its own native remote capabilities and identity to read
   requested Feishu/Lark data.
5. Preserve the Feishu Bridge as the sole writer for the current Task's
   comments, status, and delivery records.
6. Preserve existing local-Agent behavior and legacy configuration by
   defaulting a missing execution location to `local`.
7. Fail closed for remote attachments and local-file outputs until a real
   remote artifact transport exists.
8. Keep raw commands, prompts, and caller-local paths out of user-visible
   Feishu errors.

## Non-goals

- Uploading files between a remote Agent sandbox and the local bridge.
- Giving remote Aime access to the caller's workspace, MCP servers, home
  directory, or local credentials.
- Replacing the existing Aime authentication, compatibility, doctor, session,
  streaming, cancellation, or result-envelope contracts.
- Dynamically negotiating execution location through ACP initialization.
- Deleting existing `lark-cli` installations or profiles.
- Changing how local Agents use `lark-cli`, cwd, local attachments, or file
  delivery.
- Reviving, modifying, or depending on the deprecated
  `aamp-feishu-task-bridge` package. All Task runtime changes belong to the
  merged `aamp-feishu-bridge` package.
- Publishing packages, changing package versions, or performing a production
  rollout as part of the implementation.

## Considered Approaches

### 1. Explicit execution location in trusted configuration

Add `executionLocation: "local" | "remote"` to Agent metadata and propagate it
to the ACP Bridge and the Task runtime configuration inside
`aamp-feishu-bridge`. Both bridges choose their behavior from their own trusted
configuration.

This is the selected approach. It is explicit, defaults safely for existing
configurations, is testable before any Agent process starts, and extends to
future remote Agents without changing shared prompt logic.

### 2. Special-case Aime at each call site

The bootstrap, controller, Feishu Bridge, and ACP Bridge could each test the
Agent name. This has a smaller initial diff, but creates multiple sources of
truth and makes the next remote Agent easy to implement incorrectly. It is
rejected.

### 3. Negotiate a locality capability after ACP initialization

ACP could theoretically advertise whether the Agent can access the caller's
workspace. The current public ACP contract has no suitable locality capability,
and initialization happens after the one-click flow has already decided
whether to install and authenticate `lark-cli`. This may complement static
metadata in the future, but cannot be the primary contract now.

## Terminology and Invariants

```ts
export type AgentExecutionLocation = 'local' | 'remote'
```

- **Local Agent**: the Agent process and its tools operate on the caller's
  computer. Every existing non-Aime Agent remains local.
- **Remote Agent**: the local ACP command is only an adapter; the actual Agent
  and its tools operate in another environment. Aime is remote.
- **Current Task write ownership**: only the local Feishu Bridge may write
  comments, status transitions, and delivery records for the Feishu Task that
  caused the dispatch.
- **Remote native access**: a remote Agent may use its own authenticated native
  capabilities to read data required by the user's request. Those capabilities
  do not grant access to the caller's local environment.

Execution location is configuration, not task data. A Task sender cannot
change it through the task body, prompt rules, or `dispatchContext`.

## Architecture

### Shared Task Agent metadata

The Task Agent package gains one shared Agent metadata source that is usable by
both the shell bootstrap and the Node controller. It contains at least:

```ts
interface TaskAgentMetadata {
  executionLocation: AgentExecutionLocation
  attachmentPolicy?: 'allow' | 'reject'
  taskDispatchConcurrency?: number
}
```

All known Agent types resolve to `local` unless explicitly declared otherwise.
The Aime entry is:

```text
executionLocation = remote
attachmentPolicy = reject
taskDispatchConcurrency = 1
```

The metadata is defined once in a small module with a machine-readable query
entrypoint. The Node controller imports it directly; the shell bootstrap asks
the same entrypoint once after Agent selection and caches the result. The
existing Aime-specific ACP overrides move into this metadata rather than
remaining a separate conditional.

The persisted one-click binding continues to use `agent_type` as its canonical
identity. It does not persist another user-editable copy of execution location.
The controller derives current policy from metadata on every start, so existing
Aime bindings automatically become remote and future policy changes cannot
leave stale binding data behind.

### ACP Bridge configuration

Each ACP Bridge Agent configuration gains:

```ts
executionLocation: 'local' | 'remote' // default: 'local'
```

Configuration parsing, JSON initialization, update preservation, discovery,
and storage migration all preserve this field. A missing field normalizes to
`local`.

For the current release, a remote Agent configuration is valid only with
`attachmentPolicy: "reject"`. Validation fails closed instead of silently
materializing remote paths on the caller's machine. One-click metadata already
supplies the valid Aime combination.

The Agent Bridge passes execution location to prompt construction through an
options object. It never takes the value from the incoming Task.

### `aamp-feishu-bridge` Task runtime configuration

The persisted Task runtime configuration inside the merged
`aamp-feishu-bridge` package gains a trusted Agent descriptor:

```ts
agent: {
  type: string
  executionLocation: 'local' | 'remote'
}
```

Legacy Task runtime configurations without the descriptor normalize to a
local Agent. The non-interactive CLI gains an explicit
`--agent-execution-location local|remote` option; omission means `local`.
One-click always passes the value derived from shared metadata.

The Task runtime profile distinguishes Bot authentication mode from Agent
execution location:

```ts
auth_mode: 'app-secret' | 'lark-cli'
lark_cli_profile?: string
```

Local bindings keep `lark-cli`. Remote bindings use the existing Bot App ID and
App Secret directly. Secret-bearing profile and generated bridge config files
remain inside the private runtime directory and are written atomically with
mode `0600`; the App Secret is never added to argv, logs, prompt text, or
`dispatchContext`.

### Configuration authority

The one-click controller derives one policy and writes matching explicit
values to both bridge configurations:

```text
Agent metadata
  -> ACP Bridge AgentConfig.executionLocation
  -> aamp-feishu-bridge Task runtime BridgeConfig.agent.executionLocation
```

Neither bridge trusts an execution-location field from AAMP Task payloads.
Direct, non-one-click deployments must configure each bridge explicitly; their
defaults remain local for compatibility.

## One-click Startup Behavior

### Local Agent path

The current flow remains unchanged:

1. register the Feishu Bot App;
2. install and validate local `lark-cli`;
3. create or reuse the selected profile;
4. complete user OAuth and scope checks;
5. probe the profile during later starts;
6. start Feishu Bridge with `--use-feishu-cli`, profile, and binary arguments;
7. initialize ACP Bridge with `executionLocation: "local"`.

### Remote Agent path

For Aime and future remote Agents:

1. keep the existing internal-network eligibility check;
2. register the Feishu Bot App through the existing Node SDK and retain the
   App credentials, app-level Task/IM permissions, and event subscriptions
   needed by the local bridge;
3. do not install, create, authenticate, probe, or repair a local `lark-cli`
   profile;
4. write an app-secret Task runtime profile with private permissions;
5. start Feishu Bridge without `--use-feishu-cli`,
   `--feishu-cli-profile`, or `--feishu-cli-bin`;
6. continue installing the pinned internal `aime-acp` package;
7. continue running Aime `auth status`, login when required, and `doctor`;
8. continue installing and using acpx and both local bridges;
9. initialize both bridge configurations with `executionLocation: "remote"`.

Skipping local user OAuth does not remove the Bot App permissions and event
subscriptions required for `aamp-feishu-bridge` to receive and update the
current Task.

Startup output calls Aime a remote Agent rather than a local Agent. A stale
`lark_cli_profile` in a legacy Aime binding is ignored and is not deleted.

## Prompt Composition

Prompt construction is split into invariant rules plus an
execution-location-specific policy.

### Invariant Feishu Task contract

Both Agent classes receive:

- authoritative Feishu Task summary, description, source context, child tasks,
  effective comments, event metadata, and thread context;
- identity guidance that AAMP is transport rather than Agent identity;
- current Task write ownership by the Feishu Bridge;
- the `FEISHU_TASK_RESULT_JSON` schema and outer `AAMP_RESULT_JSON` envelope;
- `answered`, `succeeded`, `need_help`, and `failed` terminal semantics;
- the nested JSON newline-escaping contract;
- the rule that final output occurs only after all work for the turn has
  settled.

The result protocol remains unchanged because Feishu Task completion depends
on it.

### Local execution policy

Local Agents retain the current rules for:

- current working directory and explicitly requested external paths;
- exact `lark-cli` binary and profile;
- local shell hardening and auth-status checks;
- local attachments and `FILE:/absolute/path` references;
- `file_delivery` validation and upload.

### Remote execution policy

Remote Agents instead receive explicit rules that:

- the Agent runs in a remote sandbox;
- caller-local cwd, files, home directory, binaries, profiles, credentials,
  MCP servers, and shell environment do not exist in that sandbox;
- the Agent must not request or quote a caller-local command path;
- Feishu/Lark reads required by the task should use the Agent's own remote
  native capabilities and identity;
- those remote capabilities and credentials are owned by the remote Agent and
  are neither provisioned nor copied by one-click setup;
- the Feishu Bridge alone writes the current Task's comments, status, and
  deliveries;
- text and HTTP(S) link results are supported;
- local `FILE` references, ACP file attachments, and `file_delivery` are not
  supported;
- internal remote tool orchestration is allowed, but no unfinished background
  work may remain when the final result envelope is emitted.

Remote-generated policy text never renders:

- `lark-cli` or `--profile` instructions;
- `source ~/lark-env.sh` or shell-function cleanup prefixes;
- caller-local absolute paths;
- “current working directory” filesystem guidance;
- local `FILE:` or `file_delivery` examples;
- instructions to copy context-compression text verbatim across remote
  sessions.

The user's Task content and thread context remain verbatim inputs. A user may
legitimately mention a local path or `lark-cli`; the bridge must preserve that
request while avoiding any generated claim that those caller-local resources
are available to the remote Agent.

The invariant result contract is reinjected on every Feishu Task dispatch,
including follow-up turns, rather than relying on remote conversational memory
to preserve it.

### ACP Bridge default prompts

The ACP Bridge also selects its generic and conversational default prompt from
trusted Agent execution location. This prevents non-Task surfaces from
reintroducing local cwd and `FILE:` assumptions when the configured Agent is
remote. Feishu-supplied prompt rules remain authoritative for the Task-specific
contract, but cannot weaken remote file-safety enforcement in the bridge.

## Data Flow

1. The user selects Aime in one-click setup.
2. Shared metadata resolves Aime as remote.
3. The local controller prepares `aime-acp` and Aime authentication, but skips
   local `lark-cli` setup.
4. The controller starts ACP Bridge and Feishu Bridge with matching trusted
   execution-location configuration.
5. Feishu Bridge receives a Task event and builds invariant plus remote prompt
   rules.
6. ACP Bridge correlates the Task to the stable Aime ACP session and sends the
   remote-safe prompt.
7. Remote Aime uses its own native tools and identity to read requested group
   messages or documents.
8. Aime returns the unchanged nested result envelope.
9. ACP Bridge emits the result; Feishu Bridge validates it and exclusively
   writes the current Task comment, deliveries, and terminal status.
10. A follow-up comment repeats steps 5-9 using the same stable session without
    reintroducing local execution requirements.

## Attachments and Deliveries

Incoming attachments remain rejected before ACP prompt creation for Aime. No
download, temporary directory, ACP attachment, or local task lock associated
with attachment materialization is created.

For remote Agents:

- `text_delivery` is allowed;
- `link_delivery` with an HTTP(S) URL is allowed;
- `file_delivery` is rejected as an unsupported remote artifact before any
  local filesystem `stat`, read, or upload;
- an exact `FILE:/...` attachment marker in plain ACP output produces the safe
  `REMOTE_ARTIFACT_UNSUPPORTED` failure and is never resolved against the
  caller's filesystem.

A future remote artifact channel requires a separate design with explicit
ownership, size, content, privacy, and cleanup contracts.

## Error Handling and Privacy

- Invalid execution-location values fail configuration validation before
  process startup.
- A remote Agent configured with attachment materialization enabled fails
  closed.
- Unsupported remote `FILE:` or `file_delivery` output uses the stable safe
  `REMOTE_ARTIFACT_UNSUPPORTED` category before any caller filesystem access.
- Aime auth, identity, compatibility, session, and protocol failures retain
  their existing stable safe error codes.
- If remote native data access is unavailable and user action can resolve it,
  the Agent returns `need_help`; an unrecoverable remote task failure returns
  `failed`.
- A successful local Aime doctor probe proves adapter, auth, and session
  readiness, not that every requested Feishu group or document is visible to
  the remote identity. The live Task remains the acceptance gate for that
  capability.
- The Bridge does not silently fall back from remote native access to caller
  `lark-cli` or local files.
- User-visible Task errors contain a safe category and concise action. They do
  not contain the acpx command, ACP command, full prompt, caller cwd, local
  executable path, profile name, App Secret, tokens, or identity data.
- Local diagnostics may retain bounded structural details required for
  debugging, but commands and prompts are redacted and credentials are never
  logged.

The internal acpx invocation may continue to require a cwd argument as a
protocol/runtime detail. That argument is inert for Aime, is not advertised as
a capability, and is not included in remote prompt or user-visible errors.

## Compatibility and Migration

- Missing execution location in ACP Bridge config normalizes to `local`.
- Missing Agent descriptor in an `aamp-feishu-bridge` Task runtime config
  normalizes to the configured/selected Agent type with
  `executionLocation: "local"`.
- Shared metadata causes existing Aime one-click bindings to start as remote
  without rewriting their persisted binding identity.
- A legacy Aime `lark_cli_profile` field is tolerated but ignored. No profile
  or credential file is deleted automatically.
- Local bindings still require a valid `lark_cli_profile` and retain current
  OAuth/probe behavior.
- Current session keys, pairing identities, attachment rejection,
  `taskDispatchConcurrency: 1`, result schemas, and follow-up correlation are
  unchanged.
- Adding another remote built-in Agent requires one metadata entry plus its ACP
  preparation implementation; shared startup and prompt code branches on
  execution location rather than Agent name.

## Test Strategy

Implementation follows red-green-refactor at each boundary.

### Shared metadata and configuration tests

- all existing Agents resolve to local;
- Aime resolves to remote with attachment rejection and concurrency one;
- unknown or missing execution location defaults to local where compatibility
  is required and invalid explicit values fail;
- ACP Bridge JSON init, update, load, and storage migration preserve execution
  location;
- legacy `aamp-feishu-bridge` Task runtime config normalizes to local;
- remote ACP configuration cannot enable local attachment materialization;
- one-click writes the same location to both bridge configurations.

### One-click startup tests

- remote registration invokes Bot App registration but never installs,
  authenticates, ensures, or probes `lark-cli`;
- remote Feishu argv omits all CLI/profile/bin flags and never includes the App
  Secret;
- the private app-secret profile is mode `0600`;
- Aime internal-network, package installation, auth, and doctor stages still
  run;
- local bindings retain the existing `lark-cli` startup sequence and argv;
- legacy Aime bindings with a profile start remotely and leave the profile
  untouched;
- startup copy says remote Agent for Aime and local Agent for existing Agents.

### Prompt and runtime tests

- invariant result-schema tokens are identical in local and remote Feishu
  prompts;
- remote prompts contain native remote capability and current-Task ownership
  rules;
- generated remote policy sections contain none of `lark-cli`, `--profile`,
  local binary paths, `source ~/lark-env.sh`, current-working-directory rules,
  `FILE:`, or `file_delivery` examples, while user-authored text is preserved;
- local prompt snapshots retain the existing CLI, cwd, and file semantics;
- generic ACP conversational and task prompts also omit local assumptions for
  remote Agent config;
- remote `file_delivery` and exact `FILE:/...` attachment-marker output returns
  `REMOTE_ARTIFACT_UNSUPPORTED` before filesystem access;
- incoming Aime attachments are rejected before prompt/session work;
- raw acpx command, prompt, cwd, and binary path never reach Task comments.

### Packaged integration tests

A deterministic packaged test starts the real built ACP and bridge packages
with fake remote Aime boundaries. It verifies:

- first-turn Task dispatch uses the remote-safe prompt;
- a native remote Feishu-read simulation can return a valid group summary;
- the nested result envelope is parsed and applied;
- a follow-up comment reuses the stable session and again receives the
  invariant contract;
- attachment rejection happens before ACP invocation;
- local Agent regression fixtures still receive their original local policy;
- all child processes and temporary roots are cleaned.

### Live acceptance gate

The final manual gate, on the company network with an authenticated Aime
account and authorized Bot App, is:

1. start the Aime binding through the local one-click flow on a machine where
   no usable `lark-cli` profile is required for that binding;
2. create a Feishu Task asking `总结一下 lark mind 群昨天的消息`;
3. observe Aime read the group through its remote-native capability;
4. observe streamed progress, a valid final Feishu comment, and completed Task
   status;
5. add a follow-up comment and verify the same session completes again;
6. verify prompts, Task comments, and collected safe logs contain no caller
   local path, CLI profile, App Secret, raw tool payload, or full acpx command.

Successful process startup alone is not acceptance evidence.

## Expected Implementation Scope

The implementation is expected to touch only the cohesive execution-location
path:

- `packages/aamp-feishu-task-agent` shared metadata, bootstrap, controller,
  and focused tests;
- `packages/aamp-feishu-bridge` Task runtime config, profile authentication
  mode, dispatch prompt composition, remote file-output enforcement, and tests;
- `packages/aamp-acp-bridge` Agent config, JSON init/storage preservation,
  generic prompt composition, remote file enforcement, error sanitization, and
  tests;
- one-click and package documentation for local versus remote Agent behavior.

`packages/aime-acp` should require no behavioral change: it already models Aime
as remote and should continue forwarding text and managing Aime auth, sessions,
events, cancellation, and ACP results. A narrow documentation or regression
test adjustment is acceptable if the implementation exposes a missing contract,
but changing the Aime transport is not part of this design.

## Completion Criteria

The feature is complete only when:

1. one shared metadata decision classifies Aime as remote;
2. Aime startup has no local `lark-cli` dependency;
3. both bridges use trusted remote configuration;
4. Aime receives no caller-local execution requirements;
5. remote native Feishu reads can complete through the unchanged result
   protocol;
6. the Feishu Bridge remains the sole current-Task writer;
7. remote local-file inputs and outputs fail closed;
8. local Agent behavior remains compatible;
9. first-turn and follow-up packaged tests pass; and
10. the live Feishu Task scenario passes without local path, profile, prompt,
    or credential leakage.
