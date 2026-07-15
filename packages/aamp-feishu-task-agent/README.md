# aamp-feishu-task-agent

One-click manager for binding local Codex/Cursor agents to user-owned Feishu
Bots and running the corresponding Task bridges.

## Install and bind

Run the standalone one-click command. Its existing Node.js/npm dependency
installation flow is unchanged:

```bash
npx -y --package @zengxingyuan/aamp-feishu-task-agent@dev \
  feishu-task-agent install
```

`install` first collects local Agent and Feishu Bot choices until the user
chooses not to continue. No Bridge is started while choices are being
collected. The same Agent may be bound to multiple Bots, while a Bot can only
be selected once. After selection, one Agent Bridge group is prepared and each
pair is started serially with a real one-time ACP pairing. A successful first
Feishu Bridge start is kept as the final running process instead of being
stopped and started a second time. The successfully completed bindings then
atomically replace the new-flow configuration.

The package installs the short command `feishu-task-agent`. Running that short
command without arguments shows help. Running the standalone Bootstrap without
arguments is equivalent to `install`.

Only `codex` and `cursor` are supported by this flow. `--agent codex|cursor`
fixes the Agent for every new binding in that command instead of prompting.
The Task Agent flow only supports the Online environment. Environment-switch
arguments are not supported.

## Commands

```bash
feishu-task-agent install
feishu-task-agent start
feishu-task-agent list
feishu-task-agent add
feishu-task-agent remove
feishu-task-agent update
feishu-task-agent help
```

- `install` collects one or more pairs, then serially pairs and starts them.
  The initial successful Bridge processes remain running.
- `start` multi-selects saved pairs. Selecting `全部` takes precedence over any
  other selection. If no pair is configured, the terminal prints the full
  install command.
- `list` prints saved Agent-Bot pairs and never prints App Secrets.
- `add` completes Bot selection/creation and lark-cli authorization, then saves
  each pair as pending. It does not acquire an Agent lease, perform ACP pairing,
  or start any Bridge. The first subsequent `start` completes pairing, creates
  runtime configuration, and keeps the selected Bridges running.
- `remove` multi-selects pairs, with a `全部` option. It only removes saved
  pairing records; Bridges that are already running are not stopped.
- `update` refreshes the installed short command and package.

Single-choice and confirmation menus use `↑`/`↓` to move and Enter to confirm.
For `start` and `remove`, use `↑`/`↓` to move, Space to select multiple items,
and Enter to confirm the selection.

Bridge startup is serial. A failure is printed and recorded, then the next pair
is attempted. The command exits as a startup failure only when every selected
pair fails. Within one command invocation, all Bots for the same Agent/AAMP
host reuse one ACP Bridge process. Independent invocations do not attach to an
existing process; an Agent lease prevents competing runtimes from being
started for the same Agent identity.

Only `install` and `start` may launch Bridges. Before either command enters its
interactive flow, it acquires one global runtime-session lease and also checks
for Agent leases left by an older Task Agent version. If another live Task
Agent runtime exists, the command exits and asks the user to stop the previous
terminal with `Ctrl+C`. `add`, `list`, and `remove` never acquire this runtime
lease and never start a Bridge.

## Configuration and compatibility

The new flow uses a dedicated configuration:

```text
~/.aamp/feishu-task-agent/bindings-v1.json
```

It does not read, migrate, overwrite, or delete the legacy Feishu task profile
configuration. Existing users enter the new binding flow again. Runtime files
are isolated under:

```text
~/.aamp/feishu-task-agent/runtime-v1/
```

The configuration directory is mode `0700` and `bindings-v1.json` is mode
`0600`. The App Secret is intentionally stored as plaintext so a saved pair can
be started again without asking for credentials. Treat this file as a local
credential and do not share it. Bridge-specific derived configuration is kept
inside the same protected new-flow runtime directory.

Bindings saved by `add` use the `pending` state and do not contain Agent or
Feishu Bridge runtime identities. After their first successful `start`, the
same records are atomically updated to `ready` with the generated runtime
metadata. Existing ready records without an explicit state remain compatible.

Saved bindings whose environment is not Online are incompatible with this
version. They remain visible to `list` and can be deleted with `remove`, but
`start` skips them with an explicit error and continues with the next binding.

If a saved `lark-cli` profile is missing, `start` recreates it from the stored
App ID/App Secret and resumes user authorization. If the persisted Agent or
Feishu Bridge mailbox identity is missing or has changed, startup rejects that
pair and asks the user to bind it again instead of reporting a false success.
The same Online `LARKSUITE_CLI_CONFIG_DIR` is passed to Feishu Bridge, Agent
Bridge, and the local Codex/Cursor process so task execution resolves the exact
profile created during binding.

## Local logs and diagnostics

Each command creates a run under:

```text
~/.aamp/logs/runs/<timestamp>-<pid>/
```

Multi-Bot runs use flat, unique component log files so the existing `aamp-logs`
command can find them:

```text
one-click.log
feishu-register.<random>
acp-bridge-<host-hash>.jsonl
feishu-bridge-<binding-id>-install.jsonl
feishu-bridge-<binding-id>-add.jsonl
feishu-bridge-<binding-id>-start.jsonl
errors.jsonl
manifest.json
```

The manifest and terminal output never include App Secrets. Component output is
redacted before it is written by the Controller. Verbose Feishu registration
details (SDK metadata, scopes, events, and raw SDK output) are written to a
private per-run registration log instead of flooding the interactive terminal.

Useful diagnostics commands:

```bash
~/.aamp/bin/aamp-logs collect --run-dir <run log directory>
~/.aamp/bin/aamp-logs collect --latest
~/.aamp/bin/aamp-logs collect --task-id <Task ID>
~/.aamp/bin/aamp-logs collect --task-guid <Feishu task guid>
~/.aamp/bin/aamp-logs list-runs
~/.aamp/bin/aamp-logs tail -f
```
