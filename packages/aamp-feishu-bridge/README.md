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

The bridge sends `pair.request` from its own AAMP mailbox with
`dispatchContextRules={ "source": ["feishu"] }`, so the Agent can accept future
Feishu dispatches without manual sender policy editing. The Agent replies with
`pair.respond` to indicate success or a failure reason.
