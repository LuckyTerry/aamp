# aamp-feishu-bridge

Local bridge daemon for connecting a user-owned Feishu bot to a target AAMP
Agent.

## Usage

```bash
npm install
npm run build

node dist/index.js init \
  --aamp-host https://meshmail.ai \
  --target-agent agent@meshmail.ai \
  --app-id cli_xxx \
  --app-secret xxx
```

You can also let the bridge use `lark-cli` to create a Feishu app before
initializing the bridge:

```bash
node dist/index.js init \
  --aamp-host https://meshmail.ai \
  --target-agent agent@meshmail.ai \
  --feishu-cli-new
```

Add `--feishu-cli-open` in desktop or other non-interactive clients to open the
setup URL in the browser as soon as `lark-cli` prints it.

For an existing `lark-cli` profile, use `--use-feishu-cli` and optionally
`--feishu-cli-profile NAME`. CLI-auth configs store the profile name, not the
App Secret; runtime event listening and Feishu API calls execute through
`lark-cli` using that profile.

`init` writes the Agent-specific config under
`~/.aamp/feishu-bridge/instances/<agent>/` and starts the local bridge
immediately. Use `--no-start` when you only want to write the config. `start`
and `run` load every configured instance, so one bridge process can host
multiple Feishu bots for multiple target Agents. Older single
`~/.aamp/feishu-bridge/config.json` configs are still detected.

Desktop and other non-interactive clients can use JSON output:

```bash
node dist/index.js init --json --no-start \
  --target-agent agent@meshmail.ai \
  --app-id cli_xxx \
  --app-secret xxx
node dist/index.js status --json
node dist/index.js start --json
```

If the target Agent prints a pairing URL, initialize and authorize the bridge in
one step:

```bash
node dist/index.js init \
  --pairing-url "aamp://connect?mailbox=agent@meshmail.ai&pair_code=abc123" \
  --app-id cli_xxx \
  --app-secret xxx
```

The bridge sends `pair.request` from its own AAMP mailbox with a Feishu source
rule and the current app owner's `open_id` (
`dispatchContextRules.sender_open_id`). The target Agent writes both rules into
the paired sender policy, so future Feishu IM dispatches are restricted to the
app owner. The owner is resolved from the Feishu application information API
using the configured Bot credentials; if the owner cannot be resolved, pairing
fails closed and no unrestricted `pair.request` is sent. The Agent replies with
`pair.respond` to indicate success or a failure reason.

## Remote AIME target

All Agents are local by default. AIME is the explicit remote exception: its
Agent configuration uses `executionLocation: "remote"` and rejects incoming
attachments. AIME reads requested Feishu/Lark data with its own remote-native
capabilities and identity; it does not require a local `lark-cli` profile or
user OAuth. The local Feishu Bridge still owns Bot App credentials and is the
only component that writes the current Task's comment, status, or delivery.

Remote attachments and local file delivery are unsupported. Use text or
HTTP(S) links for remote results. `aamp-feishu-task-bridge` is deprecated and
is not an implementation target. AIME `auth` or `doctor` readiness does not
establish authorization to read a particular group.

## Controlled Task feedback (pending Task OpenAPI publication)

The controlled START/STOP event flow reports command acceptance and execution
state through two Task OpenAPI routes. The combined `--enable-task` setup fills
new and previously unconfigured Task instances with the proposed Task v2 paths;
existing explicit paths take precedence. Standalone bridge instances still
require both `feishu.controlledFeedback.commandResultPath` and
`feishu.controlledFeedback.executionStatePath` in `config.json`. Each value
must be the exact root-relative path under `/open-apis/task/v2/` returned by
the gateway; URLs, query strings and partial configuration are rejected.
These defaults come from draft API Meta and must not be published until the
routes and Bot app authorization are verified end to end.

The bridge sends both requests with its existing Feishu Bot app credentials,
domain and environment headers. Older task events continue to work when these
paths are absent. A controlled START without both paths is rejected before
dispatch to AAMP. HTTP and nonzero Task API errors are not treated as a
successful report. The gateway route, scope, and authenticated app identity
still require real end-to-end verification before controlled execution can be
used in production.
