# aamp-feishu-task-agent

One-click manager for binding local Codex/Cursor/Trae/WorkBuddy agents to
user-owned Feishu Bots and running the corresponding Task bridges.

## Install and bind

Run the standalone one-click command. Its existing Node.js/npm dependency
installation flow is unchanged:

```bash
npx -y --package @luckyterry/aamp-feishu-task-agent@dev \
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

The supported canonical agent names are `codex`, `cursor`, `coco`, `traex`,
`traecli`, `workbuddy`, `workbuddy_ai`, and `aime`.
`--agent codex|cursor|coco|traex|traecli|workbuddy|workbuddy_ai|aime` fixes the Agent
for every new binding in that command instead of prompting.
Selection menus, saved bindings, and startup output display these canonical
`agent_type` values verbatim. The removed `trae` value is not accepted as a
command-line alias or stored binding type; affected bindings must be created
again with `coco`.
The Task Agent flow only supports the Online environment. Environment-switch
arguments are not supported.

The Trae-family choice uses this order:

1. `traex` → Trae CLI Next（内部版）
2. `coco` → Trae CLI（内部版） and the existing Next upgrade prompt
3. only when `coco` is absent, `traecli` → TraeCode CLI

For the internal Trae CLI flow, accepting the upgrade prompt runs the Trae CLI
Next installer and continues with `traex`. A new pending `coco` binding is
normalized and saved as `traex`, so subsequent startup output uses `traex`.
Declining the upgrade cancels the current binding or startup without
invoking legacy `login`, `login status`, or ACP commands, and leaves saved
bindings unchanged. Native ACP startup is exactly `traex acp serve`; the
generated command intentionally omits `--yolo` and never adds a bypass or
approval flag.

TraeCode CLI is stored as `agent_type: traecli` and starts native ACP with
`traecli acp serve`. If that command is unavailable, the launcher asks before
running `traecli update`, then checks ACP again. It runs
`traecli doctor --json` without entering the TUI; model errors ask you to open
TraeCode CLI and use `/model`. The launcher never runs a TraeCode login/status
command and never falls back to CLI Bridge.

A saved `traecli` binding remains TraeCode CLI even after `traex` is installed.
Ready `coco` bindings keep their stored identity and mailbox, while runtime
startup output displays the resolved raw type `traex` or `traecli` that will
actually be used.

`workbuddy` is detected only from the standard macOS WorkBuddy.app installation:
`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`.
The launcher uses the app-bundled `codebuddy --acp` command.
It does not run a WorkBuddy login command. Open WorkBuddy and complete login
before starting a binding. Startup verifies login by creating and immediately
closing a temporary ACP session without sending a model prompt. Nonstandard
paths and non-macOS installations are not auto-detected.

`workbuddy_ai` is the international WorkBuddy AI application. It is detected
only at
`/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`.
Its persisted and displayed Agent type remains the literal `workbuddy_ai`.
When both WorkBuddy applications are installed, `workbuddy` and
`workbuddy_ai` are offered independently. The Task Agent does not run a login
command for either product; complete login in the selected desktop app.

`aime` is the ByteDance-internal remote AIME Agent. It is offered only when a
short `ping aime.bytedance.net` probe succeeds; an explicit `--agent aime`
selection uses the same gate before any AIME install or login. The launcher
installs the exact AIME version pinned by the bootstrap as
`@tengchengwei/aime-acp@<version>` from `https://bnpm.byted.org` into
the shared `$HOME/.aamp/npm-global` prefix, removes the obsolete unscoped
`aime-acp` package when present, then runs the scoped package's absolute
`dist/bin.js` entry with `--site cn`.
Readiness is authoritative only after `auth status`/`auth login` and
`doctor --site cn --json` succeed; ping is only the one-click visibility gate.
The generated bridge config rejects attachments and limits AIME task dispatch
to one task at a time because AIME is remote and does not use the local
workspace. All other Agents default to local execution; AIME is explicitly
configured as remote. It reads requested Feishu/Lark data with its own
remote-native capabilities and identity, without a local `lark-cli` profile or
user OAuth. The local Feishu Bridge still uses Bot App credentials and is the
only writer of the current Task's comment, status, and delivery. Remote
attachments and local file delivery are unsupported; use text or HTTP(S) links.
`aamp-feishu-task-bridge` is deprecated and is not an AIME implementation
target. AIME `auth`/`doctor` success proves adapter readiness only, not access
to a particular Feishu group.

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

- `install` preserves saved pairs and atomically saves each accepted pair as
  pending before it starts any Bridge. If the Bot App ID is already bound,
  replacement requires explicit confirmation. A startup failure leaves the
  pending pair available for a later `start` retry; successful Bridge processes
  remain running.
- `start` multi-selects saved pairs. Selecting `全部` takes precedence over any
  other selection. If no pair is configured, the terminal prints the full
  install command. Its final summary retains the successful/planned count and
  lists the concrete successful, failed, and cancelled pairs.
- `list` prints saved Agent-Bot pairs and never prints App Secrets.
- `add` uses the same confirmed atomic add/replace behavior and saves each pair
  as pending. It does not acquire an Agent lease, perform ACP pairing, or start
  any Bridge. When another Task Agent is already running, its Bridges are not
  hot-switched or stopped; the saved configuration is used by the next `start`.
  The first subsequent `start` completes pairing, creates runtime configuration,
  and keeps the selected Bridges running.
- `remove` multi-selects pairs, with a `全部` option. It only removes saved
  pairing records; Bridges that are already running are not stopped.
- `update` refreshes the installed short command and package.

Single-choice and confirmation menus use `↑`/`↓` to move and Enter to confirm.
For `start` and `remove`, use `↑`/`↓` to move, Space to select multiple items,
and Enter to confirm the selection.

Bridge startup is serial. A failure is printed and recorded, then the next pair
is attempted. The command exits as a startup failure only when every selected
pair fails. User-cancelled Coco selections are reported separately and
are not recorded as system failures. Within one command invocation, all Bots for the same Agent/AAMP
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
Bridge, and the local Codex/Cursor/Trae process so task execution resolves the exact
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
