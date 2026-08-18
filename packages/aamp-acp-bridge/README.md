# aamp-acp-bridge

Config-driven bridge that connects ACP-compatible agents to the AAMP email network.

## Install

```bash
npm install aamp-acp-bridge
```

## Usage

Initialize the bridge:

```bash
npx aamp-acp-bridge init
```

The init wizard scans installed ACP-capable agents, including Hermes, Traex, and the macOS WorkBuddy app, then lets you select multiple entries with arrow keys, Space, and Enter. For each selected agent, choose one authorization setup method:

- Pair with a five-minute terminal QR code plus the matching `aamp://connect?...` URL.
- Manually enter `senderPolicies`.
- Reuse existing `senderPolicies`, when any are available.
- Configure sender authorization later; `task.dispatch` is rejected until pairing or policy setup is complete.

If you choose QR pairing, `init` starts the bridge immediately after writing config, so scanning the QR code with AAMP App works right away. The bridge answers each `pair.request` with `pair.respond`; rejected responses include the failure reason.

Use `--no-start` only when you need to generate config in a script without
keeping the bridge process running:

```bash
npx aamp-acp-bridge init --agent claude --no-start
```

After an agent has been initialized, generate a fresh pairing QR code without
re-running setup:

```bash
npx aamp-acp-bridge pair --agent claude
```

Start the bridge:

```bash
npx aamp-acp-bridge start
```

Desktop and other non-interactive clients can use JSON output:

```bash
npx aamp-acp-bridge init --json --input -
npx aamp-acp-bridge discover --json
npx aamp-acp-bridge list --json
npx aamp-acp-bridge start --json
npx aamp-acp-bridge pair --agent claude --json --no-start
```

`init --json` is an upsert operation for desktop clients: it writes the bridge config, reuses existing credentials when available, registers missing mailboxes, and does not auto-start the bridge. `discover --json` scans known ACP-capable agents on PATH, also detects the Codex CLI bundled inside `/Applications/Codex.app`, and includes already configured agents from the bridge config. `start --json` emits JSONL runtime events on stdout and sends human-readable logs to stderr. `pair --json --no-start` creates a pairing URL without rendering a terminal QR code.

Example JSON init input:

```json
{
  "aampHost": "https://meshmail.ai",
  "agents": [
    {
      "name": "claude",
      "acpCommand": "claude",
      "createPairing": true
    }
  ]
}
```

When debugging task routing, add `--debug` to print the exact prompt sent to
the ACP agent for each `task.dispatch`:

```bash
npx aamp-acp-bridge start --debug
```

By default, the bridge stores its config under `~/.aamp/acp-bridge/config.json` and agent credentials under `~/.aamp/acp-bridge/credentials/`.
Legacy `./bridge.json` and `~/.acp-bridge/` data are migrated automatically on first use without deleting the original files.

The bridge understands these task lifecycle intents:

- `task.dispatch`
- `task.stream.opened`
- `task.help_needed`
- `task.result`
- `task.cancel`

Dispatch tasks can also carry:

- `priority`: `urgent | high | normal`
- `expiresAt`: an ISO-8601 timestamp after which the task should no longer run
- `promptRules`: an optional complete text block that replaces the default task
  prompt rules

If a `task.cancel` arrives before the ACP agent returns a final answer, the bridge suppresses any later result send for that task.

When `promptRules` is present on `task.dispatch`, the ACP prompt keeps its
standard task identity, metadata, dispatch context, description, and thread
context, then replaces the default task rule block with the provided text.

While ACP execution is in progress, the bridge can:

- create an AAMP task stream for the task
- send `task.stream.opened`
- append `todo`, `tool_call`, and `text.delta` events
- forward ACP `agent_thought_chunk` / `agent_message_chunk` updates into the AAMP stream in realtime
- expose tool activity as `tool_call` updates while the agent is working
- close the stream before the authoritative `task.result` or `task.help_needed`

When `acpx` supports `--format json --json-strict`, the bridge consumes the structured ACP NDJSON stream so reasoning / reply chunks can be forwarded live. Older `acpx` builds automatically fall back to plain-text mode, which preserves compatibility but cannot expose thought chunks incrementally.

## Config

Minimal example:

```json
{
  "aampHost": "https://meshmail.ai",
  "rejectUnauthorized": false,
  "agents": [
    {
      "name": "claude",
      "acpCommand": "claude",
      "slug": "claude-bridge",
      "taskDispatchConcurrency": 10,
      "credentialsFile": "~/.aamp/acp-bridge/credentials/claude.json",
      "senderPolicies": [
        {
          "sender": "system@aamp.local",
          "dispatchContextRules": {
            "project_key": ["proj_123"]
          }
        }
      ]
    }
  ]
}
```

`senderPolicies` is optional, but omitted policies do not authorize anyone by default. Use QR pairing or configure at least one policy before sending `task.dispatch`; matching policies can also enforce exact-match `X-AAMP-Dispatch-Context` rules.
Legacy `senderWhitelist` configs still load and are normalized into `senderPolicies`.
When editing the `senderPoliciesFile` directly, `pairedAt` is optional; the bridge accepts manually added records with just `sender` and optional `dispatchContextRules`.
`credentialsFile` is optional. If omitted, the bridge uses `~/.aamp/acp-bridge/credentials/<agent>.json`.
`taskDispatchConcurrency` is optional and defaults to `10`. Agents default to
`executionLocation: "local"`; declare a remote Agent explicitly so its prompt
and artifact boundary are fail-closed.

### AIME

AIME is a remote agent and does not access the caller's local workspace. Use
the following conservative v0.1 binding so attachments are rejected before
the bridge materializes them locally:

```json
{
  "name": "aime",
  "acpCommand": "aime-acp",
  "executionLocation": "remote",
  "attachmentPolicy": "reject",
  "taskDispatchConcurrency": 1
}
```

This setting admits one AAMP dispatch at a time. Independently, `aime-acp`
enforces one active turn per remote session. AIME uses its own remote-native
Feishu/Lark capabilities and identity for requested reads; it does not receive
the caller's local workspace, `lark-cli` profile, OAuth state, credentials, or
shell environment. The local Feishu Bridge remains the only component that
writes the current Task's comments, status, and deliveries. Paste required text
into the task or provide an HTTP(S) URL that the remote agent can access.

Remote incoming attachments and local `file_delivery` are unsupported. Return
text or HTTP(S) links instead. `aamp-feishu-task-bridge` is deprecated and is
not an AIME implementation target. A successful AIME `auth` or `doctor` check
only proves adapter readiness; it does not prove access to a particular Feishu
group.

The opt-in packaged verification can be run from this package with:

```bash
npm run test:aime-packaged
```

It runs a real `npm pack` of the current `@tengchengwei/aime-acp` source version, installs that tarball with
`acpx@0.11.2` in a clean project, and exercises the installed executable
through the real `AcpxClient` and `AgentBridge`. AIME and AAMP are replaced
only at their external test boundaries with deterministic fakes. This is a
packaged generic-bridge proof, not live Feishu or live AIME acceptance.

### Hermes

Hermes exposes ACP through `hermes acp`, so its bridge config uses a raw ACP command:

```json
{
  "name": "hermes",
  "acpCommand": "hermes acp",
  "slug": "hermes-bridge"
}
```

`init --agent hermes` writes this command automatically when Hermes is installed.

### Trae CLI Next（内部版）

Trae CLI Next（内部版） exposes a native ACP server. Sign in first, then initialize the canonical `traex` agent:

```bash
traex login
npx aamp-acp-bridge init --agent traex
```

The generated config uses the native command:

```json
{
  "name": "traex",
  "acpCommand": "traex acp serve",
  "slug": "traex-bridge"
}
```

ACP Bridge does not auto-discover the legacy `trae` or `coco` names. TraeCode
CLI is the separate canonical `traecli` identity documented below. Existing
explicit configurations remain usable because their `acpCommand` is preserved
verbatim.

The default deliberately omits `--yolo`. ACP Bridge already auto-approves ACP permission requests through `acpx`, while Trae's `--yolo` also disables sandboxing. Only add `--yolo` through an explicit custom `acpCommand` when the surrounding environment provides an external sandbox.

### TraeCode CLI

The external TraeCode CLI exposes native ACP through `traecli acp serve`:

```bash
npx aamp-acp-bridge init --agent traecli
```

The generated agent entry uses canonical name `traecli` and command
`traecli acp serve`. ACP Bridge does not update TraeCode CLI or inspect its
login/model state; prepare the client before starting the bridge. The generated
command omits `--yolo`.

### WorkBuddy

On macOS, the bridge detects WorkBuddy only at:

```text
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

`init --agent workbuddy` uses the embedded ACP entrypoint:

```text
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy --acp
```

Open WorkBuddy and sign in before starting the bridge so the embedded CLI can
reuse its local authentication state. At startup, the bridge creates and closes
a temporary ACP session to verify that WorkBuddy is ready; no model prompt is
sent. If WorkBuddy is signed out, that agent fails startup with an actionable
login message instead of being reported as ready. Automatic WorkBuddy detection
is limited to this standard macOS installation; use an explicit `acpCommand` for
another platform or installation path.

### WorkBuddy AI

The international macOS application is a separate canonical Agent:

```text
workbuddy_ai
```

It is detected only at:

```text
/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

`init --agent workbuddy_ai` uses:

```text
'/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy' --acp
```

WorkBuddy and WorkBuddy AI are discovered independently and may both be
configured. Open WorkBuddy AI and sign in before starting its bridge.
